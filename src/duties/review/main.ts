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
import { join } from "node:path";

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
import { writeRunSummary } from "../../core/summary.js";
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
import {
  decodeEnvelope,
  findMarked,
  postOrReplace,
  rehearse,
  type Posted,
  type Publication,
} from "./publish.js";
import { classify, listPrFiles, readPr, type PrApi } from "./pr.js";
import { preflight, readRules } from "./rules.js";
import { NOTHING, review as askModel, type Reviewed } from "./verdict.js";
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
  /** The event that triggered this run — `pr` reviews drafts, `prod` reviews everything. */
  readonly trigger: string;
  /** The diff chars a single file may contribute before being skipped as capped — `none` means no bound. */
  readonly maxDiffChars: number | null;
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
    trigger: core.getInput("trigger"),
    maxDiffChars: bounded("max-diff-chars", core.getInput("max-diff-chars")),
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
  /** What the diff showed the model, for the summary's coverage table. */
  readonly shown: readonly { path: string }[];
  readonly skipped: readonly { path: string; reason: string }[];
  /** What the warrant actually granted — the summary reports it beside every other decision. */
  readonly permitted: readonly Capability[];
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
    | "shown"
    | "skipped"
  >
>;

/** The rules file's path in the checkout, absolute, resolved from the workspace. */
function resolveRulesPath(settings: Settings): string {
  const workspace = process.env.GITHUB_WORKSPACE ?? "";
  if (settings.rulesPath.length === 0) return join(workspace, ".github", "reeve-rules.yml");
  return join(workspace, settings.rulesPath);
}

/** The rules file as a reader of the summary will name it. */
function rulesLabel(settings: Settings): string {
  return settings.rulesPath.length === 0 ? ".github/reeve-rules.yml" : settings.rulesPath;
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
    shown: [],
    skipped: [],
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

  const rules = await readRules(resolveRulesPath(settings));
  for (const warning of rules.warnings) core.warning(`rules: ${warning}`);

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
  // from its own marker's envelope, or empty on the first review.
  const previous = await readEnvelope(api, at);
  if (previous.findings.length > 0) {
    core.info(
      `#${String(at.number)}: previous review read (${String(previous.findings.length)} finding(s)).`,
    );
  }

  // The deterministic half. `preflight` fires on the bounded diff before any
  // model is asked; its findings are guaranteed by construction (a line the
  // patch contains), which is why they enter the finding pool with the same
  // lifecycle as everything else.
  const deterministic: Finding[] = preflight(bounded, rules).map((entry) => ({
    id: entry.id,
    ruleId: entry.id,
    ruleName: entry.kind === "blocked" ? "Blocked text" : "Generated file",
    ruleBody: entry.body,
    path: entry.path,
    line: entry.line,
    severity: entry.severity,
    body: entry.body,
    marker: entry.marker,
  }));

  // The expensive half, only when there is a diff to ask about.
  let reviewed: Reviewed = { verdict: NOTHING, failures: [], unreadable: null, model: null };
  if (bounded.shown.length > 0) {
    reviewed = await askModel({
      provider: stages.review,
      models: settings.models,
      prTitle: pr.title,
      prBody: pr.body.slice(0, BODY_EXCERPT),
      headSha: pr.headSha,
      files: bounded.shown,
      rules: rules.rules,
      language: language?.code ?? null,
      weather,
    });
    for (const failure of reviewed.failures) {
      core.warning(`review: ${shown(settings.modelNames, failure.model)} — ${failure.reason}`);
    }
    if (reviewed.unreadable !== null) {
      core.warning(
        "review: the model's answer did not parse as findings — discarded rather than read best-effort.",
      );
    }
  }

  const raw: Finding[] = reviewed.verdict.findings
    .map((entry: RawFinding) => toFinding(entry, rules))
    .filter((finding): finding is Finding => finding !== null);

  // Merge deterministic + model findings, reconcile against the memory once.
  const final = reconcile([...deterministic, ...raw], previous);
  const confidence = reviewed.verdict.confidence;

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
  const verdictMeasured = reviewed.model !== null && reviewed.unreadable === null;
  const belowFloor = verdictMeasured && confidence < settings.confidence;
  // An all-clear no model stood behind. The diff had files to show and the
  // model that was asked never delivered a readable verdict — a capacity
  // failure, or an injection-shaped answer. Posting the empty chrome then
  // would print "No issues to report" about a diff nobody actually reviewed,
  // which is precisely the false all-clear an injected pull request is best
  // served by. Withhold instead; the job summary still says what happened.
  const silentNoVerdict = bounded.shown.length > 0 && !verdictMeasured && final.length === 0;
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

  if (!permitted.includes("comment")) {
    core.warning(
      `#${String(at.number)}: \`comment\` is not granted, so this run's review was not posted.`,
    );
    return settled({
      ...settledBase,
      language: language?.code ?? null,
      findings: final,
      confidence,
      malformedAnswers: reviewed.unreadable === null ? 0 : 1,
      rulesPath: rulesLabel(settings),
      shown: bounded.shown,
      skipped: bounded.skipped,
    });
  }

  if (belowFloor) {
    core.info(
      `#${String(at.number)}: review confidence ${confidence.toFixed(2)} is below the ` +
        `${settings.confidence.toFixed(2)} floor, so this run's review was not posted.`,
    );
    return settled({
      ...settledBase,
      language: language?.code ?? null,
      findings: final,
      confidence,
      malformedAnswers: reviewed.unreadable === null ? 0 : 1,
      rulesPath: rulesLabel(settings),
      shown: bounded.shown,
      skipped: bounded.skipped,
    });
  }

  if (silentNoVerdict) {
    core.info(
      `#${String(at.number)}: no readable verdict and no deterministic findings — ` +
        "nothing was posted, so a diff nobody reviewed is not stamped all-clear.",
    );
    return settled({
      ...settledBase,
      language: language?.code ?? null,
      findings: final,
      confidence,
      malformedAnswers: reviewed.unreadable === null ? 0 : 1,
      rulesPath: rulesLabel(settings),
      shown: bounded.shown,
      skipped: bounded.skipped,
    });
  }

  if (allShownIgnored) {
    core.warning(
      `#${String(at.number)}: every file was skipped by the rules file's \`ignore:\` list — ` +
        "nothing was posted, so a diff nothing was shown of is not stamped all-clear. " +
        "The coverage table names each file and why.",
    );
    return settled({
      ...settledBase,
      language: language?.code ?? null,
      findings: final,
      confidence,
      malformedAnswers: 0,
      rulesPath: rulesLabel(settings),
      shown: bounded.shown,
      skipped: bounded.skipped,
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
    return settled({
      ...settledBase,
      language: language?.code ?? null,
      findings: final,
      confidence,
      // `commented` is false on a dry run — nothing was written — and the
      // verdict table says the same ("nothing to post") beside the header
      // that already announces the run wrote nothing. The rehearsal's
      // disposition stays in the log.
      posted: null,
      malformedAnswers: reviewed.unreadable === null ? 0 : 1,
      rulesPath: rulesLabel(settings),
      shown: bounded.shown,
      skipped: bounded.skipped,
    });
  }

  const posted = await postOrReplace(api, at, publication);
  core.info(`#${String(at.number)}: review comment ${posted}.`);
  return settled({
    ...settledBase,
    language: language?.code ?? null,
    findings: final,
    confidence,
    posted,
    malformedAnswers: reviewed.unreadable === null ? 0 : 1,
    rulesPath: rulesLabel(settings),
    shown: bounded.shown,
    skipped: bounded.skipped,
  });
}

/** A real Octokit client satisfies the structural `PrApi` port directly. */
function wrapPr(api: ReturnType<typeof getOctokit>): PrApi {
  return api;
}

/** Reads the previous run's memory: the envelope on this run's own comment, or none. */
async function readEnvelope(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
): Promise<Previous> {
  const { marked } = await findMarked(api, at);
  const payload = marked?.payload ?? null;
  if (payload === null) return { findings: [], reviewedShas: [] };
  return decodeEnvelope(payload) ?? { findings: [], reviewedShas: [] };
}

/** A claim the model made, admitted as a finding when the diff proved it — see `verdict.ts`. */
function toFinding(
  raw: RawFinding,
  rules: { readonly rules: readonly { readonly id: string }[] },
): Finding | null {
  const rule = rules.rules.find((entry) => entry.id === raw.rule);
  return {
    id: `${raw.rule}:${raw.path}:${String(raw.line ?? 0)}`,
    ruleId: raw.rule,
    ruleName: rule?.id ?? raw.rule,
    ruleBody: "",
    path: raw.path,
    line: raw.line,
    severity: raw.severity,
    body: raw.body,
    marker: "",
  };
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
}

function page(
  settings: Settings,
  authority: Authority,
  outcome: Outcome | null,
  ungranted: string | null,
  spent: Run["spent"],
): string {
  return summarize({
    number: settings.number,
    dryRun: settings.dryRun,
    headSha: outcome?.headSha ?? "",
    note: outcome?.note ?? null,
    previousSha: "",
    shown: outcome?.shown ?? [],
    skipped: outcome?.skipped ?? [],
    findings: outcome?.findings ?? [],
    confidence: outcome?.confidence ?? null,
    posted: outcome?.posted ?? null,
    permitted: [],
    spent,
    modelNames: settings.modelNames,
    language: outcome?.language ?? null,
    warrant: settings.warrant,
    implicit: authority.implicit,
    ungranted,
    malformedAnswers: outcome?.malformedAnswers ?? 0,
    readRules: outcome?.rulesPath ?? null,
  });
}

await run();
