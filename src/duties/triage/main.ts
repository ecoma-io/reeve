/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. Each decision it reaches for lives in a
 * module tested on its own — most of them in the core, shared with every other
 * duty — and the only judgement made here is the order they run in and what a
 * failure at each step means for the run:
 *
 *   1. **Read.** Parse the warrant — or, when it is simply absent at the
 *      default path, build the implicit one from this repository's own label
 *      descriptions — fetch the thread, and check that every name an explicit
 *      taxonomy claims is a label this repository actually has. A file that
 *      does not parse and a thread that cannot be read are both red, and both
 *      happen before a single request: a taxonomy naming a renamed label would
 *      otherwise look exactly like a model that agreed with nothing.
 *   1a. **Stop, for a block that said nothing about this duty.** A written
 *      `capabilities:` block that does not name `triage` grants it nothing,
 *      deliberately, and no verdict downstream can change that — so the run
 *      stops here, before the thread is even fetched, and says why. See the
 *      short-circuit below `readWarrant` for the full argument.
 *   2. **Screen, for nothing.** An empty body, a blank form, four words with no
 *      evidence in them. Most of a backlog stops here and it costs no requests.
 *   3. **Language.** Script, then profile, then — only if those did not decide —
 *      a model. The verdict prompt is told what it is reading rather than left
 *      to infer it.
 *   4. **Screen, cheaply.** Spam and off-topic, asked of `screen-models` when
 *      there are any. Fails open in every direction.
 *   5. **Recall.** The nearest maintainer corrections, as examples.
 *   6. **Triage.** One verdict, from the expensive roster, with the thread
 *      inside a boundary drawn for that call alone.
 *   7. **Verify.** In code, against the warrant file and the confidence floor.
 *      Never against the model's own account of what it was allowed to do.
 *   8. **Apply.** Only what the file and `apply` both permit.
 *
 * **The free screen runs before language detection**, which is the one place
 * this file departs from the order the documentation draws. Detection can reach
 * a model, and spending a request to identify the language of a body that is
 * about to be screened out for having no text in it is spending a request on
 * nothing. Nothing downstream depends on the difference: the screens that run
 * first are the ones that read length rather than meaning.
 *
 * **The failure mode of this duty is doing nothing.** Every model failing, a
 * verdict that does not parse, a verdict under the floor, a thread that was
 * screened out and a `capabilities:` block that does not name this duty are all
 * green runs that applied nothing and said why. Only a warrant that does not
 * parse — an absent file at a path a consumer chose is one of these, an absent
 * file at the default is not — and a thread that cannot be read are
 * `setFailed`, because both mean the run has no authority to act under.
 *
 * This file is excluded from coverage because it calls `run()` at import, so
 * measuring it would execute the action. It is exercised by driving the built
 * bundle against a stub API, which is what a runner does — see
 * `main.integration.test.ts`.
 *
 * What is left here is the order above, the two `Outcome`/`SweepAccumulator`
 * shapes every step of it reads and writes, and `run`/`runSweep`'s own
 * control flow — everything else has its own module, tested on its own:
 * `inputs.ts` (settings parsing, `readSettings` itself stays here — see its
 * doc comment for why), `store.ts` (the corrections store's write path),
 * `record.ts` (the `record` capability's trigger, gates and both write
 * paths), `outputs.ts` (every `core.setOutput` call and every summary page
 * this duty renders), `capabilities.ts` (the cheapest-reversible-action
 * default a missing warrant falls back to), `outcome.ts` (what Reeve's own
 * past actions on a thread were, for the S1/S3 signals recall needs),
 * `propose.ts` (the `propose` capability's workspace-drift pull requests),
 * `summary.ts` (the page `outputs.ts` renders onto), and `verdict.ts` (the
 * one stage that talks to a model, and the only one whose answer is treated
 * as a suggestion).
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { readAtlas, type AtlasApi } from "../../core/atlas.js";
import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import { enforceLabels, narrow, owners, parseApply, type Refusal } from "../../core/enforce.js";
import {
  createEffects,
  createRepositoryLabel,
  isCapacityError,
  listOpenThreads,
  listRepositoryLabels,
  readStanding,
  type ContentsApi,
  type Effects,
  type Location,
  type Standing,
  type TrackerApi,
} from "../../core/forge.js";
import { bounded, counted, fraction, readShared } from "../../core/inputs.js";
import { isReeveProposalPr } from "../../core/marker.js";
import { createMemory, readStore, type Correction, type WeightedQuery } from "../../core/memory.js";
import { createMeter } from "../../core/meter.js";
import { translateToPivot } from "../../core/pivot.js";
import {
  assembleClient,
  createWeather,
  parseModels,
  settleAuth,
  shown,
  starved,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { screen } from "../../core/screen.js";
import { sift } from "../../core/spam.js";
import { authSection, writeSummary } from "../../core/summary.js";
import {
  checkLabelsExist,
  readWarrant,
  resolveAbout,
  resolveAuthority,
  resolveLanguages,
  resolvePivot,
  type Authority,
  type Capability,
  type Label,
  type Warrant,
} from "../../core/warrant.js";

import { parseSweepState, resolveTaxonomy, taxonomyNames, type Settings } from "./inputs.js";
import { checkReversal, closeMarker, gateClose } from "./outcome.js";
import {
  describeRecordOutcome,
  labelChange,
  recordCorrection,
  recordGrantedByFile,
  recordGrantedByRun,
  recordReversal,
  recordTrigger,
  senderLogin,
  type RecordOutcome,
} from "./record.js";
import { repoRelativePath } from "./store.js";
import { type Done, type SweptThread } from "./summary.js";
import {
  NOTHING_DONE,
  page,
  recordPage,
  report,
  reportRecordRun,
  reportSweep,
  sweepPage,
} from "./outputs.js";
import {
  report as buildProposeReport,
  proposeSection,
  runPropose,
  type ProposalsApi,
  type ProposeReport,
} from "./propose.js";
import { NOTHING, triage, type Verdict } from "./verdict.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";

/**
 * `warrant`'s own default in `action.yml`, repeated here rather than read back
 * out of it.
 *
 * `readWarrant` has to be told which path is the default so it can tell a
 * consumer's silence from a consumer's choice — see `ReadOptions` — and this
 * is the one value in that comparison this file is actually responsible for.
 * A workflow that renamed `.github/reeve.yml` to somewhere else set `warrant`
 * to say so, which is exactly the case this constant is not meant to catch.
 */
const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

/**
 * How many corrections reach the prompt, when the warrant's `memory:` block
 * never wrote a `recall` of its own.
 *
 * Not an input, deliberately. The number that matters is how many are close
 * enough to be worth showing, and that is what retrieval already decides —
 * anything scoring nothing is dropped before this cap applies. What is left is
 * a ceiling on prompt length, and a consumer tuning it would be tuning a proxy
 * for a cost the summary already shows them directly. `memory: { recall: }`
 * exists for the one consumer who still wants to, without inventing an input
 * for it.
 */
const RECALLED = 4;

/**
 * One provider per stage, each counting its own requests.
 *
 * The split is the cost argument made legible: `screen` is the cheap roster and
 * `triage` is the expensive one, and a maintainer deciding whether the cheap
 * pass is earning its keep needs those as two rows rather than one.
 */
export interface Stages {
  readonly detect: Provider;
  readonly screen: Provider;
  readonly triage: Provider;
  /** The roster that translates into the pivot language, for `record` and for cross-language recall. */
  readonly pivot: Provider;
}

/** Everything the run concluded, whatever path it took to conclude it. */
export interface Outcome {
  readonly language: string | null;
  readonly screenedOut: { readonly reason: string; readonly note: string } | null;
  readonly verdict: Verdict;
  /** The labels that survived every check. Not applied yet — `act` does that. */
  readonly applied: readonly string[];
  readonly refused: readonly Refusal[];
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  /** Why there is no verdict, when there is none. */
  readonly note: string | null;
  /**
   * How large the store was, how much of it reached the prompt, and how many
   * of those were recorded in a language other than the thread's own. That
   * last count reads a correction's stored `language`, not which query
   * reached it — it is not a claim that the pivot bridge was what found it.
   */
  readonly memory: {
    readonly size: number;
    readonly recalled: number;
    readonly pivotRecalled: number;
  };
  /** True when there was no warrant file, and this ran at the narrowest authority instead. */
  readonly implicit: boolean;
  /** Repository labels the implicit warrant left out for carrying no description. */
  readonly excludedLabels: readonly string[];
  /**
   * Why this duty was granted nothing, when a written `capabilities:` block
   * exists and simply does not name it. `null` on every other path, including
   * the ordinary "nothing was applied" a low-confidence or refused verdict
   * produces — this is specifically the reason nothing was ever attempted.
   */
  readonly ungranted: string | null;
}

/**
 * A sweep's progress, mutated in place rather than assembled and returned.
 *
 * The reason is `AuthenticationFailure`: it can throw out of `decide` partway
 * down the loop below, and "report what was already applied, then red" needs
 * whatever `runSweep` had built so far to still be readable from `run`'s
 * `finally` block after the `catch` has set the job failed. A value returned
 * only on success cannot do that — an object mutated as the loop goes can,
 * because the caller already holds the same reference.
 */
export interface SweepAccumulator {
  readonly results: SweptThread[];
  skipped: number;
  starvedRun: boolean;
  candidates: number;
  ungranted: string | null;
  /**
   * Whether `record` was granted and permitted for this sweep — decided once,
   * before the loop, and read back by `reportSweep` after it. `false` is the
   * ordinary sweep every existing workflow already runs; `true` is bulk
   * migration, `record` composed with `sweep`.
   */
  recording: boolean;
}

function newAccumulator(): SweepAccumulator {
  return {
    results: [],
    skipped: 0,
    starvedRun: false,
    candidates: 0,
    ungranted: null,
    recording: false,
  };
}

/**
 * The whole backlog, one thread at a time, through the identical pipeline a
 * single-thread run uses — or through `record`'s, when this is bulk
 * migration.
 *
 * Ungranted, capped labels-exist checking and per-thread deciding all happen
 * exactly once each — the first two before the loop, because they are facts
 * about the run rather than about any one thread, and the last one inside it,
 * because that is `decide`'s (or `recordCorrection`'s) whole job.
 *
 * **`record` composes with `sweep` by replacing the loop's whole body, not by
 * running alongside it.** A single-thread run tells the two apart by the
 * triggering event — a label change is a correction, anything else is a
 * verdict — but a sweep has no such event per thread, only a warrant and an
 * `apply` that either grant `record` or do not. So the same test single-thread
 * mode uses at its own branch point (`recordGrantedByRun`) is made once here,
 * for the whole run: granted, every candidate is recorded as bulk-migrated
 * history; not granted, every candidate is triaged, exactly as before this
 * capability existed.
 */
async function runSweep(
  acc: SweepAccumulator,
  api: TrackerApi & ContentsApi,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<void> {
  if (authority.warrant.unnamed("triage")) {
    acc.ungranted = notGranted(authority.warrant).ungranted;
    return;
  }

  const grantedCapabilities = authority.warrant.granted("triage", DEFAULT_CAPABILITIES);
  const { permitted } = narrow(grantedCapabilities, settings.apply);
  const recording = recordGrantedByRun(permitted);
  acc.recording = recording;

  if (!authority.implicit) {
    // `settings.taxonomy`, not the warrant's whole one: a sweep scoped to one
    // area's `labels` subset is checked only against its own area, so a label
    // renamed in an area this run was never asked to touch does not turn it
    // red — see `checkLabelsExist`'s own doc comment. Creating one is a
    // mutation like any other, so it waits for `permitted`/`settings.dryRun`,
    // computed just above, rather than running unconditionally ahead of them.
    await resolveMissingLabels(
      api,
      context.repo,
      checkLabelsExist(
        authority.warrant,
        (await listRepositoryLabels(api, context.repo)).map((label) => label.name),
        settings.taxonomy,
      ),
      permitted,
      settings.dryRun,
    );
  }

  const listed = await listOpenThreads(api, context.repo, settings.since, settings.sweepState);
  // Triage sweeps issues only — a taxonomy of bug/docs/feature labels is a
  // judgement about an issue, and the listing endpoint returns pull requests
  // too, distinguishable only by this field.
  const candidates = listed.filter((thread) => !thread.isPullRequest);
  acc.candidates = candidates.length;

  // `settings.taxonomy`'s own names, not the warrant's whole one: a sweep
  // scoped to one area's `labels` subset only recognises its own area's
  // labels as "already decided" — a thread another area already taxonomized
  // is not this sweep's business to skip or to import.
  const names = taxonomyNames(settings);

  for (const thread of candidates) {
    if (settings.limit !== null && acc.results.length >= settings.limit) break;

    if (recording) {
      // Bulk migration's own idempotent skip: a thread the taxonomy never
      // touched has no maintainer decision on it to import — nothing this
      // sweep is for.
      const decidable = thread.labels.some((name) => names.has(name));
      if (!decidable) {
        acc.skipped += 1;
        continue;
      }
    } else if (thread.labels.some((name) => names.has(name))) {
      // The idempotent skip: free, and counted separately from `processed` so
      // a rerun over a mostly-triaged backlog reports honestly rather than
      // looking like it did nothing.
      acc.skipped += 1;
      continue;
    }

    if (starved(settings.models, weather)) {
      acc.starvedRun = true;
      break;
    }

    const at = { ...context.repo, number: thread.number };
    const standing: Standing = {
      title: thread.title,
      body: thread.body,
      labels: thread.labels,
      closed: false,
      // A sweep's listing endpoint does not carry the opener's account type,
      // and triage has no guard that reads it — this placeholder is never
      // inspected, only `respond`'s bot-author guard reads `author` at all.
      author: { login: "", isBot: false },
      // Nor milestone/assignee state — triage never reads either.
      milestone: null,
      assignees: [],
      createdAt: thread.createdAt,
      isPullRequest: thread.isPullRequest,
    };

    if (recording) {
      const outcome = await recordCorrection(
        api,
        at,
        standing,
        authority,
        settings,
        stages,
        weather,
        "sweep",
        // A sweep imports whatever labels stand on a thread; there is no
        // single labelling event to read a before/after delta from, the
        // same reason `by === "sweep"` skips the S1 enrichment entirely.
        null,
      );
      // The self-training guard's own skip — machine-applied labels, or a
      // label history too long for this run to attribute — counted the same
      // way the idempotent skip above is, not added to the results table:
      // there is nothing this thread contributed to the store to show a row
      // for.
      if (outcome.machineOnly || outcome.unattributable) {
        acc.skipped += 1;
      } else {
        acc.results.push({ number: thread.number, outcome: describeRecordOutcome(outcome) });
      }
    } else {
      const outcome = await decide(authority, standing, settings, stages, weather);
      const done = settings.dryRun
        ? NOTHING_DONE
        : await act(
            createEffects(api, at),
            authority.warrant,
            outcome,
            api,
            at,
            settings.corrections,
          );
      acc.results.push({ number: thread.number, outcome: describeOutcome(outcome, done) });
    }
  }
}

/**
 * `propose`'s own half of a sweep — a fact about the whole backlog, never
 * about one thread, so it runs once per sweep rather than inside
 * {@link runSweep}'s per-thread loop.
 *
 * Double-gated exactly like `record`: granted by the warrant's
 * `capabilities:` and named by the workflow's `apply`, narrower wins, with
 * the same asymmetric notice `record` already gives when the file grants it
 * and `apply` does not ask for it. A capacity error and an authentication
 * failure are both `runPropose`'s own business (D12) — this only logs what
 * it decided.
 */
/**
 * A hard page cap on the evidence gate's own open-issue read — the same
 * order of magnitude `propose.ts`'s own `LIST_PAGES` gives the closed-PR
 * walk it does for struck-entry memory, and for the same reason: this read
 * has no per-thread budget of its own to bound it by, unlike the sweep's
 * `limit`-gated candidate walk just above this function's call site.
 */
const EVIDENCE_LISTING_MAX_PAGES = 10;

async function runProposeSweep(
  api: TrackerApi & AtlasApi & ProposalsApi,
  authority: Authority,
  settings: Settings,
): Promise<ProposeReport | null> {
  const grantedCapabilities = authority.warrant.granted("triage", DEFAULT_CAPABILITIES);
  if (!grantedCapabilities.includes("propose")) return null;

  const { permitted } = narrow(grantedCapabilities, settings.apply);
  if (!permitted.includes("propose")) {
    core.notice(
      `\`${authority.warrant.path}\` grants \`propose\`, but \`apply\` does not name it, so this sweep ` +
        "did not propose anything. The narrower of the two wins — add `propose` to `apply` as well to " +
        "enable it.",
    );
    return buildProposeReport({
      notes: [
        "`apply` does not name `propose`, so this sweep declined to propose anything this run.",
      ],
    });
  }

  // The two reads `runPropose`'s own capacity boundary cannot see, under the
  // same D12 classification it applies inside: capacity is weather, reported
  // as a declined round rather than thrown red; an auth error propagates.
  let atlas;
  let openIssues;
  try {
    atlas = await readAtlas(api, context.repo);
    openIssues = (
      await listOpenThreads(api, context.repo, settings.since, "open", EVIDENCE_LISTING_MAX_PAGES)
    ).filter((issue) => !issue.isPullRequest);
  } catch (error) {
    if (!isCapacityError(error)) throw error;
    const note =
      "`propose` hit a capacity error before it could read the workspace or its evidence — " +
      "nothing was proposed this run; the next sweep starts fresh.";
    core.warning(note);
    return buildProposeReport({ notes: [note] });
  }

  const proposeReport = await runPropose(
    api,
    context.repo,
    authority.warrant,
    authority.implicit,
    atlas,
    openIssues,
    new Date(),
    settings.dryRun,
  );
  for (const note of proposeReport.notes) core.info(`propose: ${note}`);
  if (proposeReport.pr !== null) {
    core.notice(
      `propose: ${proposeReport.unchanged ? "the open proposal" : "the proposal"} is #${String(proposeReport.pr)}.`,
    );
  }
  return proposeReport;
}

/**
 * A single-thread run's own notice for `propose` — it is granted, but a
 * sweep is the only shape that holds the whole-backlog picture this
 * capability needs, so an event-triggered run does nothing with it. Mirrors
 * the `record`-eligible-but-not-fired notice this duty already gives.
 */
function noticeProposeSweepOnly(authority: Authority): void {
  const grantedCapabilities = authority.warrant.granted("triage", DEFAULT_CAPABILITIES);
  if (grantedCapabilities.includes("propose")) {
    core.info(
      `\`${authority.warrant.path}\` grants \`propose\`, but it only runs under \`sweep\` — this run did ` +
        "nothing with it.",
    );
  }
}

/** One sweep row's outcome, in the fewest words that are true. */
function describeOutcome(outcome: Outcome, done: Done): string {
  if (outcome.ungranted !== null) return "not granted";
  if (outcome.screenedOut !== null) return `screened out — ${outcome.screenedOut.reason}`;
  if (done.labels.length > 0) {
    return `applied ${done.labels.map((name) => `\`${name}\``).join(", ")}`;
  }
  if (outcome.verdict.labels.length > 0) return "proposed, not applied (below floor or refused)";
  return "no label";
}

/**
 * Everything but `languages` and `taxonomy`, neither of which can be read
 * here: both need the warrant, and `readWarrant`'s own result is only
 * available once `resolveAuthority` has answered, while every other input
 * here is not async at all. `run` completes the object once it has.
 *
 * Kept here rather than in `./inputs.js` alongside the rest of this duty's
 * input contract: `main.integration.test.ts`'s "reads every input it
 * declares" test finds every `getInput` call by scanning this file's own
 * source text (and `core/inputs.ts`'s), so a `core.getInput` call moved out
 * of this file would still run correctly but would go invisible to that
 * check. `./inputs.js` carries the pure transforms this calls into instead.
 */
function readSettings(): Omit<Settings, "languages" | "taxonomy"> {
  const shared = readShared();
  const cheap = parseModels(core.getInput("screen-models"));

  return {
    ...shared,
    screenModels: cheap.models,
    screenNames: cheap.names,
    warrant: core.getInput("warrant", { required: true }),
    apply: parseApply(core.getInput("apply", { required: true })),
    confidence: fraction("confidence", core.getInput("confidence")),
    corrections: core.getInput("corrections", { required: true }),
    about: core.getInput("about"),
    minBodyChars: counted("min-body-chars", core.getInput("min-body-chars")),
    maxBodyChars: bounded("max-body-chars", core.getInput("max-body-chars")),
    sweepState: parseSweepState(core.getInput("sweep-state")),
  };
}

export async function run(): Promise<void> {
  // Declared out here and written in `finally`, so a run that fails halfway
  // still reports what it decided and what it spent getting there — including
  // an `AuthenticationFailure` thrown partway down a sweep's loop, which
  // leaves `bulk` holding every thread already processed before it threw.
  const meter = createMeter();
  // Reassigned once `readSettings` has answered, inside the `try` below —
  // `endpoints` is not known until then. Left at its empty-alias default if
  // reading the settings themselves is what fails, which is fine: nothing
  // below that point ever runs.
  let weather = createWeather();
  let settings: Settings | null = null;
  let single: { readonly number: number; readonly outcome: Outcome; readonly done: Done } | null =
    null;
  let recorded: { readonly number: number; readonly outcome: RecordOutcome } | null = null;
  let bulk: SweepAccumulator | null = null;
  let proposeOutcome: ProposeReport | null = null;

  try {
    const base = readSettings();
    const client = assembleClient(base, meter, ["detect", "screen", "triage", "pivot"] as const, [
      base.screenModels,
    ]);
    weather = client.weather;
    const api = getOctokit(base.token);
    const stages: Stages = client.stages;

    // The authority first, and before anything is spent. A file that does not
    // parse is a run with no allowlist, and the fail-safe direction is to stop
    // — but a file that is simply not there, at the path nobody moved it from,
    // is not that failure. `resolveAuthority` is what turns that absence into
    // the implicit warrant rather than an error.
    const read = await readWarrant(base.warrant, { defaultPath: DEFAULT_WARRANT_PATH });
    const authority = await resolveAuthority(read, base.warrant, api, context.repo);

    // Only now, because whether the warrant or the input answers this is the
    // authority's to decide — and once it does, `languages` is complete and
    // `settings` can become the object every stage below already expects.
    // Except when the same authority already denied this duty outright — that
    // run is promised a green no-op, and red-failing it over a `languages`
    // nobody configured would fail it over configuration it was never going
    // to use.
    const denied = authority.warrant.unnamed("triage");
    const resolution = denied
      ? null
      : resolveLanguages(authority.warrant, core.getInput("languages"));
    if (resolution !== null && resolution.notice !== null) core.notice(resolution.notice);

    // Same warrant-wins, input-falls-back pattern as `languages` above, on the
    // one field the spam screen reads and nothing else does.
    const about = resolveAbout(authority.warrant, base.about);
    if (about.notice !== null) core.notice(about.notice);

    // Guarded the same way `resolution` is: a denied run is promised a green
    // no-op, and `labels` is configuration it was never going to use — a typo
    // in it has no business red-failing a run that could never have reached
    // the taxonomy anyway.
    const taxonomy = denied ? [] : resolveTaxonomy(authority.warrant, core.getInput("labels"));

    settings = {
      ...base,
      languages: resolution === null ? [] : resolution.languages,
      about: about.about,
      taxonomy,
    };

    if (settings.sweep) {
      bulk = newAccumulator();
      await runSweep(bulk, api, authority, settings, stages, weather);
      proposeOutcome = await runProposeSweep(api, authority, settings);
    } else {
      const number = settings.number;
      // `readShared` refuses `sweep` combined with `number`, but a bare
      // `sweep: false` still leaves `number` nullable in the type — this is
      // the one place that has to become certain of it.
      if (number === null) throw new Error("number: required outside `sweep`.");
      const at = { ...context.repo, number };

      // A written `capabilities:` block that does not name `triage` grants it
      // nothing, and no verdict this run could reach changes that — so this
      // sits here, as early as the answer is already certain, and before the
      // thread, the taxonomy check, or a single model call spends anything on
      // a decision that could never be applied.
      let outcome: Outcome | null = null;
      let recordOutcome: RecordOutcome | null = null;
      if (authority.warrant.unnamed("triage")) {
        outcome = notGranted(authority.warrant);
      } else {
        const standing = await readStanding(api, at);

        if (isReeveProposalPr(standing)) {
          // Recursion guard: Reeve never triages its own proposal pull
          // request. `runSweep`'s listing already filters every pull
          // request out of its candidates before this could run; the
          // `number:` path has no listing to filter, so it is checked
          // again here.
          outcome = recursionGuardOutcome();
        } else {
          // `record` takes a labelled/unlabelled event or a reopen, from a
          // human, and only when both the file and the workflow's `apply`
          // grant it — the same narrowing every other capability goes through.
          // Every other event, or the capability simply not granted, is
          // today's behaviour: a verdict, not a recording.
          const trigger = recordTrigger();
          const grantedCapabilities = authority.warrant.granted("triage", DEFAULT_CAPABILITIES);
          const { permitted } = narrow(grantedCapabilities, settings.apply);

          if (!authority.implicit) {
            // Against the repository's own labels, so a taxonomy naming one
            // that was renamed fails as the configuration problem it is, rather
            // than arriving as a model that agreed with nothing. Skipped in
            // implicit mode: the taxonomy IS the repository's own labels there,
            // and checking it against itself would be a tautology. Checked
            // against `settings.taxonomy`, already narrowed by the `labels`
            // input — a rename in an area this run was never asked to touch is
            // not this run's business to fail over. Creating one is a mutation
            // like any other, so it waits for `permitted`/`settings.dryRun`,
            // computed just above, rather than running unconditionally.
            await resolveMissingLabels(
              api,
              at,
              checkLabelsExist(
                authority.warrant,
                (await listRepositoryLabels(api, at)).map((label) => label.name),
                settings.taxonomy,
              ),
              permitted,
              settings.dryRun,
            );
          }

          // The file grants `record` but `apply` narrowed it away — the one
          // direction `withheld` (used inside `decide` below) does not already
          // cover, so a maintainer who granted it in the file and stopped there
          // does not get a silent full re-triage with nothing explaining why.
          if (
            trigger.eligible &&
            recordGrantedByFile(grantedCapabilities) &&
            !recordGrantedByRun(permitted)
          ) {
            core.notice(
              `\`${authority.warrant.path}\` grants \`record\`, but \`apply\` does not name it, ` +
                "so this event was triaged instead of recorded. The narrower of the two wins — " +
                "add `record` to `apply` as well to record it instead.",
            );
          }

          // The other silent branch: fully granted and a firing event, but the
          // sender was refused (a bot). Events `record` never fires on at all
          // leave `trigger.reason` empty, so those stay silent here too.
          if (trigger.reason !== "" && recordGrantedByRun(permitted)) {
            core.info(`\`record\` is granted, but did not fire this run: ${trigger.reason}.`);
          }

          // `propose` needs the whole backlog picture a sweep holds — an
          // event-triggered run granted it does nothing but say so, the same
          // shape as the two notices above.
          noticeProposeSweepOnly(authority);

          if (trigger.eligible && recordGrantedByRun(permitted) && trigger.kind === "reopen") {
            const check = await checkReversal(api, at, standing, senderLogin());
            if (check.authorReopen) {
              core.notice(
                `#${String(number)} was reopened by the thread's own author — not recorded as a ` +
                  "reversal. A maintainer who agrees the close was wrong can still record it, by " +
                  "toggling a label.",
              );
            }
            if (check.reversal !== null) {
              recordOutcome = await recordReversal(
                api,
                at,
                standing,
                authority,
                settings,
                stages,
                weather,
                senderLogin(),
                check.reversal.duplicateOf,
              );
            } else {
              outcome = await decide(authority, standing, settings, stages, weather);
            }
          } else if (trigger.eligible && recordGrantedByRun(permitted)) {
            recordOutcome = await recordCorrection(
              api,
              at,
              standing,
              authority,
              settings,
              stages,
              weather,
              senderLogin(),
              labelChange(),
            );
          } else {
            outcome = await decide(authority, standing, settings, stages, weather);
          }
        }
      }

      if (recordOutcome !== null) {
        recorded = { number, outcome: recordOutcome };
      } else if (outcome !== null) {
        const done = settings.dryRun
          ? NOTHING_DONE
          : await act(
              createEffects(api, at),
              authority.warrant,
              outcome,
              api,
              at,
              settings.corrections,
            );
        single = { number, outcome, done };
      }
    }

    // Deferred half of the multi-endpoint amendment to D12: a single-endpoint
    // run never reaches this with anything to say — `reckon` already threw
    // the moment its one endpoint answered unauthenticated. Only fires once
    // every endpoint configured turned out to be misconfigured the same way.
    settleAuth(weather);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    // Nothing to report when the settings themselves were the problem: no
    // request was made, and a page saying so would be a page about a typo.
    if (settings !== null) {
      const rosterStarved = starved(settings.models, weather);
      if (rosterStarved) {
        core.warning(
          "Every model in `models` failed on capacity this run. " +
            (settings.sweep
              ? "The sweep delivered what it could before the roster ran dry, and " +
                "stopped early — see `remaining`."
              : "This run delivered what it could rather than failing red — weather, " +
                "not a broken configuration."),
        );
      }

      if (settings.sweep && bulk !== null) {
        reportSweep(bulk, rosterStarved);
        await writeSummary(
          sweepPage(settings, bulk, meter.spent()) +
            proposeSection(proposeOutcome) +
            authSection(weather.authFailures),
        );
      } else if (!settings.sweep && recorded !== null) {
        reportRecordRun(recorded.outcome, rosterStarved);
        await writeSummary(
          recordPage(settings, recorded.number, recorded.outcome, meter.spent()) +
            authSection(weather.authFailures),
        );
      } else if (!settings.sweep && single !== null) {
        report(single.outcome, single.done, settings.dryRun, rosterStarved);
        await writeSummary(
          page(settings, single.number, single.outcome, single.done, meter.spent()) +
            authSection(weather.authFailures),
        );
      }
    }
  }
}

/**
 * Everything up to and including the verdict, with nothing written anywhere.
 *
 * Separated from the acting half because it is the half that has to be
 * identical under `dry-run`: a rehearsal that took a different path through the
 * pipeline would be rehearsing a run nobody is going to have.
 */
async function decide(
  authority: Authority,
  standing: Standing,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<Outcome> {
  const warrant = authority.warrant;
  const limit = settings.maxBodyChars;
  const body = limit === null ? standing.body : standing.body.slice(0, limit);
  if (limit !== null && standing.body.length > limit) {
    // Said, because a truncated body is a verdict reached on less than the
    // author wrote, and whoever reads that verdict deserves to know which.
    core.warning(
      `Only the first ${String(limit)} characters of the body were read. ` +
        "Raise `max-body-chars` to read the rest.",
    );
  }

  const { permitted, withheld } = narrow(
    warrant.granted("triage", DEFAULT_CAPABILITIES),
    settings.apply,
  );
  for (const capability of withheld) {
    core.warning(
      `\`apply\` asks for \`${capability}\`, which \`${warrant.path}\` does not grant to triage. ` +
        "The narrower of the two wins.",
    );
  }

  /** A run that stopped early: no verdict, and the guardrails still reported. */
  const stopped = (screened: Outcome["screenedOut"], language: string | null): Outcome => ({
    language,
    screenedOut: screened,
    verdict: NOTHING,
    applied: [],
    refused: [],
    permitted,
    withheld,
    note: null,
    memory: { size: 0, recalled: 0, pivotRecalled: 0 },
    implicit: authority.implicit,
    excludedLabels: authority.excludedLabels,
    ungranted: null,
  });

  const free = screen({ title: standing.title, body, minimum: settings.minBodyChars });
  if (free !== null) {
    core.info(`Screened out as ${free.reason} — ${free.note}.`);
    return stopped(free, null);
  }

  const detection = await detectLanguage(
    // The title when there is no body. A one-line issue is a real issue, and
    // the alternative is asking a model to identify the language of nothing.
    body.length === 0 ? standing.title : body,
    settings.languages,
    // The cheap roster when there is one. Choosing between listed codes is an
    // enum answer, which is the shape a small model is reliable on, and paying
    // the expensive model for it would be paying it to do the cheap one's work.
    createLanguagePicker(
      stages.detect,
      settings.screenModels.length > 0 ? settings.screenModels : settings.models,
      weather,
    ),
  );
  const language = detection.language?.label ?? null;
  core.info(
    detection.language === null
      ? "The author's language is none of the configured ones."
      : `Author language ${detection.language.code} (by ${detection.by}).`,
  );

  const sifted = await sift({
    provider: stages.screen,
    models: settings.screenModels,
    title: standing.title,
    body,
    about: settings.about,
    weather,
  });
  for (const failure of sifted.failures) {
    core.warning(`screen: ${shown(settings.screenNames, failure.model)} — ${failure.reason}`);
  }
  if (sifted.dropped !== null) {
    core.info(`Screened out as ${sifted.dropped.reason} — ${sifted.dropped.note}.`);
    return stopped(sifted.dropped, language);
  }

  // `recall: 0` (or a negative override) is a promise as much as a setting:
  // the store is not touched at all, not merely searched-and-returns-nothing.
  // That distinction matters for a maintainer who points `corrections` at a
  // path they would rather this run never open.
  const recallCount = warrant.memory?.recall ?? RECALLED;
  const threadLanguage = detection.language;

  let recalled: readonly Correction[] = [];
  let memorySize = 0;
  let pivotRecalled = 0;

  if (recallCount > 0) {
    const store = await readStore(settings.corrections);
    for (const line of store.unreadable) {
      // Loud, because this is a committed file that maintainers open by hand:
      // losing one example is not worth losing the verdict, and losing it
      // silently is not worth anything.
      core.warning(`corrections: ${line}`);
    }
    const memory = createMemory(store.corrections);
    memorySize = memory.size;

    const queries: WeightedQuery[] = [{ text: `${standing.title}\n${body}`, against: "own" }];

    // The pivot bridge is worth a request only when it could change the answer:
    // the thread's own language has to be known, a pivot language has to be
    // configured, and the store has to hold at least one correction that is not
    // already in the thread's own language. A store that shares one language
    // with the thread has nothing a translated query would reach that the plain
    // one above does not already reach — so that case, the common one, spends
    // no provider call here at all.
    const pivotLanguage =
      settings.languages.length > 0 ? resolvePivot(warrant, settings.languages) : null;
    const worthBridging =
      threadLanguage !== null &&
      pivotLanguage !== null &&
      store.corrections.some((correction) => correction.language !== threadLanguage.code);

    if (worthBridging) {
      const pivotModels =
        settings.screenModels.length > 0 ? settings.screenModels : settings.models;
      const pivotNames =
        settings.screenModels.length > 0 ? settings.screenNames : settings.modelNames;
      const pivot = await translateToPivot({
        provider: stages.pivot,
        models: pivotModels,
        title: standing.title,
        body,
        to: pivotLanguage,
        weather,
      });
      for (const failure of pivot.failures) {
        core.warning(`recall: ${shown(pivotNames, failure.model)} — ${failure.reason}`);
      }
      if (pivot.draft !== null) {
        queries.push({
          text: `${pivot.draft.title}\n${pivot.draft.body}`,
          against: { pivot: pivotLanguage.code },
        });
      } else {
        core.info(
          "Cross-language recall could not translate this thread into the pivot language this run " +
            "— recall used the thread's own language only.",
        );
      }
    }

    recalled = memory.recallAcrossQueries(queries, recallCount);
    pivotRecalled =
      threadLanguage === null
        ? 0
        : recalled.filter(
            (correction) =>
              correction.language !== null && correction.language !== threadLanguage.code,
          ).length;
    core.info(
      `Recalled ${String(recalled.length)} of ${String(memorySize)} correction(s) ` +
        `from \`${settings.corrections}\`` +
        (pivotRecalled > 0
          ? `, ${String(pivotRecalled)} of them recorded in a language other than the thread's.`
          : "."),
    );
  } else {
    core.info(
      "Recall is disabled (`memory.recall` is 0 or lower) — the corrections store was not read.",
    );
  }

  const triaged = await triage({
    provider: stages.triage,
    models: settings.models,
    title: standing.title,
    body,
    taxonomy: settings.taxonomy,
    language,
    recalled,
    weather,
  });
  for (const failure of triaged.failures) {
    core.warning(`triage: ${shown(settings.modelNames, failure.model)} — ${failure.reason}`);
  }
  if (triaged.unreadable !== null) {
    core.warning(
      "The verdict could not be read, so nothing was applied. A half-parsed answer is the " +
        `shape an injection produces, so it is refused whole — it began: ${excerpt(triaged.unreadable)}`,
    );
  }

  // Every model failing and an answer nobody could read are different
  // configurations with the same outcome, and a report naming neither would
  // read as a model that simply agreed with nothing.
  const note =
    triaged.unreadable !== null
      ? "the verdict did not parse"
      : triaged.failures.length > 0 && triaged.verdict.labels.length === 0
        ? "every model failed"
        : null;

  const verdict = triaged.verdict;
  const decided = {
    language,
    screenedOut: null,
    verdict,
    permitted,
    withheld,
    note,
    memory: { size: memorySize, recalled: recalled.length, pivotRecalled },
    implicit: authority.implicit,
    excludedLabels: authority.excludedLabels,
    ungranted: null,
  } as const;

  // The run's own floor is `enforceLabels`'s default, but a label carrying
  // its own `confidence:` in the warrant answers for itself instead — so this
  // no longer short-circuits before the taxonomy is even consulted. A verdict
  // under the run's floor can still clear one label's own lower bar, and a
  // verdict over it can still be turned away by one label's own higher one.
  const decision = enforceLabels(
    warrant.path,
    settings.taxonomy,
    verdict.labels,
    standing.labels,
    verdict.confidence,
    settings.confidence,
  );
  for (const refusal of decision.refused) {
    core.info(`\`${refusal.what}\` was not applied — ${refusal.why}.`);
  }

  return {
    ...decided,
    // Narrowed here rather than at apply time, so `labels` reports what this run
    // may do and a rehearsal rehearses the same narrowing a real run has.
    applied: permitted.includes("label") ? decision.applied : [],
    refused: decision.refused,
  };
}

/**
 * The outcome of a run this duty was never going to be allowed to act on.
 *
 * Green, not red — enumerating who may act is a maintainer's decision, and a
 * name the enumeration left out is a decision too, just not one that grants
 * anything. Nothing here is a verdict a model reached, which is the entire
 * point: this is reached instead of `decide`, not by it, so it costs nothing
 * to produce.
 */
/**
 * Creates repository label objects for taxonomy entries `checkLabelsExist`
 * returned instead of failing red — every one of them carries `create: true`,
 * a human-merged instruction (written by hand, or via a `propose` PR) rather
 * than a capability grant, per that function's own doc comment.
 *
 * Best-effort per label: a create call that fails (most likely a race with a
 * human creating the same name between the check and this call) is noted and
 * does not fail the run — what the next `checkLabelsExist` call cares about
 * is whether the label exists now, not who created it.
 */
async function createMissingLabels(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  toCreate: readonly Label[],
): Promise<void> {
  for (const label of toCreate) {
    try {
      await createRepositoryLabel(api, at, label);
      core.notice(
        `triage: created \`${label.name}\` (\`create: true\`) — remove that key from the warrant ` +
          "once you've reviewed it; it does nothing further once the label exists.",
      );
    } catch (error) {
      core.warning(
        `triage: could not create \`${label.name}\` — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The gate in front of {@link createMissingLabels}: a taxonomy entry marked
 * `create: true` is a human-merged instruction, but creating it is still a
 * repository mutation — `apply: none`/a `capabilities:` block that narrows
 * `label` away, and `dry-run: true`, both mean "not this run," the same as
 * they mean for every other write this duty makes. Silent about neither: a
 * withheld or rehearsed creation still says so, rather than looking like the
 * taxonomy had nothing missing.
 */
async function resolveMissingLabels(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  toCreate: readonly Label[],
  permitted: readonly Capability[],
  dryRun: boolean,
): Promise<void> {
  if (toCreate.length === 0) return;
  const names = toCreate.map((label) => `\`${label.name}\``).join(", ");
  if (!permitted.includes("label")) {
    core.notice(
      `triage: ${toCreate.length === 1 ? "a label" : "labels"} ${names} ${toCreate.length === 1 ? "names" : "name"} ` +
        `\`create: true\`, but \`label\` is not permitted this run — nothing was created.`,
    );
    return;
  }
  if (dryRun) {
    core.info(
      `Would create ${toCreate.length === 1 ? "label" : "labels"} ${names} (\`create: true\`) — ` +
        "dry run, nothing created.",
    );
    return;
  }
  await createMissingLabels(api, at, toCreate);
}

/**
 * The outcome of a run reaching Reeve's own proposal pull request directly
 * (`number:`, rather than through a sweep's listing, which already filters
 * every pull request out). Green, not red, the same shape `notGranted` gives
 * a run this duty was never allowed onto at all.
 */
function recursionGuardOutcome(): Outcome {
  return {
    language: null,
    screenedOut: null,
    verdict: NOTHING,
    applied: [],
    refused: [],
    permitted: [],
    withheld: [],
    note: null,
    memory: { size: 0, recalled: 0, pivotRecalled: 0 },
    implicit: false,
    excludedLabels: [],
    ungranted: "This is Reeve's own proposal pull request — every duty skips it, triage included.",
  };
}

function notGranted(warrant: Warrant): Outcome {
  return {
    language: null,
    screenedOut: null,
    verdict: NOTHING,
    applied: [],
    refused: [],
    permitted: [],
    withheld: [],
    note: null,
    memory: { size: 0, recalled: 0, pivotRecalled: 0 },
    implicit: false,
    excludedLabels: [],
    ungranted:
      `\`${warrant.path}\`'s \`capabilities:\` block does not name \`triage\`; once that block ` +
      "exists it is the whole answer, so add `triage: [label]` to it (or remove the block to " +
      "return to defaults).",
  };
}

/**
 * Everything that changes the tracker, and the only function here that does.
 *
 * Each effect is guarded by the intersection rather than by the verdict, and
 * they are meant to be read top to bottom by somebody asking what this duty can
 * do to their repository. Not reached at all under `dry-run`.
 *
 * **The hard gate.** A `close`-permitted verdict naming a `duplicateOf` is
 * not enough on its own to close a thread — `gateClose` gets the last word,
 * checked here in code, after everything upstream (the model, `enforce`,
 * `narrow`) has already agreed a close would otherwise be allowed. A model's
 * own answer cannot talk this refusal down, which is the entire property
 * `recall`'s prompt-side examples cannot provide by themselves: recall is
 * advice, this is enforcement. See `gateClose`'s own doc comment for what it
 * checks and why an unreadable shard refuses the same as a found record.
 */
async function act(
  effects: Effects,
  warrant: Warrant,
  outcome: Outcome,
  contentsApi: ContentsApi,
  at: Location,
  correctionsPath: string,
): Promise<Done> {
  let labels: readonly string[] = [];
  let assigned: readonly string[] = [];
  let closed = false;

  if (outcome.applied.length > 0) {
    await effects.addLabels(outcome.applied);
    labels = outcome.applied;
  }

  // Assignment follows the labels rather than the verdict: the taxonomy is what
  // says who owns an area, so applying nothing leaves nobody to hand it to.
  if (outcome.permitted.includes("assign") && labels.length > 0) {
    const who = owners(warrant, labels);
    for (const team of who.teams) {
      // Said once rather than dropped silently or failed over: an issue cannot
      // be assigned to a team, and a taxonomy naming one is not wrong about who
      // owns the area — the tracker has no field for it.
      core.warning(
        `\`${warrant.path}\` gives a label the owner \`@${team}\`, and an issue cannot be ` +
          "assigned to a team. Name a person to have one assigned.",
      );
    }
    if (who.users.length > 0) {
      await effects.assign(who.users);
      assigned = who.users;
    }
  }

  if (outcome.permitted.includes("close") && outcome.verdict.duplicateOf !== null) {
    const gate = await gateClose(
      contentsApi,
      at,
      repoRelativePath(correctionsPath),
      `${at.owner}/${at.repo}`,
      at.number,
    );
    if (gate.refuse) {
      if (gate.found) {
        // The record was actually found, whatever else this scan could or
        // could not read along the way — an unreadable shard elsewhere does
        // not make this refusal any less certain, so it is named here only
        // as extra context, never as the reason.
        const aside =
          gate.unreadable.length > 0
            ? ` (${gate.unreadable.map((shard) => `\`${shard}\``).join(", ")} could not be read ` +
              "while checking, but that is not why this was refused)"
            : "";
        core.notice(
          `#${String(at.number)}: a human already reopened this thread after Reeve closed it as ` +
            "a duplicate — that close was recorded as reversed, and the gate refuses to repeat " +
            `it. The model's verdict is not what decides this; D3 is.${aside}`,
        );
      } else {
        core.warning(
          `#${String(at.number)}: the hard gate could not fully check whether this close was ` +
            `already reversed — ${gate.unreadable.map((shard) => `\`${shard}\``).join(", ")} ` +
            "could not be read, and an unreadable shard refuses the same as a found record " +
            "would. The close was refused rather than risk re-closing a thread a human already " +
            "reopened.",
        );
      }
    } else {
      await effects.closeAsNotPlanned();
      closed = true;
    }
  }

  // Last, so it describes what happened rather than what was about to. A run
  // that applied nothing says nothing, which is also what keeps a rerun from
  // leaving a second identical comment: on the second pass the labels are
  // already on the thread, so enforcement refuses them all and there is nothing
  // left to announce.
  const said = comment(outcome, { labels, commented: false, assigned, closed });
  let commented = false;
  if (outcome.permitted.includes("comment") && said.length > 0) {
    await effects.comment(said);
    commented = true;
  }

  return { labels, commented, assigned, closed };
}

/** What the comment says, or nothing at all when there is nothing to say. */
function comment(outcome: Outcome, done: Done): string {
  const parts: string[] = [];
  if (done.labels.length > 0) {
    parts.push(`Triaged as ${done.labels.map((name) => `\`${name}\``).join(", ")}.`);
  }
  if (outcome.verdict.duplicateOf !== null) {
    const number = `#${String(outcome.verdict.duplicateOf)}`;
    parts.push(
      done.closed ? `Closed as a duplicate of ${number}.` : `This may duplicate ${number}.`,
    );
    // The attribution marker rides in the same comment as the close it
    // describes — never a second comment, which is what lets `attributedClose`
    // find "the most recent close" as "the most recent bot comment carrying
    // this marker" without also having to reconcile it against a separate
    // labelling comment posted the same run. See `closeMarker`'s own doc
    // comment for why the marker has to exist at all before a reversal of
    // this close can ever be attributed back to Reeve.
    if (done.closed) parts.push(closeMarker.render(outcome.verdict.duplicateOf));
  }
  if (parts.length === 0) return "";

  if (outcome.verdict.rationale.length > 0) parts.push("", `> ${outcome.verdict.rationale}`);
  parts.push(
    "",
    "<sub>Proposed by a model and checked against this repository's own taxonomy. " +
      "Correcting the labels is the intended way to disagree.</sub>",
  );

  return parts.join("\n");
}

/** Enough of an unreadable answer to recognise it, on one line. */
function excerpt(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`;
}

await run();
