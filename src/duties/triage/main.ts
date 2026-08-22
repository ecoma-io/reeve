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
 *      `duties:` block that does not name `triage` grants it nothing,
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
 *   8. **Apply.** Only what the file grants.
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
 * screened out and a `duties:` block that does not name this duty are all
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
 *
 * **What this file no longer does, because `core/` does it for every duty
 * that needs it.** Reading the shared inputs (`readCore`), assembling the
 * provider client with its rotation, temperature and metering
 * (`assembleClient`), opening the authority — warrant file or the implicit
 * one — and warning about withheld capabilities (`openAuthority`), walking
 * the backlog (`sweepThreads`), recalling
 * corrections including the cross-language bridge (`recallCorrections`, and
 * `RECALLED` — the default every recalling duty now shares), and ending the
 * run (`warnIfStarved`, `writeRunSummary`). Each of those was a near-copy in
 * four or five duties; each is now one tested module, called from here.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { readAtlas, type AtlasApi } from "../../core/atlas.js";
import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import { enforceLabels, owners, type Refusal } from "../../core/enforce.js";
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
import { RECALLED } from "../../core/memory.js";
import { createMeter } from "../../core/meter.js";
import {
  assembleClient,
  createWeather,
  parseModels,
  settleAuth,
  shown,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { recallCorrections } from "../../core/recall.js";
import { sanitize } from "../../core/sanitize.js";
import { screen } from "../../core/screen.js";
import { sift } from "../../core/spam.js";
import { ensureBranch, publishStatePr, type StateBranchApi } from "../../core/state-branch.js";
import { warnIfStarved, failIfRosterExhausted, writeRunSummary } from "../../core/summary.js";
import {
  newAccumulator as newCoreAccumulator,
  standingFromListing,
  sweepThreads,
  type SweepAccumulator as Accumulator,
} from "../../core/sweep.js";
import {
  checkLabelsExist,
  dutyLanguages,
  openAuthority,
  pivotOrNone,
  resolveAbout,
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
import { parseLanguages } from "../../core/languages.js";

/** What detection reads when the warrant's `languages:` key is silent. */
const DEFAULT_LANGUAGES = parseLanguages("en, vi, zh");

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
   * Why this duty was granted nothing, when a written `duties:` block
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
export interface SweepAccumulator extends Accumulator<SweptThread> {
  /**
   * Whether `record` was granted and permitted for this sweep — decided once,
   * before the loop, and read back by `reportSweep` after it. `false` is the
   * ordinary sweep every existing workflow already runs; `true` is bulk
   * migration, `record` composed with `sweep`.
   */
  recording: boolean;
}

function newAccumulator(): SweepAccumulator {
  return { ...newCoreAccumulator<SweptThread>(), recording: false };
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
 * verdict — but a sweep has no such event per thread, only a warrant and a
 * `sweep-state`. So the same test single-thread mode uses at its own branch
 * point (`recordGrantedByRun`) is made once here, for the whole run — and
 * only when the sweep was deliberately scoped to a closed/all listing: bulk
 * migration is a hand-run one-off (`sweep-state: all`), never what the
 * scheduled `sweep-state: open` sweep does. Scoped that way, every candidate
 * is recorded as bulk-migrated history; otherwise every candidate is triaged,
 * exactly as before this capability existed.
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
  const permitted = grantedCapabilities;
  // Bulk migration is a deliberate, hand-run one-off, not what a scheduled
  // sweep does: the ordinary sweep (`sweep-state: open`) is an incremental
  // label pass, so `record` composes with `sweep` only when the sweep was
  // explicitly scoped to a closed/all listing — the `sweep-state: all` a
  // maintainer writes by hand to import history. Gating it here keeps the
  // weekly schedule labelling the backlog instead of silently writing
  // corrections for every open thread.
  const recording = recordGrantedByRun(permitted) && settings.sweepState !== "open";
  acc.recording = recording;

  // When state-branch is set, open-pr must also be granted — the branch-write
  // path opens a draft PR, and recording without it would commit corrections
  // to a branch that nobody is asked to review. The gate is on top of
  // `record` (already checked above as `recording`): both `record` and
  // `open-pr` must be in `permitted` for a branch-write to go ahead.
  const stateBranch = settings.stateBranch !== "" ? settings.stateBranch : undefined;
  let canRecordToBranch = false;
  if (stateBranch !== undefined) {
    canRecordToBranch = recording && permitted.includes("open-pr");
    if (recording && !permitted.includes("open-pr")) {
      core.notice(
        "triage: `state-branch` is set but `open-pr` is not granted. " +
          "Corrections will be recorded to the default branch instead.",
      );
    }
  }

  // Ensure the state branch exists before any recording writes to it — the
  // Contents API's `branch` parameter fails if the ref does not exist.
  if (canRecordToBranch && !settings.dryRun && stateBranch !== undefined) {
    await ensureBranch(api as unknown as StateBranchApi, context.repo, stateBranch);
  }

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

  // `settings.taxonomy`'s own names, not the warrant's whole one: a sweep
  // scoped to one area's `labels` subset only recognises its own area's
  // labels as "already decided" — a thread another area already taxonomized
  // is not this sweep's business to skip or to import.
  const names = taxonomyNames(settings);

  await sweepThreads(acc, candidates, settings, weather, {
    // The idempotent skip: free, and counted separately from `processed` so a
    // rerun over a mostly-triaged backlog reports honestly rather than looking
    // like it did nothing. Bulk migration's own is the mirror image of it — a
    // thread the taxonomy never touched has no maintainer decision on it to
    // import, which is the only thing that sweep is for.
    alreadyDone: (thread) => {
      const decided = thread.labels.some((name) => names.has(name));
      return recording ? !decided : decided;
    },
    processOne: async (thread) => {
      const at = { ...context.repo, number: thread.number };
      const standing = standingFromListing(thread);

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
          // Write to the state branch when configured and both `record` and
          // `open-pr` are granted; otherwise fall back to the default branch.
          canRecordToBranch ? stateBranch : undefined,
        );
        // The self-training guard's own skip — machine-applied labels, or a
        // label history too long for this run to attribute — counted the same
        // way the idempotent skip above is, not added to the results table:
        // there is nothing this thread contributed to the store to show a row
        // for.
        if (outcome.machineOnly || outcome.unattributable) return null;
        return { number: thread.number, outcome: describeRecordOutcome(outcome) };
      }

      const outcome = await decide(authority, standing, settings, stages, weather);
      const done = settings.dryRun
        ? NOTHING_DONE
        : await act(
            createEffects(api, at),
            authority.warrant,
            outcome,
            api,
            at,
            settings.correctionsDir,
            stateBranch,
          );
      return { number: thread.number, outcome: describeOutcome(outcome, done) };
    },
  });
}

/**
 * `propose`'s own half of a sweep — a fact about the whole backlog, never
 * about one thread, so it runs once per sweep rather than inside
 * {@link runSweep}'s per-thread loop.
 *
 * Gated like every other capability: granted by the warrant's `duties:`
 * block and nothing else — the file is the whole authority, so there is no
 * second gate for `propose` to clear. A capacity error and an authentication
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
  const permitted = authority.warrant.granted("triage", DEFAULT_CAPABILITIES);
  if (!permitted.includes("propose")) return null;

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
  const cheap = parseModels(core.getInput("screen-models"), "screen-models");

  return {
    ...shared,
    screenModels: cheap.models,
    screenNames: cheap.names,
    warrant: core.getInput("warrant", { required: true }),
    confidence: fraction("confidence", core.getInput("confidence")),
    correctionsDir: core.getInput("corrections-dir", { required: true }),
    about: core.getInput("about"),
    minBodyChars: counted("min-body-chars", core.getInput("min-body-chars")),
    maxBodyChars: bounded("max-body-chars", core.getInput("max-body-chars")),
    sweepState: parseSweepState(core.getInput("sweep-state")),
    stateBranch: core.getInput("state-branch"),
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
  let statePr: number | null = null;

  try {
    const base = readSettings();
    const client = assembleClient(base, meter, ["detect", "screen", "triage", "pivot"] as const, [
      base.screenModels,
    ]);
    weather = client.weather;
    const api = getOctokit(base.token);
    const stages: Stages = client.stages;

    // The authority first, and before anything is spent.
    const { authority, denied } = await openAuthority(base.warrant, api, context.repo, "triage");

    // Only now, because whether the warrant answers this is the authority's to
    // decide — and once it does, `languages` is complete and `settings` can
    // become the object every stage below already expects. Except when the same
    // authority already denied this duty outright — that run is promised a
    // green no-op, and red-failing it over a `languages` nobody configured
    // would fail it over configuration it was never going to use.
    const languages = dutyLanguages(authority.warrant, denied, DEFAULT_LANGUAGES);

    // Same warrant-wins, input-falls-back pattern as `languages` above, on the
    // one field the spam screen reads and nothing else does.
    const about = resolveAbout(authority.warrant, base.about);

    // Guarded the same way `languages` is: a denied run is promised a green
    // no-op, and `labels` is configuration it was never going to use — a typo
    // in it has no business red-failing a run that could never have reached
    // the taxonomy anyway.
    const taxonomy = denied ? [] : resolveTaxonomy(authority.warrant, core.getInput("labels"));

    settings = {
      ...base,
      languages,
      about,
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

      // A written `duties:` block that does not name `triage` grants it
      // nothing, and no verdict this run could reach changes that — so this
      // sits here, as early as the answer is already certain, and before the
      // thread, the taxonomy check, or a single model call spends anything on
      // a decision that could never be applied.
      let outcome: Outcome | null = null;
      let recordOutcome: RecordOutcome | null = null;
      // Hoisted to this scope because it is also needed at the `act()` call
      // after the authority/trigger branches close (line ~778).
      const stateBranch = settings.stateBranch !== "" ? settings.stateBranch : undefined;
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
          // human, and only when the file grants it — the same single
          // authority every other capability goes through. Every other event,
          // or the capability simply not granted, is today's behaviour: a
          // verdict, not a recording.
          const trigger = recordTrigger();
          const grantedCapabilities = authority.warrant.granted("triage", DEFAULT_CAPABILITIES);
          const permitted = grantedCapabilities;

          // When state-branch is set, open-pr must also be granted — the
          // branch-write path opens a draft PR, and recording without it would
          // commit corrections to a branch that nobody is asked to review.
          let canRecordToBranch = false;
          if (stateBranch !== undefined) {
            canRecordToBranch = recordGrantedByRun(permitted) && permitted.includes("open-pr");
            if (recordGrantedByRun(permitted) && !permitted.includes("open-pr")) {
              core.notice(
                "triage: `state-branch` is set but `open-pr` is not granted. " +
                  "Corrections will be recorded to the default branch instead.",
              );
            }
          }

          // Ensure the state branch exists before any recording writes to it —
          // the Contents API's `branch` parameter fails if the ref does not
          // exist.
          if (canRecordToBranch && !settings.dryRun && stateBranch !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TrackerApi & ContentsApi does not structurally satisfy StateBranchApi (missing git, pulls)
            await ensureBranch(api as unknown as StateBranchApi, context.repo, stateBranch);
          }

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
                // Write to the state branch when configured and both `record`
                // and `open-pr` are granted; otherwise fall back to default.
                canRecordToBranch ? stateBranch : undefined,
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
              // Write to the state branch when configured and both `record`
              // and `open-pr` are granted; otherwise fall back to default.
              canRecordToBranch ? stateBranch : undefined,
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
              settings.correctionsDir,
              stateBranch,
            );
        single = { number, outcome, done };
      }
    }

    // Open or update the state-branch PR, now that all corrections have been
    // written to it. The PR wraps the branch's commits for maintainer review;
    // without it, corrections sit on the branch with nobody asked to merge.
    // This only fires when corrections were actually written to the branch —
    // the `open-pr` gate in `runSweep`/single-thread already ensured that
    // corrections land on the default branch when `open-pr` is not granted,
    // so there is nothing on the state branch to open a PR for.
    const branchForPr = settings.stateBranch !== "" ? settings.stateBranch : undefined;
    if (branchForPr !== undefined && !settings.dryRun) {
      // Re-check whether `open-pr` was permitted — the gate that decided
      // whether corrections went to the branch in the first place. When it
      // was not, corrections went to the default branch and there is no
      // branch PR to open.
      const prPermitted = authority.warrant
        .granted("triage", DEFAULT_CAPABILITIES)
        .includes("open-pr");

      const correctionsRecorded = settings.sweep
        ? bulk !== null && bulk.recording && bulk.results.length > 0
        : recorded !== null;

      if (prPermitted && correctionsRecorded) {
        try {
          const threadRef = settings.sweep
            ? "a bulk migration sweep"
            : `#${String((recorded as { readonly number: number }).number)}`;
          const prBody =
            "## triage corrections\n\n" + `Recorded corrections during ${threadRef}.\n\n`;
          const prTitle = "triage: corrections";
          const result = await publishStatePr(
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TrackerApi & ContentsApi does not structurally satisfy StateBranchApi (missing git, pulls)
            api as unknown as StateBranchApi,
            context.repo,
            branchForPr,
            prTitle,
            prBody,
            false,
          );
          if (result !== null) {
            statePr = result.pr;
            core.info(
              `triage: corrections written to \`${branchForPr}\`, PR #${String(result.pr)}`,
            );
          }
        } catch (error) {
          if (isCapacityError(error)) {
            core.warning(
              "triage: could not open state-branch PR — capacity error. " +
                "Corrections were written to the branch but no PR was opened.",
            );
          } else {
            throw error;
          }
        }
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
      const rosterStarved = warnIfStarved(settings.models, weather, settings.sweep);
      core.setOutput("state-pr", statePr !== null ? String(statePr) : "");

      if (settings.sweep && bulk !== null) {
        reportSweep(bulk, rosterStarved);
        await writeRunSummary(
          sweepPage(settings, bulk, meter.spent()) + proposeSection(proposeOutcome),
          weather,
        );
      } else if (!settings.sweep && recorded !== null) {
        reportRecordRun(recorded.outcome, rosterStarved);
        await writeRunSummary(
          recordPage(settings, recorded.number, recorded.outcome, meter.spent()),
          weather,
        );
      } else if (!settings.sweep && single !== null) {
        report(single.outcome, single.done, settings.dryRun, rosterStarved);
        await writeRunSummary(
          page(settings, single.number, single.outcome, single.done, meter.spent()),
          weather,
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

  const permitted = warrant.granted("triage", DEFAULT_CAPABILITIES);

  /** A run that stopped early: no verdict, and the guardrails still reported. */
  const stopped = (screened: Outcome["screenedOut"], language: string | null): Outcome => ({
    language,
    screenedOut: screened,
    verdict: NOTHING,
    applied: [],
    refused: [],
    permitted,
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

  const threadLanguage = detection.language;
  const pivotLanguage = pivotOrNone(warrant, settings.languages);

  const memory = await recallCorrections({
    count: warrant.memory?.recall ?? RECALLED,
    path: settings.correctionsDir,
    title: standing.title,
    body,
    language: threadLanguage,
    // A bridge is worth having whenever this run has a pivot language at all;
    // whether it is worth *buying* depends on the store, which `recall.ts`
    // checks. Triage does not exclude a thread already written in the pivot
    // language the way respond does — reconciling that is its own change.
    bridge:
      pivotLanguage === null
        ? null
        : {
            provider: stages.pivot,
            rosters: settings,
            title: standing.title,
            body,
            to: pivotLanguage,
            weather,
          },
  });

  const recalled = memory.corrections;
  const memorySize = memory.size;
  const pivotRecalled = memory.crossLanguage;

  if (memory.read) {
    core.info(
      `Recalled ${String(recalled.length)} of ${String(memorySize)} correction(s) ` +
        `from \`${settings.correctionsDir}\`` +
        (pivotRecalled > 0
          ? `, ${String(pivotRecalled)} of them recorded in a language other than the thread's.`
          : "."),
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

  if (triaged.verdict.labels.length === 0) {
    failIfRosterExhausted(settings.models, triaged.failures, settings.modelNames);
  }

  const verdict = triaged.verdict;
  const decided = {
    language,
    screenedOut: null,
    verdict,
    permitted,
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
    // Checked here rather than at apply time, so `labels` reports what this run
    // may do and a rehearsal rehearses the same gate a real run has.
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
 * repository mutation — a `duties:` block that does not grant `label`, and
 * `dry-run: true`, both mean "not this run," the same as they mean for every
 * other write this duty makes. Silent about neither: a denied or rehearsed
 * creation still says so, rather than looking like the taxonomy had nothing
 * missing.
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
    note: null,
    memory: { size: 0, recalled: 0, pivotRecalled: 0 },
    implicit: false,
    excludedLabels: [],
    ungranted:
      `\`${warrant.path}\`'s \`duties:\` block does not name \`triage\`; once that block ` +
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
 * checked here in code, after everything upstream (the model, `enforce`) has
 * already agreed a close would otherwise be allowed. A model's
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
  stateBranch?: string,
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
      stateBranch,
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

  // The rationale is model prose republished under the bot's own identity —
  // every mention and cross-reference it carries would notify and interlink a
  // second time, exactly what `sanitize` exists to stop (see its doc comment on
  // the published block as a repost). Sanitized on the way in, like every other
  // posting duty, so an injected "@alice, see #5 → GH-7" cannot ping a stranger
  // from a trusted automation account.
  if (outcome.verdict.rationale.length > 0) {
    parts.push("", `> ${sanitize(outcome.verdict.rationale)}`);
  }
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
