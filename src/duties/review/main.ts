/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * A code review is the top rung — a model's finding printed on a pull request
 * reads, to everyone downstream, as though somebody from the project reviewed
 * it. That is the whole reason its defaults are the strictest in this
 * repository (see `capabilities.ts`) and the reason the review comment is the
 * *only* thing this duty may ever write: no source edits, no feature
 * implementation, no autonomous motion. Review comments and threads only, and
 * only where the warrant grants `comment` and a pull request was named.
 *
 * The order:
 *
 *   1. Read the warrant, or build the implicit one, exactly as every other
 *      duty does. A `duties:` block that does not name `review` is checked
 *      here, once, before a single request — the summary says why, and the
 *      run is green.
 *   2. Read the pull request — standing, file list, patches. A closed or
 *      merged PR, or Reeve's own proposal PR, stops clean.
 *   3. Read the repository's rules file from the checkout (see `rules.ts`)
 *      and run the deterministic pre-checks over the diff.
 *   4. Reconcile against the previous run's findings, read from the owned
 *      comment's envelope — the memory that keeps this review from repeating
 *      itself (see `findings.ts`).
 *   5. Detect the diff's language, ask the model for new findings, and add
 *      to the review only what the patch can prove (see `verdict.ts`).
 *   6. Post exactly one comment — unless the warrant never granted `comment`,
 *      or `dry-run` withholds it.
 *
 * This file is excluded from coverage because it calls `run()` at import; it
 * is exercised by driving the built bundle against a stub API — see
 * `main.integration.test.ts`.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { join, resolve } from "node:path";

import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import { isReeveProposalPr } from "../../core/marker.js";
import { createMeter } from "../../core/meter.js";
import {
  assembleClient,
  createWeather,
  settleAuth,
  shown,
  starved,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { failIfProtocolExhausted, writeRunSummary } from "../../core/summary.js";
import {
  dutyLanguages,
  openAuthority,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";
import { bounded, readCore, threadNumber, type Core } from "../../core/inputs.js";
import { type Language, parseLanguages } from "../../core/languages.js";

import { DEFAULT_CAPABILITIES } from "./capabilities.js";
import {
  reconcile,
  remember,
  type Finding,
  type Previous,
  type RawFinding,
  type Reconciled,
} from "./findings.js";
import { architectureFindings } from "./architecture.js";
import {
  decodeEnvelope,
  postOrReplace,
  readThread,
  rehearse,
  type Posted,
  type Publication,
  type ThreadRead,
} from "./publish.js";
import {
  collectContext,
  fsSource,
  type Budget,
  type Context,
  type ContextTarget,
} from "./context.js";
import {
  mergeDispositions,
  readDispositions,
  substantiatedDispositions,
  dispositionKey,
} from "./disposition.js";
import { classify, listPrFiles, readPr, type PrApi } from "./pr.js";
import {
  assessRisk,
  describeRisk,
  readRiskProfile,
  type RiskAssessment,
  type RiskTier,
} from "./risk.js";
import { preflight, readPackedRules } from "./rules.js";
import {
  adversarialPass,
  correctnessPass,
  runPasses,
  secondOpinionPass,
  synthesize,
  type PassContext,
  type PassReport,
  type PassResult,
  type ReviewFinding,
  type ReviewPass,
  type ReviewSynthesis,
} from "./passes.js";
import { verifyFindings } from "./verify.js";
import { dryRunThreads, syncThreads, type ThreadSync } from "./threads.js";
import { discoverTests, gapFindings, testEvidence, type GapFinding } from "./testmap.js";
import { summarize, type Run } from "./summary.js";

/** The languages this run reads when the warrant's `languages:` key is silent. */
const DEFAULT_LANGUAGES = parseLanguages("en, vi, zh");
/** How much of the PR body reaches the model — the diff is the review, not a second copy of the body. */
const BODY_EXCERPT = 4000;

interface Settings extends Core {
  readonly number: number;
  readonly languages: readonly Language[];
  readonly warrant: string;
  /** Repo-relative path to the repository rules file in the checkout. */
  readonly rulesPath: string;
  /** Repo-relative path to the rule packs directory in the checkout. */
  readonly packsPath: string;
  /** Repo-relative path to the repository risk profile in the checkout. */
  readonly riskPath: string;
  /** The event that triggered this run — `pr` reviews drafts, `prod` reviews everything. */
  readonly trigger: string;
  /** The diff chars a single file may contribute before being skipped as capped — `none` means no bound. */
  readonly maxDiffChars: number | null;
  /**
   * The whole-run budget of assembled repository context (symbols, imports,
   * tests, config, surrounding source, callers, history) one review may carry
   * to the model, in characters — `none` means no bound.
   */
  readonly maxContextChars: number | null;
  /** The confidence at which a finding is reported — kept below in training only. */
  readonly confidence: number;
}

/** Reads the inputs exactly as `action.yml` declares them — the contract test audits this file. */
function readSettings(): Omit<Settings, "languages"> {
  const base = readCore();
  return {
    ...base,
    number: threadNumber(),
    warrant: core.getInput("warrant", { required: true }),
    rulesPath: core.getInput("rules-path"),
    packsPath: core.getInput("packs-path"),
    riskPath: core.getInput("risk-path"),
    trigger: core.getInput("trigger"),
    maxDiffChars: bounded("max-diff-chars", core.getInput("max-diff-chars")),
    maxContextChars: bounded("max-context-chars", core.getInput("max-context-chars")),
    confidence: parseConfidence(core.getInput("confidence")),
  };
}

function parseConfidence(raw: string): number {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`confidence: expected a number between 0 and 1, got \`${raw}\`.`);
  }
  return value;
}

const STAGE_PURPOSES = ["review", "detect"] as const;
type Stages = Record<(typeof STAGE_PURPOSES)[number], Provider>;

/** What one run decided, before it is turned into outputs or a summary page. */
interface Outcome {
  /** Why this run stopped before a verdict. `null` once it reached one. */
  readonly note: string | null;
  readonly language: string | null;
  readonly findings: readonly Reconciled[];
  readonly confidence: number | null;
  readonly posted: Posted | null;
  readonly headSha: string;
  readonly malformedAnswers: number;
  readonly rulesPath: string | null;
  /** The risk assessment, when the run reached one — `null` on early stops. */
  readonly risk: RiskAssessment | null;
  /** How many workspace reads the context engine made, for the summary's Context row. */
  readonly contextReadFiles: number;
  /** What the inline-thread sync did — for the page's "Threads" row. */
  readonly threads: ThreadSync | null;
  /** A short summary line for the page: test file count and gap findings, or null when the section is off/unavailable. */
  readonly readTests: string | null;
  /** What this run's comment memory carried in — for the page's "reviewed at" row. */
  readonly previous: Previous | null;
  /** Why the comment memory was unreadable — set when corruption was found and recovered from, never silent. */
  readonly memoryNote: string | null;
  /** What the diff showed the model, for the summary's coverage table. */
  readonly shown: readonly { path: string }[];
  readonly skipped: readonly { path: string; reason: string }[];
  /** What the warrant actually granted — the summary reports it beside every other decision. */
  readonly permitted: readonly Capability[];
  /** One row per model pass that ran, for the summary's verdict table. */
  readonly passes: readonly PassReport[];
}

type Settled = Partial<
  Pick<
    Outcome,
    | "note"
    | "language"
    | "findings"
    | "confidence"
    | "posted"
    | "headSha"
    | "malformedAnswers"
    | "rulesPath"
    | "risk"
    | "contextReadFiles"
    | "threads"
    | "readTests"
    | "previous"
    | "memoryNote"
    | "shown"
    | "skipped"
    | "passes"
  >
>;

/** The rules file's path in the checkout, absolute, resolved from the workspace. */
function resolveRulesPath(settings: Settings): string {
  const workspace = process.env.GITHUB_WORKSPACE ?? "";
  // `resolve` honours an absolute `rules-path` instead of gluing it onto the
  // workspace (which a runner that sets `GITHUB_WORKSPACE` and an absolute
  // path would otherwise concatenate into a path that cannot exist).
  return resolve(
    workspace,
    settings.rulesPath.length === 0 ? ".github/reeve-rules.yml" : settings.rulesPath,
  );
}

/** The rule packs directory's path in the checkout, absolute, resolved from the workspace. */
function resolvePacksPath(settings: Settings): string {
  const workspace = process.env.GITHUB_WORKSPACE ?? "";
  if (settings.packsPath.length === 0) return join(workspace, ".github", "reeve-packs");
  return join(workspace, settings.packsPath);
}

/** The rules file as a reader of the summary will name it. */
function rulesLabel(settings: Settings): string {
  return settings.rulesPath.length === 0 ? ".github/reeve-rules.yml" : settings.rulesPath;
}

/** The risk profile's path in the checkout, absolute, resolved from the workspace. */
function resolveRiskPath(settings: Settings): string {
  const workspace = process.env.GITHUB_WORKSPACE ?? "";
  if (settings.riskPath.length === 0) return join(workspace, ".github", "reeve-risk.yml");
  return join(workspace, settings.riskPath);
}

/** The risk profile as a reader of the summary will name it. */
function riskLabel(settings: Settings): string {
  return settings.riskPath.length === 0 ? ".github/reeve-risk.yml" : settings.riskPath;
}

/**
 * The bounds one context run spends. The whole-run total is the only input;
 * the per-section ceilings are the engine's own constants — a repository
 * cannot widen them, only this file can.
 */
function contextBudget(maxContextChars: number | null): Budget {
  return {
    total: maxContextChars ?? Number.MAX_SAFE_INTEGER,
    perFileSourceExcerpt: 800,
    importsWindow: 60,
    maxChangedFiles: 25,
    maxFilesScannedPerDirectory: 100,
    maxCallsitesPerSymbol: 10,
    maxMatchesPerSymbol: 10,
    maxSymbolsPerFile: 15,
    maxRelatedTestsPerChangedFile: 8,
    maxConfigFiles: 3,
    maxHistoryChars: 800,
    maxFileChars: 64 * 1024,
  };
}

/**
 * The pass roster a risk tier prices, threaded with every earlier pass's
 * findings. Low-risk diffs are read once; medium-risk ones get an independent
 * second opinion; high-risk ones add an adversarial verification pass told to
 * attack the earlier findings before reporting any again (see `passes.ts`).
 * Depth only: capability still comes from the warrant, never from the tier.
 */
function planPasses(tier: RiskTier, prior: readonly RawFinding[]): readonly ReviewPass[] {
  switch (tier) {
    case "high":
      return [correctnessPass(), secondOpinionPass(), adversarialPass(prior)];
    case "medium":
      return [correctnessPass(), secondOpinionPass()];
    default:
      return [correctnessPass()];
  }
}

async function decide(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
  warrant: Warrant,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<Outcome> {
  const permitted = warrant.granted("review", DEFAULT_CAPABILITIES);
  const settled = (over: Settled = {}): Outcome => ({
    note: null,
    language: null,
    findings: [],
    confidence: null,
    posted: null,
    headSha: "",
    malformedAnswers: 0,
    rulesPath: null,
    risk: null,
    contextReadFiles: 0,
    threads: null,
    readTests: null,
    previous: null,
    memoryNote: null,
    shown: [],
    skipped: [],
    passes: [],
    permitted,
    ...over,
  });

  const prApi = wrapPr(api);
  const pr = await readPr(prApi, at);
  const settledBase: Settled = { headSha: pr.headSha };

  if (isReeveProposalPr({ isPullRequest: true, body: pr.body })) {
    return settled({
      ...settledBase,
      note: "This is Reeve's own proposal pull request — every duty skips it, review included.",
    });
  }
  if (pr.merged) {
    return settled({
      ...settledBase,
      note: "This pull request is already merged — nothing left to review.",
    });
  }
  if (pr.state === "closed") {
    return settled({
      ...settledBase,
      note: "This pull request is closed — nothing left to review.",
    });
  }
  if (pr.draft) {
    // `prod` also reviews drafts — a draft is still a diff a maintainer asked
    // to have reviewed. `pr`, the default, waits for ready-for-review: a draft
    // that is explicitly still being worked on is exactly the false-positive
    // source a code review duty must not be.
    if (settings.trigger !== "prod") {
      return settled({
        ...settledBase,
        note:
          "This pull request is a draft. The review runs on ready-for-review and synchronize events, " +
          "and a draft is not ready for review — re-run when the draft is marked ready.",
      });
    }
  }

  // The diff bound: `none` (from `bounded`) means no cap at all, which the
  // classifier spells as an effectively infinite budget rather than a second
  // shape of its bounds type.
  const budget = settings.maxDiffChars ?? Number.MAX_SAFE_INTEGER;
  const snapshot = classify(await listPrFiles(prApi, at), {
    ignoreFiles: [],
    ignorePaths: [],
    generatedExtensions: DEFAULT_GENERATED,
    maxDiffChars: budget,
  });

  const rules = await readPackedRules(resolveRulesPath(settings), resolvePacksPath(settings));
  for (const warning of rules.warnings) core.warning(`rules: ${warning}`);

  // The risk tier, priced deterministically before any model is asked — it
  // decides how many passes the review runs, and nothing else. Depth only:
  // capability still comes from the warrant (see `risk.ts`'s doc comment).
  const riskProfile = await readRiskProfile(resolveRiskPath(settings));
  for (const warning of riskProfile.warnings) core.warning(`risk: ${warning}`);
  const risk = assessRisk(snapshot.allFiles, rules, riskProfile);
  core.info(
    `#${String(at.number)}: risk ${risk.tier} — ${describeRisk(risk)} (${riskLabel(settings)}).`,
  );

  // The snapshot, bounded by the repository's own rules — the diff the model
  // will actually see, plus the honest list of what it will not.
  const bounded = classify(snapshot.allFiles, {
    ignoreFiles: rules.ignoreFiles,
    ignorePaths: rules.ignorePaths,
    generatedExtensions: rules.generatedExtensions,
    maxDiffChars: budget,
  });

  const detection = await detectLanguage(
    pr.title.length === 0 ? pr.body : pr.title,
    settings.languages,
    createLanguagePicker(stages.detect, settings.models, weather),
  );
  const language = detection.language;
  core.info(
    language === null
      ? `#${String(at.number)}: language not identified (${String(detection.candidates.length)} candidate(s)).`
      : `#${String(at.number)}: language ${language.code} (by ${detection.by}).`,
  );

  // The memory half: what the previous run's comment left this run — read
  // from its own marker's envelope, or empty on the first review. The thread is
  // read ONCE here: its replies are what dispositions are derived from, and
  // re-reading it later (as the write classifier once did) would spend a
  // second walk. A corrupted envelope is recovered from loudly — machine
  // statuses reset, dispositions are re-derived from the thread, and the job
  // summary carries a note that names the corruption.
  const { previous, thread, memoryNote } = await readEnvelope(api, at);
  if (previous.findings.length > 0) {
    core.info(
      `#${String(at.number)}: previous review read (${String(previous.findings.length)} finding(s)).`,
    );
  }

  // The human-disposition axis: maintainer triage read off the owned thread's
  // replies, matched against the previous run's findings (the ones a human
  // could have replied to). Fresh dispositions from eligible replies win;
  // envelope-stored dispositions survive only when the reply that made them is
  // still there and still from the same login (the forged-envelope defence).
  const fresh = readDispositions(thread.replies, previous.findings, at, pr.author.login);
  const substantiated = substantiatedDispositions(
    previous.findings,
    thread.replies,
    pr.author.login,
  );
  const dispositions = mergeDispositions(fresh, substantiated);

  // The deterministic half. `preflight` fires on the bounded diff before any
  // model is asked; its findings are guaranteed by construction (a line the
  // patch contains), which is why they enter the finding pool with the same
  // lifecycle as everything else.

  // The test-aware half, opt-in via the rules file's `tests:` section. It never
  // runs code (D8) and never fabricates coverage (D5): an unavailable checkout
  // is "no evidence", so no gap finding is attributed to its absence.
  const testmap = await runTestmap(bounded, rules);
  const deterministic: Finding[] = [
    ...preflight(bounded, rules).map((entry) => ({
      id: entry.id,
      ruleId: entry.id,
      ruleName: entry.kind === "blocked" ? "Blocked text" : "Generated file",
      ruleBody: entry.body,
      path: entry.path,
      line: entry.line,
      severity: entry.severity,
      body: entry.body,
      marker: entry.marker,
    })),
    ...architectureFindings(bounded, rules).map((entry) => ({
      id: entry.id,
      ruleId: entry.id,
      ruleName: "Architecture boundary",
      ruleBody: entry.body,
      path: entry.path,
      line: entry.line,
      severity: entry.severity,
      body: entry.body,
      marker: entry.marker,
    })),
    ...testmap.findings.map((entry) => toTestFinding(entry)),
  ];

  // The context engine: the assembled, bounded, deterministic half that lives
  // beside the diff. Read from the workflow's own base-ref checkout — the same
  // trust tier as the rules file — and only when there is a diff to ask about
  // and a workspace to read from. It is evidence, never instructions; a finding
  // still has to be diff-proven (see `verdict.ts`'s `parseFinding`).
  const workspaceRoot = process.env.GITHUB_WORKSPACE ?? "";
  let context: Context = { sections: [], text: null, totalChars: 0, readFiles: 0 };
  if (bounded.shown.length > 0 && workspaceRoot.length > 0) {
    context = await collectContext(
      bounded.shown.map((file): ContextTarget => ({
        path: file.path,
        status: file.status,
        lines: file.lines,
        patch: file.patch,
      })),
      fsSource(workspaceRoot),
      contextBudget(settings.maxContextChars),
      resolveRulesPath(settings),
    );
    if (context.readFiles > 0) {
      core.info(`review: context engine read ${String(context.readFiles)} file(s).`);
    }
  }

  // The memory a later return's page will say "reviewed at" against — carried
  // on every outcome from here on, so the summary's "Previously" row names the
  // last SHA this thread was reviewed against, not the current one. Declared
  // after the context collection so the Context row of the summary can carry
  // how many workspace files the engine read this run.
  const withMemory: Settled = {
    previous,
    memoryNote,
    contextReadFiles: context.readFiles,
    ...settledBase,
  };

  // The expensive half, only when there is a diff to ask about. The risk tier
  // prices the roster — one pass on low, a second opinion on medium, an
  // adversarial verification pass on top for high — and each pass runs through
  // the same engine with its own prompt and the same strict parser. Every later
  // pass is threaded the earlier ones' findings (untrusted, from a model) inside
  // the same nonce fence as the diff. `synthesize` correlates what came back
  // after all steps: dedupes, annotates contradictions, ranks, and prices every
  // pass that could not answer into the confidence. The context enters every
  // pass's prompt behind the same fence as the diff.
  const passContext: PassContext = {
    prTitle: pr.title,
    prBody: pr.body.slice(0, BODY_EXCERPT),
    headSha: pr.headSha,
    files: bounded.shown,
    rules: rules.rules,
    language: language?.code ?? null,
    context,
    // The bounded TEST EVIDENCE block, only when the `tests:` section enabled
    // it and the checkout was readable — an empty block adds nothing.
    ...(testmap.evidence.length > 0 ? { tests: testmap.evidence } : {}),
  };
  const passResults: PassResult[] = [];
  if (bounded.shown.length > 0) {
    const prior: RawFinding[] = [];
    for (const pass of planPasses(risk.tier, prior)) {
      const results = await runPasses(stages.review, [pass], settings.models, passContext, weather);
      passResults.push(...results);
      // The next pass is told what the earlier ones found — adversarial ground,
      // and the same untrusted material every later pass should see.
      for (const result of results) {
        if (result.verdict !== null) prior.push(...result.verdict.findings);
      }
    }
  }
  for (const result of passResults) {
    for (const failure of result.failures) {
      core.warning(`review: ${shown(settings.modelNames, failure.model)} — ${failure.reason}`);
    }
  }
  const synthesis: ReviewSynthesis = synthesize(passResults);
  if (synthesis.failedPasses.length > 0) {
    core.warning(
      `review: ${synthesis.failedPasses
        .map((failed) => `the ${failed.id} pass ${failed.reason}`)
        .join("; ")}.`,
    );
  }
  // How many passes produced an answer that did not parse — the summary's
  // "Unreadable" row, one per pass rather than the old single answer.
  const unreadableCount = passResults.filter((result) => result.unreadable !== null).length;

  const raw: Finding[] = synthesis.findings.map((entry: ReviewFinding) => toFinding(entry, rules));

  // The evidence half: every admitted model finding is verified against
  // evidence the diff already proves — the claimed snippet against the
  // diff-proven line text, and the cited rule against the rules snapshot.
  // Deterministic preflight findings are not passed to the engine; they are
  // always-right by construction, so no claim of theirs needs proving.
  const verified = verifyFindings({
    findings: raw,
    shown: bounded.shown,
    rules,
    headSha: pr.headSha,
  });

  // Merge deterministic + model findings, reconcile against the memory once.
  // The diff standing is what makes the resolved rung honest: a finding is
  // resolved only when the diff moved past it (see findings.ts), never because
  // a model happened not to re-mention it on a reread of the same diff.
  const StandingFiles = new Map<string, ReadonlySet<number> | null>();
  for (const file of bounded.shown) StandingFiles.set(file.path, new Set(file.lines.keys()));
  for (const file of bounded.skipped) StandingFiles.set(file.path, null);
  const diffStanding = { files: StandingFiles, headSha: pr.headSha };
  const reconciled = reconcile([...deterministic, ...verified], previous, diffStanding);
  // Overlay the merged dispositions onto every reconciled entry by identity —
  // the intention key, not the fingerprint, so a disposition rides a finding
  // across line movement, force pushes and comment replacements. A fresh
  // disposition beats a substantiated mirror; the mirror fills the gaps.
  const final = reconciled.map((entry) => ({
    ...entry,
    disposition: dispositions.get(dispositionKey(entry.finding)) ?? entry.disposition ?? null,
  }));
  const confidence = synthesis.confidence;

  const next = remember(final, pr.headSha, previous);

  // The confidence floor, before the write. The model's findings are still
  // reconciled and reported (a maintainer tuning the floor against real diffs
  // needs to see them), but nothing below the floor reaches the pull request —
  // the same posture every other posting duty takes with its own floor.
  //
  // Only a measured verdict counts against it. `confidence` is 0 whenever no
  // model answered readably — an all-skipped diff, a capacity failure, an
  // unreadable answer — and the findings left standing then are the deterministic
  // pre-checks, which are certain by construction and need no confidence floor.
  const needsAdversarial = risk.tier === "high";
  const readablePassCount = passResults.filter((result) => result.verdict !== null).length;
  const adversarialIndex = passResults.findIndex((result) => result.pass.id === "adversarial");
  const adversarialReadable =
    !needsAdversarial ||
    (adversarialIndex !== -1 && passResults[adversarialIndex]?.verdict !== null);
  // A high-risk diff's all-clear is double-earned: at least two passes read it
  // readably, and the adversarial pass specifically read it readably. Fewer
  // than that is a review nobody can vouch for.
  const minReadable = needsAdversarial ? 2 : 1;
  const allClearEarned =
    readablePassCount >= minReadable && (!needsAdversarial || adversarialReadable);
  const verdictMeasured = allClearEarned;
  const belowFloor = verdictMeasured && confidence < settings.confidence;
  // An all-clear no model stood behind. The diff had files to show and the
  // model that was asked never delivered a readable verdict — a capacity
  // failure, or an injection-shaped answer. Posting the empty chrome then
  // would print "No issues to report" about a diff nobody actually reviewed,
  // which is precisely the false all-clear an injected pull request is best
  // served by. Withhold instead; the job summary still says what happened.
  const silentNoVerdict = bounded.shown.length > 0 && !allClearEarned && final.length === 0;
  // A diff whose every file the rules file's `ignore:` lists removed. The one
  // rules value that may not act alone: a stale or hostile `ignore.paths`
  // like `["**"]` would remove every file, and the empty chrome would then
  // stamp a diff nothing was shown of as clean (deterministic pre-checks fire
  // only on shown files, so nothing fires here). `generated` skips still post
  // the empty chrome — a generated-only PR is a real answer — and `capped`,
  // `removed` and `binary` are facts of the diff, not configuration. The job
  // summary's coverage table names every file and why; the write stays silent.
  const allShownIgnored =
    bounded.shown.length === 0 &&
    bounded.skipped.length > 0 &&
    bounded.skipped.every((entry) => entry.reason === "ignored");

  // A diff that was shown but never reviewed readably: when every pass's
  // roster failed with a protocol error — a decommissioned model id, a body
  // the provider rejected, a field it does not accept — that is a
  // configuration problem, not capacity weather, and a run that cannot do its
  // job must not stay green behind warnings (D5). `failIfProtocolExhausted`
  // draws the all-protocol vs all-capacity line itself, so capacity weather
  // keeps the green exit below; a pass that answered unreadably carries no
  // failures at all and is equally left green. The call must come before the
  // returns below so no path — comment denied, silent-no-verdict, dry run —
  // turns the red green.
  if (bounded.shown.length > 0 && readablePassCount === 0) {
    failIfProtocolExhausted(
      settings.models,
      passResults.flatMap((result) => result.failures),
      settings.modelNames,
    );
  }

  if (!permitted.includes("comment")) {
    core.warning(
      `#${String(at.number)}: \`comment\` is not granted, so this run's review was not posted.`,
    );
    return settled({
      ...withMemory,
      language: language?.code ?? null,
      findings: final,
      confidence,
      risk,
      malformedAnswers: unreadableCount,
      rulesPath: rulesLabel(settings),
      readTests: testmap.readTests,
      shown: bounded.shown,
      skipped: bounded.skipped,
      passes: synthesis.passes,
    });
  }

  if (belowFloor) {
    core.info(
      `#${String(at.number)}: review confidence ${confidence.toFixed(2)} is below the ` +
        `${settings.confidence.toFixed(2)} floor, so this run's review was not posted.`,
    );
    return settled({
      ...withMemory,
      language: language?.code ?? null,
      findings: final,
      confidence,
      risk,
      malformedAnswers: unreadableCount,
      rulesPath: rulesLabel(settings),
      readTests: testmap.readTests,
      shown: bounded.shown,
      skipped: bounded.skipped,
      passes: synthesis.passes,
    });
  }

  if (silentNoVerdict) {
    core.info(
      `#${String(at.number)}: no readable verdict and no deterministic findings — ` +
        "nothing was posted, so a diff nobody reviewed is not stamped all-clear.",
    );
    return settled({
      ...withMemory,
      language: language?.code ?? null,
      findings: final,
      confidence,
      risk,
      malformedAnswers: unreadableCount,
      rulesPath: rulesLabel(settings),
      readTests: testmap.readTests,
      shown: bounded.shown,
      skipped: bounded.skipped,
      passes: synthesis.passes,
    });
  }

  if (allShownIgnored) {
    core.warning(
      `#${String(at.number)}: every file was skipped by the rules file's \`ignore:\` list — ` +
        "nothing was posted, so a diff nothing was shown of is not stamped all-clear. " +
        "The coverage table names each file and why.",
    );
    return settled({
      ...withMemory,
      language: language?.code ?? null,
      findings: final,
      confidence,
      risk,
      malformedAnswers: 0,
      rulesPath: rulesLabel(settings),
      readTests: testmap.readTests,
      shown: bounded.shown,
      skipped: bounded.skipped,
      passes: synthesis.passes,
    });
  }

  const publication: Publication = {
    reconciled: final,
    next,
    headSha: pr.headSha,
  };

  if (settings.dryRun) {
    const would = await rehearse(api, at, publication);
    core.info(`Dry run — #${String(at.number)} would have received:\n${would}`);
    const rehearsal = await dryRunThreads(api, at, final, diffStanding);
    core.info(
      `Dry run — #${String(at.number)} thread sync would create ${String(rehearsal.created)} and update ${String(rehearsal.updated)}.`,
    );
    return settled({
      ...withMemory,
      language: language?.code ?? null,
      findings: final,
      confidence,
      // `commented` is false on a dry run — nothing was written — and the
      // verdict table says the same ("nothing to post") beside the header
      // that already announces the run wrote nothing. The rehearsal's
      // disposition stays in the log.
      posted: null,
      threads: rehearsal,
      risk,
      malformedAnswers: unreadableCount,
      rulesPath: rulesLabel(settings),
      readTests: testmap.readTests,
      shown: bounded.shown,
      skipped: bounded.skipped,
      passes: synthesis.passes,
    });
  }

  // Threads first, summary after: a thread-write permission failure throws
  // before the summary comment is written, so a rerun's relisting finds no
  // half-written state and never duplicates. A finding GitHub cannot anchor
  // (422) falls back to the summary — which renders every finding — so a
  // thread that did not anchor is never lost.
  const threads = await syncThreads(api, at, final, diffStanding, pr.headSha);
  if (threads.created > 0 || threads.updated > 0) {
    core.info(
      `#${String(at.number)}: ${String(threads.created)} thread(s) posted, ${String(threads.updated)} updated` +
        (threads.fallback.length > 0
          ? `, ${String(threads.fallback.length)} fell back to the summary`
          : "") +
        ".",
    );
  }
  if (threads.uncertain) {
    core.warning(
      `#${String(at.number)}: review threads could not be listed with certainty, so none were written this run.`,
    );
  }

  const posted = await postOrReplace(api, at, publication);
  core.info(`#${String(at.number)}: review comment ${posted}.`);
  return settled({
    ...withMemory,
    language: language?.code ?? null,
    findings: final,
    confidence,
    posted,
    threads,
    risk,
    malformedAnswers: unreadableCount,
    rulesPath: rulesLabel(settings),
    readTests: testmap.readTests,
    shown: bounded.shown,
    skipped: bounded.skipped,
    passes: synthesis.passes,
  });
}

/** A real Octokit client satisfies the structural `PrApi` port directly. */
function wrapPr(api: ReturnType<typeof getOctokit>): PrApi {
  return api;
}

/**
 * Reads the previous run's memory: the envelope on this run's own comment, and
 * the thread it sits in.
 *
 * The thread is read once, here. On a `corrupt` envelope the run recovers the
 * same way a cold start does — dispositions re-derive from the thread's
 * replies, machine statuses reset — but the corruption is carried out loudly:
 * a warning names the reason, and the returned `memoryNote` reaches the job
 * summary so the damage is never silent (D5).
 */
async function readEnvelope(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
): Promise<{ previous: Previous; thread: ThreadRead; memoryNote: string | null }> {
  const { marked, replies, uncertain } = await readThread(api, at);
  const payload = marked?.payload ?? null;
  if (payload === null) {
    const note =
      uncertain && marked === null
        ? "This run's comment could not be found with certainty — the write was withheld."
        : null;
    return {
      previous: { findings: [], reviewedShas: [] },
      thread: { marked, replies, uncertain },
      memoryNote: note,
    };
  }
  const decoded = decodeEnvelope(payload);
  if (decoded.kind === "ok") {
    return { previous: decoded.previous, thread: { marked, replies, uncertain }, memoryNote: null };
  }
  if (decoded.kind === "corrupt") {
    // Not always a checksum failure — a payload can also be unreadable base64,
    // a non-mapping, or a finding with a malformed field. The message names the
    // reason it was given rather than asserting a cause it does not know.
    const reason = `The review's stored memory could not be read and was rebuilt from the thread — ${decoded.reason}.`;
    core.warning(`#${String(at.number)}: ${reason}`);
    return {
      previous: { findings: [], reviewedShas: [] },
      thread: { marked, replies, uncertain },
      memoryNote: reason,
    };
  }
  return {
    previous: { findings: [], reviewedShas: [] },
    thread: { marked, replies, uncertain },
    memoryNote: null,
  };
}

/** A claim a pass made, admitted as a finding when the diff proved it — see `verdict.ts`. */
function toFinding(
  claim: ReviewFinding,
  rules: { readonly rules: readonly { readonly id: string }[] },
): Finding {
  const rule = rules.rules.find((entry) => entry.id === claim.ruleId);
  return {
    id: claim.id,
    ruleId: claim.ruleId,
    ruleName: rule?.id ?? claim.ruleId,
    ruleBody: "",
    path: claim.path,
    line: claim.line,
    severity: claim.severity,
    body: claim.body,
    marker: "",
    snippet: claim.snippet,
  };
}

/** A deterministic test-aware finding admitted into the finding pool. */
function toTestFinding(entry: GapFinding): Finding {
  const ruleName =
    entry.ruleId === "tests-map" ? "Changed code without test" : "Test changed without its code";
  return {
    id: `${entry.ruleId}:${entry.path}:0`,
    ruleId: entry.ruleId,
    ruleName,
    ruleBody: "",
    path: entry.path,
    line: null,
    severity: entry.severity,
    body: entry.body,
    marker: entry.marker,
  };
}

/** What the test-aware pass produced for this run, or null when it was off. */
interface TestmapRun {
  readonly findings: readonly GapFinding[];
  readonly evidence: string;
  /** A one-line note for the summary page — `null` when the pass was off or the checkout was unavailable. */
  readonly readTests: string | null;
}

/** NOTHING: the test-aware pass is off. */
const TESTMAP_OFF: TestmapRun = { findings: [], evidence: "", readTests: null };

/**
 * Runs the deterministic test-aware pass, when the rules file enabled it.
 *
 * The checkout is the base ref (see review.md's workflow example), so the
 * pull request head's code is never present and never executed (D8). An
 * unavailable checkout is "no evidence", so nothing is reported from it (D5).
 */
async function runTestmap(
  bounded: { readonly shown: readonly Parameters<typeof gapFindings>[0][number][] },
  rules: { readonly tests: Parameters<typeof gapFindings>[2] },
): Promise<TestmapRun> {
  if (!rules.tests.enabled) return TESTMAP_OFF;
  const discovery = await discoverTests(process.env.GITHUB_WORKSPACE ?? "");
  if (discovery.unavailable) {
    core.warning(
      "review: the tests: section is enabled but the checkout is unavailable — test evidence skipped.",
    );
    return { findings: [], evidence: "", readTests: null };
  }
  if (discovery.capped) {
    core.warning("review: test discovery hit a budget — evidence truncated.");
  }
  const findings = gapFindings(bounded.shown, discovery.tests, rules.tests);
  const evidence = testEvidence(bounded.shown, discovery.tests);
  const readTests = `${String(discovery.tests.length)} test file(s), ${String(findings.length)} gap finding(s)`;
  return { findings, evidence, readTests };
}

const DEFAULT_GENERATED = [".min.js", ".min.css", ".map"];

function notGranted(warrant: Warrant): string {
  return (
    `\`${warrant.path}\`'s \`duties:\` block does not name \`review\`; once that block exists ` +
    "it is the whole answer, so add `review: [comment]` to it to grant a review comment, or remove " +
    "the block to return to defaults, which is still nothing — see `DEFAULT_CAPABILITIES`."
  );
}

export async function run(): Promise<void> {
  const meter = createMeter();
  let weather = createWeather();
  let settings: Settings | null = null;
  let authority: Authority | null = null;
  let outcome: Outcome | null = null;
  let ungranted: string | null = null;

  try {
    const base = readSettings();
    const client = assembleClient(base, meter, STAGE_PURPOSES, []);
    weather = client.weather;
    const api = getOctokit(base.token);
    const stages: Stages = client.stages;

    const opened = await openAuthority(base.warrant, api, context.repo, "review");
    authority = opened.authority;

    const denied = opened.denied;
    const languages = dutyLanguages(authority.warrant, denied, DEFAULT_LANGUAGES);
    settings = { ...base, languages };

    if (denied) {
      ungranted = notGranted(authority.warrant);
    } else {
      const at: { owner: string; repo: string; number: number } = {
        ...context.repo,
        number: settings.number,
      };
      outcome = await decide(api, at, authority.warrant, settings, stages, weather);
    }

    settleAuth(weather);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (settings !== null && authority !== null) {
      const rosterStarved = starved(settings.models, weather);
      if (rosterStarved) {
        core.warning(
          "Every model in `models` failed on capacity this run — weather, not a broken configuration.",
        );
      }
      report(outcome, rosterStarved);
      await writeRunSummary(page(settings, authority, outcome, ungranted, meter.spent()), weather);
    }
  }
}

/** Every output, written on every path that reaches an answer — including "nothing". */
function report(outcome: Outcome | null, rosterStarved: boolean): void {
  core.setOutput(
    "commented",
    String(outcome?.posted === "posted" || outcome?.posted === "replaced"),
  );
  core.setOutput("note", outcome?.note ?? "");
  core.setOutput("head-sha", outcome?.headSha ?? "");
  core.setOutput("starved", String(rosterStarved));
  core.setOutput("findings", String(outcome?.findings.length ?? 0));
  core.setOutput("risk", outcome?.risk?.tier ?? "");
}

function page(
  settings: Settings,
  authority: Authority,
  outcome: Outcome | null,
  ungranted: string | null,
  spent: Run["spent"],
): string {
  // The previous head SHA the envelope carried — the last time this thread was
  // reviewed against a different diff than this one — or "" when the thread
  // has no history yet. The "Previously" row is only meaningful then.
  const previousSha = outcome?.previous?.reviewedShas.at(-1) ?? "";
  return summarize({
    number: settings.number,
    dryRun: settings.dryRun,
    headSha: outcome?.headSha ?? "",
    note: outcome?.note ?? null,
    memoryNote: outcome?.memoryNote ?? null,
    previousSha,
    shown: outcome?.shown ?? [],
    skipped: outcome?.skipped ?? [],
    findings: outcome?.findings ?? [],
    confidence: outcome?.confidence ?? null,
    posted: outcome?.posted ?? null,
    permitted: outcome?.permitted ?? [],
    spent,
    modelNames: settings.modelNames,
    language: outcome?.language ?? null,
    warrant: settings.warrant,
    implicit: authority.implicit,
    ungranted,
    malformedAnswers: outcome?.malformedAnswers ?? 0,
    readRules: outcome?.rulesPath ?? null,
    risk: outcome?.risk ?? null,
    passes: outcome?.passes ?? [],
    threads: outcome?.threads ?? null,
    contextReadFiles: outcome?.contextReadFiles ?? 0,
    readTests: outcome?.readTests ?? null,
  });
}

await run();
