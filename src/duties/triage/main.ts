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
 */
import { isAbsolute, relative } from "node:path";

import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { readAtlas, type AtlasApi } from "../../core/atlas.js";
import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import { enforceLabels, narrow, owners, parseApply, type Refusal } from "../../core/enforce.js";
import {
  createEffects,
  createRepositoryLabel,
  isBotAuthor,
  isCapacityError,
  listCorrectionFiles,
  listLabelEvents,
  listOpenThreads,
  listRepositoryLabels,
  readContentsFile,
  readStanding,
  writeContentsFile,
  UnreadableContentsFile,
  type ContentsApi,
  type Effects,
  type Location,
  type Standing,
  type TrackerApi,
} from "../../core/forge.js";
import {
  bounded,
  counted,
  fraction,
  readShared,
  resolveEndpoints,
  type ApiKeySpec,
  type EndpointSpec,
} from "../../core/inputs.js";
import { type Language } from "../../core/languages.js";
import { isReeveProposalPr } from "../../core/marker.js";
import {
  createMemory,
  formatCorrection,
  parseCorrection,
  readStore,
  EXCERPT,
  type Correction,
  type WeightedQuery,
} from "../../core/memory.js";
import { createMeter, metered } from "../../core/meter.js";
import { translateToPivot } from "../../core/pivot.js";
import {
  createRoutedProvider,
  createWeather,
  parseModels,
  settleAuth,
  shown,
  starved,
  type Names,
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

import {
  summarize,
  summarizeRecord,
  summarizeSweep,
  type Done,
  type Run,
  type SweptThread,
} from "./summary.js";
import {
  report as buildProposeReport,
  proposeSection,
  runPropose,
  type ProposalsApi,
  type ProposeReport,
} from "./propose.js";
import { NOTHING, triage, type Verdict } from "./verdict.js";

/**
 * What this duty may do when the warrant says nothing about it.
 *
 * A label, and nothing else. It is the only effect that is one click to undo,
 * and the default belongs to the duty rather than to the warrant reader because
 * only this duty knows what its cheapest reversible action is.
 */
const DEFAULT_CAPABILITIES: readonly Capability[] = ["label"];

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

interface Settings {
  readonly token: string;
  /** The thread to work on, or null in `sweep`. */
  readonly number: number | null;
  readonly models: readonly string[];
  readonly modelNames: Names;
  /** The cheap roster. Empty turns the model-backed screen off, which is the default. */
  readonly screenModels: readonly string[];
  readonly screenNames: Names;
  readonly languages: readonly Language[];
  readonly warrant: string;
  /**
   * The subset of `warrant.labels` this run may propose — `labels`'s own
   * answer, in the warrant's order. The whole taxonomy when `labels` named
   * nothing. See `resolveTaxonomy`.
   */
  readonly taxonomy: readonly Label[];
  readonly apply: readonly Capability[];
  readonly confidence: number;
  readonly corrections: string;
  readonly about: string;
  readonly minBodyChars: number;
  /** `null` is no bound at all — see `bounded`'s doc comment for the sentinel rule. */
  readonly maxBodyChars: number | null;
  readonly dryRun: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly sweep: boolean;
  readonly since: Date | null;
  /** `null` is no ceiling at all — see `bounded`'s doc comment for the sentinel rule. */
  readonly limit: number | null;
  readonly endpoints: readonly EndpointSpec[];
  readonly apiKeys: readonly ApiKeySpec[];
  readonly requestTimeoutMs: number;
  readonly temperature: number | undefined;
  /**
   * Which resource state a sweep considers — a filter on what it fetches, not
   * a different mode of the duty. See `parseSweepState`.
   */
  readonly sweepState: SweepState;
}

/** `sweep-state`'s three spellings, as `parseSweepState` reads them. */
type SweepState = "open" | "closed" | "all";
const SWEEP_STATES: readonly SweepState[] = ["open", "closed", "all"];

/**
 * Which resource state a sweep considers.
 *
 * A resource filter, not a mode: it changes what `listOpenThreads` fetches,
 * nothing about how a fetched thread is decided. `open` is the default and
 * the ordinary case — a sweep keeping a fresh backlog triaged. `closed` and
 * `all` exist for the case this duty's `record` capability makes possible
 * when it composes with `sweep`: a one-time bulk migration that imports a
 * project's already-decided history — including threads a maintainer closed
 * long before this action existed — into the corrections store in one run,
 * rather than one label event at a time from here on.
 */
function parseSweepState(raw: string): SweepState {
  const value = raw.trim().toLowerCase();
  const match = SWEEP_STATES.find((state) => state === value);
  if (match === undefined) {
    throw new Error(`sweep-state: expected one of ${SWEEP_STATES.join(", ")}, got \`${raw}\`.`);
  }
  return match;
}

/**
 * `labels`, narrowed against the warrant's own taxonomy — in the warrant's
 * order, because that order is what breaks a tie between two proposals, not
 * the input's.
 *
 * Empty is the whole taxonomy, unchanged: a monorepo with one area per
 * directory and one shared `.github/reeve.yml` points every area's workflow
 * at the same file and uses this to keep each one proposing only the labels
 * its own area owns, without maintaining a taxonomy file per area. A name
 * this asks for that the file does not have is refused rather than quietly
 * dropped — a typo here would otherwise triage forever with one label
 * missing from the roster and nothing saying so.
 */
function resolveTaxonomy(warrant: Warrant, raw: string): readonly Label[] {
  const requested = raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (requested.length === 0) return warrant.labels;

  for (const name of requested) {
    if (warrant.labelNamed(name) === undefined) {
      throw new Error(
        `labels: \`${name}\` is not in \`${warrant.path}\`'s taxonomy. ` +
          "Add it there, or correct the name.",
      );
    }
  }
  const wanted = new Set(requested);
  return warrant.labels.filter((label) => wanted.has(label.name));
}

/** `settings.taxonomy`'s own names, for the places that check membership rather than shape. */
function taxonomyNames(settings: Settings): ReadonlySet<string> {
  return new Set(settings.taxonomy.map((label) => label.name));
}

/**
 * Everything but `languages` and `taxonomy`, neither of which can be read
 * here: both need the warrant, and `readWarrant`'s own result is only
 * available once `resolveAuthority` has answered, while every other input
 * here is not async at all. `run` completes the object once it has.
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

/**
 * One provider per stage, each counting its own requests.
 *
 * The split is the cost argument made legible: `screen` is the cheap roster and
 * `triage` is the expensive one, and a maintainer deciding whether the cheap
 * pass is earning its keep needs those as two rows rather than one.
 */
interface Stages {
  readonly detect: Provider;
  readonly screen: Provider;
  readonly triage: Provider;
  /** The roster that translates into the pivot language, for `record` and for cross-language recall. */
  readonly pivot: Provider;
}

/** Everything the run concluded, whatever path it took to conclude it. */
interface Outcome {
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

/** What a run that touched nothing did. Also what every dry run reports. */
const NOTHING_DONE: Done = { labels: [], commented: false, assigned: [], closed: false };

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
interface SweepAccumulator {
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
 * mode uses at its own branch point (`permitted.includes("record")`) is made
 * once here, for the whole run: granted, every candidate is recorded as
 * bulk-migrated history; not granted, every candidate is triaged, exactly as
 * before this capability existed.
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
  const recording = permitted.includes("record");
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
        : await act(createEffects(api, at), authority.warrant, outcome);
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

/** One sweep row's outcome under bulk migration, in the fewest words that are true. */
function describeRecordOutcome(outcome: RecordOutcome): string {
  return outcome.decided.length > 0
    ? `recorded as ${outcome.decided.map((name) => `\`${name}\``).join(", ")}`
    : "recorded with no taxonomy labels";
}

/** Candidates neither processed nor skipped — what a next sweep still has to look at. */
function remainingOf(acc: SweepAccumulator): number {
  return Math.max(acc.candidates - acc.results.length - acc.skipped, 0);
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
    weather = createWeather(new Set(base.endpoints.map((endpoint) => endpoint.alias)), [
      ...base.models,
      ...base.screenModels,
    ]);
    const api = getOctokit(base.token);
    const provider = createRoutedProvider(resolveEndpoints(base));

    const stages: Stages = {
      detect: metered(provider, meter, "detect"),
      screen: metered(provider, meter, "screen"),
      triage: metered(provider, meter, "triage"),
      pivot: metered(provider, meter, "pivot"),
    };

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
          // `record` takes a labelled/unlabelled event, from a human, and only
          // when both the file and the workflow's `apply` grant it — the same
          // narrowing every other capability goes through. Every other event,
          // or the capability simply not granted, is today's behaviour: a
          // verdict, not a recording.
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

          // The asymmetric half of the same double-gate: `withheld` (used inside
          // `decide` below) only ever names what `apply` asked for and the file
          // refused, because that is the direction a run takes without saying so
          // otherwise. This is the other direction — the file grants `record`,
          // `apply` simply never names it, `apply` defaults to `label` alone — and
          // without this notice a maintainer who granted `record` in the file and
          // stopped there gets a silent full re-triage on every label change
          // instead of the recording they configured, with nothing in the log
          // explaining why.
          if (
            trigger.eligible &&
            grantedCapabilities.includes("record") &&
            !permitted.includes("record")
          ) {
            core.notice(
              `\`${authority.warrant.path}\` grants \`record\`, but \`apply\` does not name it, ` +
                "so this labelled/unlabelled event was triaged instead of recorded. The narrower " +
                "of the two wins — add `record` to `apply` as well to record it instead.",
            );
          }

          // The other silent branch of the same gate — but only for the one
          // ineligible case worth a maintainer's attention: `record` is fully
          // granted, the event was the labelled/unlabelled kind it fires on,
          // and it still did not run because the sender was refused (a bot).
          // A workflow that also runs on `opened` or a `push` is not
          // misconfigured on those legs — `trigger.reason` is empty for both,
          // deliberately, so this stays silent there.
          if (trigger.reason !== "" && permitted.includes("record")) {
            core.info(`\`record\` is granted, but did not fire this run: ${trigger.reason}.`);
          }

          // `propose` needs the whole backlog picture a sweep holds — an
          // event-triggered run granted it does nothing but say so, the same
          // shape as the two notices above.
          noticeProposeSweepOnly(authority);

          if (trigger.eligible && permitted.includes("record")) {
            recordOutcome = await recordCorrection(
              api,
              at,
              standing,
              authority,
              settings,
              stages,
              weather,
              senderLogin(),
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
          : await act(createEffects(api, at), authority.warrant, outcome);
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
      settings.temperature,
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
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
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
        ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
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
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
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
 * Whether the event that triggered this run is one `record` fires on, and —
 * for the one case worth saying anything about — why not.
 *
 * `labeled`/`unlabeled` on `issues`, from a human. Not `opened`, not
 * `edited`, not a re-triage — `record` never re-triages, it takes a label
 * change as a maintainer's word for what a thread is and writes that down.
 * And not a bot: a label another automation applied is not a correction, and
 * recording it would teach recall a category no maintainer ever chose.
 */
interface RecordTrigger {
  readonly eligible: boolean;
  /**
   * Why the sender disqualified an otherwise-eligible event — empty on every
   * other path, including the one that fires and the two that were never
   * going to: the wrong event entirely, or an `issues` action besides
   * `labeled`/`unlabeled`. Those two are not worth a maintainer's attention
   * — a workflow granting `record` that also runs on `opened` or a `push` is
   * not misconfigured, that leg was simply never going to record — so only
   * this one case, a human-shaped label event that turned out to come from a
   * bot, is the reason anything gets logged over.
   */
  readonly reason: string;
}

function recordTrigger(): RecordTrigger {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "issues") return { eligible: false, reason: "" };

  const payload = context.payload as {
    action?: string;
    sender?: { login?: string; type?: string };
  };
  if (payload.action !== "labeled" && payload.action !== "unlabeled") {
    return { eligible: false, reason: "" };
  }

  if (isBotAuthor(payload.sender)) {
    return { eligible: false, reason: "the label change came from a bot" };
  }

  return { eligible: true, reason: "" };
}

/** The human who made the label change this run is recording — a handle, without the `@`. */
function senderLogin(): string {
  const payload = context.payload as { sender?: { login?: string } };
  return payload.sender?.login ?? "";
}

/** What a `record` run concluded — a mirror of `Outcome`, sized for the much smaller pipeline it took. */
interface RecordOutcome {
  readonly recorded: boolean;
  readonly language: string | null;
  readonly decided: readonly string[];
  readonly pivot: boolean;
  /** Why a pivot rendering was not produced, when one was attempted and it was not. */
  readonly pivotNote: string | null;
  /**
   * Set when a migration sweep found every taxonomy label on this thread
   * machine-applied — see `recordCorrection`'s guard. `recorded` is `false`
   * alongside it: nothing here was a maintainer's own decision, so nothing
   * was written. Never set outside a migration sweep.
   */
  readonly machineOnly: boolean;
  /**
   * Set when a migration sweep could not read this thread's whole label
   * history — `listLabelEvents` hit its page ceiling with the last page
   * still full. `recorded` is `false` alongside it, the same fail-closed
   * choice as `machineOnly`: a label with no event this run could see is not
   * proof a human applied it, only proof this run stopped reading before it
   * got there, and importing it as a maintainer's correction on that basis
   * would be exactly the self-training loop the guard exists to prevent.
   * Never set outside a migration sweep.
   */
  readonly unattributable: boolean;
}

/**
 * Records the current state of a thread as a correction — the taxonomy-
 * filtered labels standing on it now, its title and body, its language —
 * rather than asking for a fresh verdict. `record` never re-triages: a label
 * event already carries the maintainer's decision, and asking a model to
 * reproduce it would be asking it to guess at something already known.
 *
 * `dry-run` runs every step below except the commit itself, so the log and
 * the `recorded` output both say what a real run would have done.
 *
 * `by` is who this correction is attributed to — the human who changed the
 * label on a single-thread run, or the literal `"sweep"` when this is bulk
 * migration composing `record` with `sweep`: there is no one sender to name
 * for a thread nobody just relabelled, only a run that decided to import what
 * was already decided.
 *
 * **Bulk migration guards against training on its own past output.** A
 * migration sweep imports whatever labels stand on a thread as though they
 * were a maintainer's correction — but months of ordinary triage sweeps
 * running with `apply: label` leave plenty of threads carrying labels this
 * duty applied itself, not a maintainer. Importing those is a self-training
 * loop, not history: this run's own old verdicts, re-taught back to it as
 * ground truth. `by === "sweep"` is the one path this can happen on — a
 * single-thread run is always triggered by a human's own label change, and
 * has nothing to distrust — and there alone, each candidate taxonomy label is
 * checked against its most recent `labeled` event; one whose actor is a bot
 * is excluded. A thread left with nothing decidable is not recorded at all.
 *
 * The guard fails closed on a thread whose label history is longer than one
 * run reads, too: `listLabelEvents` reports `complete: false` when it hit its
 * own page ceiling without reaching the start of the timeline, and a label
 * with no event in what this run did see is not proof a human applied it —
 * only proof the read stopped before it got there. Nothing is imported from
 * that thread this run rather than guess.
 */
async function recordCorrection(
  api: TrackerApi & ContentsApi,
  at: Location,
  standing: Standing,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
  by: string,
): Promise<RecordOutcome> {
  const warrant = authority.warrant;

  // Taxonomy-filtered against `settings.taxonomy`, not the whole warrant: a
  // label some other tool or automation applied is not a maintainer
  // correcting this duty's taxonomy, and neither is a label from another
  // area's slice of a shared file this run's own `labels` never named —
  // recording either would teach recall a category this run was never asked
  // to propose.
  let decidedLabels = standing.labels.filter((name) => taxonomyNames(settings).has(name));

  if (by === "sweep" && decidedLabels.length > 0) {
    const history = await listLabelEvents(api, at);

    if (!history.complete) {
      core.info(
        `#${String(at.number)}: label history is longer than one run reads — cannot attribute, ` +
          "nothing imported.",
      );
      return {
        recorded: false,
        language: null,
        decided: [],
        pivot: false,
        pivotNote: null,
        machineOnly: false,
        unattributable: true,
      };
    }

    // Oldest first, so the last write into this map for a given label is its
    // most recent `labeled` event — exactly the one the guard cares about.
    const lastLabeledByBot = new Map<string, boolean>();
    for (const event of history.events) {
      if (event.action === "labeled") lastLabeledByBot.set(event.label, event.isBot);
    }
    decidedLabels = decidedLabels.filter((name) => !(lastLabeledByBot.get(name) ?? false));

    if (decidedLabels.length === 0) {
      core.info(
        `#${String(at.number)}: every taxonomy label here was machine-applied — nothing to import.`,
      );
      return {
        recorded: false,
        language: null,
        decided: [],
        pivot: false,
        pivotNote: null,
        machineOnly: true,
        unattributable: false,
      };
    }
  }

  const limit = settings.maxBodyChars;
  const body = limit === null ? standing.body : standing.body.slice(0, limit);

  const detection = await detectLanguage(
    body.length === 0 ? standing.title : body,
    settings.languages,
    createLanguagePicker(
      stages.detect,
      settings.screenModels.length > 0 ? settings.screenModels : settings.models,
      weather,
      settings.temperature,
    ),
  );
  // The code, because that is what the store and the pivot comparison below
  // both compare against — the same convention `decide`'s recall path reads
  // corrections by. The output-facing `language` a maintainer reads on this
  // run's page is a different value, further down: the same label the
  // ordinary `decide` path reports, so a workflow reading this action's
  // `language` output sees the same shape whichever path produced it.
  const code = detection.language?.code ?? null;

  const pivotLanguage =
    settings.languages.length > 0 ? resolvePivot(warrant, settings.languages) : null;
  let pivot: Correction["pivot"] = null;
  let pivotNote: string | null = null;
  if (pivotLanguage !== null && code !== null && code !== pivotLanguage.code) {
    const pivotModels = settings.screenModels.length > 0 ? settings.screenModels : settings.models;
    const pivotNames =
      settings.screenModels.length > 0 ? settings.screenNames : settings.modelNames;
    const rendered = await translateToPivot({
      provider: stages.pivot,
      models: pivotModels,
      title: standing.title,
      body,
      to: pivotLanguage,
      weather,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    });
    for (const failure of rendered.failures) {
      core.warning(`record: ${shown(pivotNames, failure.model)} — ${failure.reason}`);
    }
    if (rendered.draft !== null) {
      pivot = {
        language: pivotLanguage.code,
        title: rendered.draft.title,
        excerpt: rendered.draft.body.slice(0, EXCERPT),
      };
    } else {
      // Weather, not a broken configuration — the write below still happens.
      // A correction without a pivot rendering is still a correction; a run
      // that refused to record over a starved translation would be trading a
      // sure thing for a nice-to-have.
      pivotNote =
        "A pivot-language rendering could not be produced this run, so the correction was " +
        "recorded without one.";
      core.info(pivotNote);
    }
  }

  const correction: Correction = {
    repo: `${at.owner}/${at.repo}`,
    thread: at.number,
    at: new Date().toISOString(),
    title: standing.title,
    excerpt: body.slice(0, EXCERPT),
    language: code,
    proposed: [],
    decided: decidedLabels,
    by,
    note: null,
    pivot,
  };

  if (settings.dryRun) {
    core.info(
      `Would record #${String(at.number)} as ` +
        (decidedLabels.length > 0 ? decidedLabels.join(", ") : "no labels") +
        `${pivot !== null ? ", with a pivot rendering" : ""} — dry run, nothing committed.`,
    );
  } else {
    await writeCorrection(api, at, settings.corrections, correction);
  }

  return {
    recorded: true,
    language: detection.language?.label ?? null,
    decided: decidedLabels,
    pivot: pivot !== null,
    pivotNote,
    machineOnly: false,
    unattributable: false,
  };
}

/**
 * How many times a record write may retry after losing a race on a shard's
 * `sha` — the read-modify-write sequence run again from the top, not just the
 * final write, because a concurrent commit can have changed which shard holds
 * this thread as easily as it changed one shard's contents.
 */
const WRITE_ATTEMPTS = 3;

/**
 * Commits `correction` to the store at `path` — replacing the line for this
 * thread wherever it already lives, appending a fresh one when it does not.
 *
 * No checkout, no git binary: every shard already committed is read through
 * the Contents API to look for an existing entry for this thread, the same
 * way a maintainer opening the store by hand would look — one file at a time,
 * because there is no index to consult instead. `contents: write` is what
 * this needs on the token, and its absence is left to fail the way any other
 * authentication problem does: loud, and uncaught.
 *
 * Two record runs racing the same shard is the one failure this retries: the
 * Contents API answers a stale `sha` with a conflict, and re-reading before
 * trying again is the whole fix, because the second run's write was computed
 * against a version of the file that no longer exists. Every other failure —
 * a missing scope, a network error, anything that is not that specific
 * conflict — propagates on the first attempt, the same as it always did.
 */
async function writeCorrection(
  contentsApi: ContentsApi,
  at: Location,
  path: string,
  correction: Correction,
): Promise<void> {
  const relativePath = repoRelativePath(path);

  for (let attempt = 1; ; attempt += 1) {
    try {
      await attemptWrite(contentsApi, at, relativePath, correction);
      return;
    } catch (error) {
      if (attempt >= WRITE_ATTEMPTS || !isShaConflict(error)) throw error;
      core.info(
        `Recording #${String(correction.thread)} lost a race on the store — another commit ` +
          `landed first. Retrying (attempt ${String(attempt + 1)} of ${String(WRITE_ATTEMPTS)}).`,
      );
    }
  }
}

/**
 * One read-modify-write pass, the unit `writeCorrection` retries whole on a
 * conflict.
 *
 * A shard too large for the Contents API to inline (`UnreadableContentsFile`)
 * does not fail the write outright — it is skipped, warned about by name, and
 * the search continues through the rest of the store, so one oversized shard
 * does not brick every recording from now on. What it does refuse is
 * appending: if the thread's existing entry, if it has one, might be sitting
 * in exactly the shard this run could not read, appending a fresh line
 * elsewhere cannot be told apart from silently duplicating it — so that path
 * throws instead, naming the shard that made the answer unknowable.
 */
async function attemptWrite(
  contentsApi: ContentsApi,
  at: Location,
  path: string,
  correction: Correction,
): Promise<void> {
  const files = await listCorrectionFiles(contentsApi, at, path);
  const unreadable: string[] = [];

  // The walk stops the moment a line carrying this exact (repo, thread) pair
  // turns up: nothing later in the store can change what an explicit match
  // means, so the shards past it are never read at all — the common case, a
  // repeat correction on a thread already recorded, costs the reads it takes
  // to find the line and not one more. Only a write that finds no explicit
  // match anywhere has, by then, necessarily read the whole store — which is
  // exactly the knowledge the loose rule below needs, gathered as a
  // side-effect of the search rather than as an extra pass. And no shard is
  // retained past its own visit except the single candidate line the loose
  // rule might still rewrite, so a store of many large shards is never held
  // in memory whole.
  //
  // The loose rule: `repo` as well as `thread` — the dedup key widened to
  // the pair once a store could hold more than one repository's history. A
  // line written before that field existed parses as `repo: ""`, and in a
  // store that has only ever recorded for today's repo, a stored empty repo
  // can only mean "written before this field existed" — read as this thread
  // number's own legacy entry, and rewritten in place with today's repo on
  // it. That is what lets a single-repo store self-migrate: the first write
  // a thread sees after the field shipped leaves nothing legacy to match
  // loosely the next time.
  //
  // A store that also carries a *different* explicit repo — the whole reason
  // `repo` exists — cannot make that same assumption: an empty-repo line for
  // this thread number could belong to that other repository's own history
  // from before it, too, recorded when both repositories shared this store
  // and neither had `repo` yet. Matching it loosely there would let today's
  // repo silently steal another repository's legacy entry whenever their
  // thread numbers happened to collide. A shard this run could not read
  // leaves that unknowable the same way a foreign repo would, and so does a
  // line this run could not parse — garbage proves nothing about whose
  // history it was, so it counts against the loose match rather than for
  // it. In every such case the legacy line is left alone and a fresh line
  // is appended below with `correction.repo` explicit — the widened key's
  // ordinary semantics, and nothing lost.
  let provenShared = false;
  let legacyCandidate: {
    readonly path: string;
    readonly lines: string[];
    readonly sha: string;
    readonly index: number;
  } | null = null;

  for (const file of files) {
    let read: { readonly text: string; readonly sha: string } | null;
    try {
      read = await readContentsFile(contentsApi, at, file.path);
    } catch (error) {
      if (!(error instanceof UnreadableContentsFile)) throw error;
      core.warning(
        `corrections: \`${file.path}\` could not be read, so it was skipped rather than ` +
          "failing the whole write — the search continued through the rest of the store. " +
          "Split the corrections store into smaller shards.",
      );
      unreadable.push(file.path);
      continue;
    }
    if (read === null) continue;
    const lines = read.text.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) continue;
      const existing = parseCorrection(line);
      if (existing === null) {
        provenShared = true;
        continue;
      }
      if (existing.thread === correction.thread && existing.repo === correction.repo) {
        const updated = [...lines];
        updated[index] = formatCorrection(correction);
        await writeContentsFile(
          contentsApi,
          at,
          file.path,
          `${updated.join("\n").replace(/\n*$/, "")}\n`,
          commitMessage(correction),
          read.sha,
        );
        return;
      }
      if (existing.repo !== "" && existing.repo !== correction.repo) provenShared = true;
      if (
        existing.repo === "" &&
        existing.thread === correction.thread &&
        legacyCandidate === null
      ) {
        legacyCandidate = { path: file.path, lines, sha: read.sha, index };
      }
    }
  }

  if (legacyCandidate !== null && !provenShared && unreadable.length === 0) {
    const lines = [...legacyCandidate.lines];
    lines[legacyCandidate.index] = formatCorrection(correction);
    await writeContentsFile(
      contentsApi,
      at,
      legacyCandidate.path,
      `${lines.join("\n").replace(/\n*$/, "")}\n`,
      commitMessage(correction),
      legacyCandidate.sha,
    );
    return;
  }

  if (unreadable.length > 0) {
    throw new Error(
      `#${String(correction.thread)} was not found in any shard this run could read, and ` +
        `${unreadable.map((shard) => `\`${shard}\``).join(", ")} could not be read at all. ` +
        "Appending a fresh entry cannot rule out duplicating one already sitting in the shard " +
        "this run could not see, so nothing was written — split the corrections store into " +
        "smaller shards.",
    );
  }

  // Not found in any existing shard: append to this month's, the same
  // sharding a store filled in by hand already uses — small enough that two
  // maintainers correcting different threads the same week append to the same
  // file and git resolves it, rather than every correction becoming a
  // conflict on one file that never rolls over.
  const { shard, existing } = await selectShard(contentsApi, at, path);
  const text =
    existing === null
      ? `${formatCorrection(correction)}\n`
      : `${existing.text.replace(/\n*$/, "")}\n${formatCorrection(correction)}\n`;
  await writeContentsFile(
    contentsApi,
    at,
    shard,
    text,
    commitMessage(correction),
    existing?.sha ?? null,
  );
}

/**
 * A soft ceiling on one shard's own size, not a hard one — the Contents API's
 * real limit is the 1 MB `readContentsFile` already treats as unreadable, and
 * this is well under it on purpose, so a shard rolls over while it can still
 * be read and written normally rather than only once it has already crossed
 * into `UnreadableContentsFile` territory.
 */
const SHARD_SOFT_LIMIT_BYTES = 900_000;

/**
 * How many numbered siblings one calendar month's shard may grow before this
 * gives up — not a real ceiling on how much a project may record, only a
 * bound on the loop below, because a bounded loop is one that cannot hang a
 * run over a store that has gone genuinely, unexpectedly enormous.
 */
const MAX_SHARD_ATTEMPTS = 500;

/**
 * This month's shard, and whatever is already in it — `monthShard().ndjson`
 * for the first correction of the month, `monthShard().2.ndjson` once that
 * one has grown past `SHARD_SOFT_LIMIT_BYTES`, and so on. Read once per
 * candidate rather than sized off a directory listing, because size is a
 * property of a shard's own content, not of its name.
 *
 * Rolling over by size rather than only by month keeps `writeCorrection`'s
 * read-modify-write pass — and `attemptWrite`'s search before it — working
 * against files small enough for the Contents API to inline, on a project
 * recording enough corrections that one calendar month would otherwise grow
 * past that on its own.
 */
async function selectShard(
  contentsApi: ContentsApi,
  at: Location,
  path: string,
): Promise<{
  readonly shard: string;
  readonly existing: { readonly text: string; readonly sha: string } | null;
}> {
  const base = `${path.replace(/\/+$/, "")}/${monthShard()}`;

  for (let n = 1; n <= MAX_SHARD_ATTEMPTS; n += 1) {
    const shard = n === 1 ? `${base}.ndjson` : `${base}.${String(n)}.ndjson`;
    let existing: { readonly text: string; readonly sha: string } | null;
    try {
      existing = await readContentsFile(contentsApi, at, shard);
    } catch (error) {
      // Unreadable — over the 1 MB the Contents API can inline — is read the
      // same way `attemptWrite`'s own search treats it: not proof the shard
      // is full, but not a shard this run can safely append to either, so
      // the roll-over moves past it exactly as it would past one merely over
      // the soft limit.
      if (!(error instanceof UnreadableContentsFile)) throw error;
      core.warning(
        `corrections: \`${shard}\` could not be read, so a fresh correction rolls over to the ` +
          "next shard instead. Split the corrections store into smaller shards.",
      );
      continue;
    }
    if (existing === null || Buffer.byteLength(existing.text, "utf8") < SHARD_SOFT_LIMIT_BYTES) {
      return { shard, existing };
    }
  }

  throw new Error(
    `corrections: this month's store has grown past ${String(MAX_SHARD_ATTEMPTS)} shards, ` +
      `every one of them already at or past the ${String(SHARD_SOFT_LIMIT_BYTES)}-byte soft ` +
      "limit. That is almost certainly a runaway write loop rather than a genuinely enormous " +
      "month, so this stops here rather than trying a shard 501.",
  );
}

/**
 * Whether `error` is the Contents API's way of saying this write's `sha` is
 * already stale — a 409 always means that, and a 422 means it only when the
 * message names the `sha` field, the same distinction GitHub itself draws
 * between "this ref changed under you" and "this request is simply malformed".
 */
function isShaConflict(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 409) return true;
  if (status !== 422) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("sha");
}

/**
 * `path`, guaranteed repo-relative before it reaches the Contents API.
 *
 * Recall reads the store straight off disk, where an absolute path resolves
 * the same as a relative one — but record sends this path to the Contents
 * API, which only understands one relative to the repository root. A
 * workflow built with `${{ github.workspace }}` produces exactly this
 * absolute-but-still-inside-the-checkout shape, so that one case is stripped
 * back to relative rather than refused; any other absolute path names
 * somewhere the API cannot express at all, and is rejected rather than
 * half-handled.
 */
function repoRelativePath(path: string): string {
  if (!isAbsolute(path)) return path;

  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace !== undefined && workspace.length > 0) {
    const stripped = relative(workspace, path);
    if (!isAbsolute(stripped) && !stripped.startsWith("..")) return stripped;
  }

  throw new Error(
    `\`corrections\` (\`${path}\`) is an absolute path record cannot use — the Contents API only ` +
      "understands a path relative to the repository root. Use a repo-relative path, or one " +
      "under `GITHUB_WORKSPACE` if the workflow built it from `${{ github.workspace }}`.",
  );
}

/** This run's shard name — the store rolls over by calendar month. */
function monthShard(): string {
  const now = new Date();
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The commit message a recorded correction lands with. House voice: plain about what changed. */
function commitMessage(correction: Correction): string {
  const decided = correction.decided.length > 0 ? correction.decided.join(", ") : "no labels";
  return `memory: record #${String(correction.thread)} as ${decided}`;
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
 */
async function act(effects: Effects, warrant: Warrant, outcome: Outcome): Promise<Done> {
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
    await effects.closeAsNotPlanned();
    closed = true;
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

/**
 * Every output, written on every path that reaches an answer — including the
 * ones that answer "nothing". A workflow branching on `screened-out` needs it to
 * be an empty string rather than an unset output on the run where everything
 * worked.
 */
function report(outcome: Outcome, done: Done, dryRun: boolean, rosterStarved: boolean): void {
  core.setOutput("labels", JSON.stringify(outcome.applied));
  core.setOutput("proposed", JSON.stringify(outcome.verdict.labels));
  core.setOutput("confidence", outcome.verdict.confidence.toFixed(2));
  core.setOutput("language", outcome.language ?? "");
  core.setOutput(
    "duplicate-of",
    outcome.verdict.duplicateOf === null ? "" : String(outcome.verdict.duplicateOf),
  );
  core.setOutput("screened-out", outcome.screenedOut?.reason ?? "");
  // Empty under a rehearsal, which is how a workflow tells one from a run: `{}`
  // is a shape no real run produces, because a real run always reports all four
  // keys whether or not it did anything with them.
  core.setOutput("applied", dryRun ? "{}" : JSON.stringify(done));
  core.setOutput("starved", String(rosterStarved));
  // `0`, not unset: `processed`/`skipped`/`remaining` are a sweep's own
  // outputs, and a single-thread run answers all three honestly at zero rather
  // than leaving a workflow that reads them on every run reading an empty
  // string on this one.
  core.setOutput("processed", "0");
  core.setOutput("skipped", "0");
  core.setOutput("remaining", "0");
  // `false` here always: this is the ordinary decide/act pipeline, which
  // never writes to the corrections store. `recorded` only ever reads `true`
  // from the dedicated record path below.
  core.setOutput("recorded", "false");
}

/**
 * `processed`, `skipped` and `remaining` — a sweep's own outputs, distinct
 * from every output above because none of those name one thread. `starved` is
 * shared vocabulary between the two modes, so it keeps the same name here.
 */
function reportSweep(bulk: SweepAccumulator, rosterStarved: boolean): void {
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("skipped", String(bulk.skipped));
  core.setOutput("remaining", String(remainingOf(bulk)));
  core.setOutput("starved", String(rosterStarved));
  // `true` only for bulk migration — `record` composed with `sweep`, decided
  // once for the whole run and carried on the accumulator. An ordinary
  // triaging sweep never records, the same as it always did.
  core.setOutput("recorded", String(bulk.recording));
}

/**
 * Every output, on a `record` run — the full contract every path answers, so
 * a workflow that reads `labels` or `confidence` on every run of this action
 * finds the neutral values a run that never triaged actually produced, rather
 * than an output some other path simply never set.
 */
function reportRecordRun(outcome: RecordOutcome, rosterStarved: boolean): void {
  core.setOutput("labels", JSON.stringify([]));
  core.setOutput("proposed", JSON.stringify([]));
  core.setOutput("confidence", "0.00");
  core.setOutput("language", outcome.language ?? "");
  core.setOutput("duplicate-of", "");
  core.setOutput("screened-out", "");
  core.setOutput("applied", JSON.stringify(NOTHING_DONE));
  core.setOutput("starved", String(rosterStarved));
  core.setOutput("processed", "0");
  core.setOutput("skipped", "0");
  core.setOutput("remaining", "0");
  core.setOutput("recorded", String(outcome.recorded));
}

function page(
  settings: Settings,
  thread: number,
  outcome: Outcome,
  done: Done,
  spent: Run["spent"],
): string {
  return summarize({
    thread,
    dryRun: settings.dryRun,
    warrant: settings.warrant,
    language: outcome.language,
    screenedOut: outcome.screenedOut,
    proposed: outcome.verdict.labels,
    confidence: outcome.verdict.confidence,
    floor: settings.confidence,
    applied: outcome.applied,
    refused: outcome.refused,
    duplicateOf: outcome.verdict.duplicateOf,
    permitted: outcome.permitted,
    withheld: outcome.withheld,
    done,
    memory: outcome.memory,
    note: outcome.note,
    implicit: outcome.implicit,
    excludedLabels: outcome.excludedLabels,
    ungranted: outcome.ungranted,
    spent,
    modelNames: settings.modelNames,
    screenNames: settings.screenNames,
  });
}

function recordPage(
  settings: Settings,
  thread: number,
  outcome: RecordOutcome,
  spent: Run["spent"],
): string {
  return summarizeRecord({
    thread,
    dryRun: settings.dryRun,
    recorded: outcome.recorded,
    language: outcome.language,
    decided: outcome.decided,
    pivot: outcome.pivot,
    pivotNote: outcome.pivotNote,
    corrections: settings.corrections,
    spent,
    modelNames: settings.modelNames,
    screenNames: settings.screenNames,
  });
}

function sweepPage(settings: Settings, bulk: SweepAccumulator, spent: Run["spent"]): string {
  return summarizeSweep({
    dryRun: settings.dryRun,
    warrant: settings.warrant,
    results: bulk.results,
    skipped: bulk.skipped,
    remaining: remainingOf(bulk),
    starvedRun: bulk.starvedRun,
    ungranted: bulk.ungranted,
    recording: bulk.recording,
    spent,
    modelNames: settings.modelNames,
    screenNames: settings.screenNames,
  });
}

await run();
