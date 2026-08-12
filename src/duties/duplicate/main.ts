/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * This duty's pipeline is shorter than triage's, and the shape of the
 * shortness is the point: there is exactly one question in front of every
 * thread — "does an open thread already describe this" — so there is no
 * taxonomy to check names against and no second capability that follows from
 * the first the way `assign` follows a label. What is left:
 *
 *   1. **Read.** The warrant — or the implicit one, built from this
 *      repository's own label descriptions, when the file is simply absent at
 *      the default path.
 *   1a. **Stop, for a block that said nothing about this duty.** A written
 *      `capabilities:` block that does not name `duplicate` grants it nothing,
 *      and no verdict downstream changes that — so a single-thread run stops
 *      before the thread is even fetched, and a sweep stops before it lists
 *      the backlog. See `notGranted` for the full argument, which is the same
 *      one `triage/main.ts` makes.
 *   2. **Language.** Script, then profile, then — only if neither decided — a
 *      model. The judge is told what it is reading rather than left to infer
 *      it.
 *   3. **Corpus.** Every open thread `corpus-limit`/`corpus-since` allow,
 *      through `./corpus.ts`'s own listing — deliberately not
 *      `listOpenThreads`, whose newest-created-first order serves a sweep's
 *      work budget rather than an index a maintainer configured.
 *   4. **Bridge, when it is worth a request.** Cross-language matching only
 *      helps when the corpus actually holds a thread in another language, and
 *      that is a fact `detectLanguage` can check on every candidate for free —
 *      no `pick` argument, so it never reaches a model. Only once that free
 *      pass finds a candidate the thread's own language would never match is
 *      `translateToPivot` worth spending on, and even then a failure there
 *      degrades to same-language matching rather than blocking the run.
 *   5. **Rank.** BM25 over the corpus, `candidates` deep, closest first.
 *   6. **Judge.** The expensive roster, asked whether the top candidate is
 *      genuinely the same problem — a judged question, not a lexical one.
 *   7. **Verify.** The confidence floor, in code, never against the model's
 *      own account of how sure it was.
 *   8. **Apply.** Only `comment`, only when both the file and `apply` grant
 *      it, and only as a find-and-replace under this duty's own marker —
 *      never a second opinion stacked under the first.
 *
 * **The failure mode of this duty is doing nothing.** No candidate in the
 * corpus, every model failing, a verdict that does not parse, a verdict under
 * the floor and a `capabilities:` block that does not name `duplicate` are
 * all green runs that proposed nothing and said why. `duplicate-of` and
 * `score` still answer on every path — a workflow reading them does not need
 * to know which of those reasons produced the empty one.
 *
 * What is left here, after `proposal.ts` (re-validating a verdict's
 * `duplicateOf` against the shortlist, computing the fingerprint and
 * assembling the proposal — step 7's pure half), `outputs.ts` (every
 * `core.setOutput` call and both job-summary pages) and `corpus.ts` (which
 * already owned the corpus listing, and now owns `crossLanguageCorpus` too)
 * each took their own piece, is the wiring above and `readSettings`/
 * `readAttribution`, which stay here rather than move to a duty-local
 * `inputs.ts`: `main.integration.test.ts`'s own audit of every
 * `getInput`/`getBooleanInput` call scans exactly two files — this one and
 * `core/inputs.ts` — for the call sites it expects, so a function that calls
 * `core.getInput` directly has to live in one of those two places. Unlike
 * `translate`, nothing else in this duty's input-reading is a named,
 * independently pure function — the one candidate (truncating the thread's
 * own body to `max-body-chars` in `decide`) is two lines inline, next to the
 * `core.info` call reporting the truncation, not a helper worth a module of
 * its own.
 *
 * **This duty's `dryRun` check lives inside `act`**, one function further
 * into the pipeline than translate's own placement inside `translateText` —
 * see `act`'s own doc comment for why `rehearse` reads through `dryRun`
 * rather than substituting a stand-in. Triage checks it at each call site
 * instead. Three placements for one knob, an accepted divergence (design
 * §1.2), not something this wave unifies.
 *
 * This file is excluded from coverage because it calls `run()` at import, so
 * measuring it would execute the action. It is exercised by driving the built
 * bundle against a stub API — see `main.integration.test.ts`.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import { narrowWarned, parseApply } from "../../core/enforce.js";
import {
  listOpenThreads,
  readStanding,
  type Location,
  type Standing,
  type TrackerApi,
} from "../../core/forge.js";
import {
  bounded,
  fraction,
  parseSince,
  readShared,
  whole,
  type ApiKeySpec,
  type EndpointSpec,
} from "../../core/inputs.js";
import type { Language } from "../../core/languages.js";
import { isReeveProposalPr } from "../../core/marker.js";
import { createMeter } from "../../core/meter.js";
import { translateToPivot } from "../../core/pivot.js";
import {
  assembleClient,
  createWeather,
  settleAuth,
  shown,
  starved,
  type Names,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { authSection, writeSummary } from "../../core/summary.js";
import {
  newAccumulator,
  standingFromListing,
  sweepThreads,
  type SweepAccumulator as Accumulator,
} from "../../core/sweep.js";
import {
  dutyLanguages,
  openAuthority,
  resolvePivot,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";

import { authorText, crossLanguageCorpus, listCorpus, type CorpusThread } from "./corpus.js";
import { page, report, reportSweep, sweepPage } from "./outputs.js";
import { matchShortlist } from "./proposal.js";
import {
  postOrReplace,
  rehearse,
  type Attribution,
  type CommentApi,
  type Posted,
  type Proposal,
} from "./publish.js";
import { rank } from "./rank.js";
import { type Done, type PivotInfo, type RankInfo, type SweptThread } from "./summary.js";
import { judge } from "./verdict.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";

export interface Settings {
  readonly token: string;
  /** The thread to work on, or null in `sweep`. */
  readonly number: number | null;
  readonly models: readonly string[];
  readonly modelNames: Names;
  readonly languages: readonly Language[];
  readonly warrant: string;
  readonly apply: readonly Capability[];
  /** The floor a verdict's own confidence has to clear before it is applied. */
  readonly confidence: number;
  /** How many BM25-ranked candidates reach the judge. */
  readonly candidates: number;
  /** How many open threads the corpus listing ingests. Null for unbounded. */
  readonly corpusLimit: number | null;
  /** The oldest thread the corpus considers, by creation date. Null for no bound. */
  readonly corpusSince: Date | null;
  /** How much of a body is indexed and judged. Null for the whole thing. */
  readonly maxBodyChars: number | null;
  readonly attribution: Attribution;
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
}

/**
 * Everything but `languages`, which cannot be read here: whether the warrant
 * or the input answers it is a question only `resolveAuthority`'s result can
 * settle, and that read is async while every other input here is not.
 */
function readSettings(): Omit<Settings, "languages"> {
  const shared = readShared();

  return {
    ...shared,
    warrant: core.getInput("warrant", { required: true }),
    apply: parseApply(core.getInput("apply", { required: true })),
    confidence: fraction("confidence", core.getInput("confidence")),
    candidates: whole("candidates", core.getInput("candidates")),
    corpusLimit: bounded("corpus-limit", core.getInput("corpus-limit")),
    corpusSince: parseSince(core.getInput("corpus-since")),
    maxBodyChars: bounded("max-body-chars", core.getInput("max-body-chars")),
    attribution: readAttribution(),
  };
}

/**
 * `show-attribution`, read the same way `translate/main.ts` reads it: a
 * duty-local parser rather than a shared one, because the axis belongs to
 * whichever duty publishes under it and there is no third consumer yet to
 * justify centralising the parsing.
 */
function readAttribution(): Attribution {
  const raw = core.getInput("show-attribution").trim().toLowerCase();
  if (raw === "none" || raw === "model" || raw === "detail") return raw;
  throw new Error(`show-attribution: expected \`none\`, \`model\` or \`detail\`, got \`${raw}\`.`);
}

/** One provider per stage, each counting its own requests. */
interface Stages {
  readonly detect: Provider;
  readonly duplicate: Provider;
  readonly pivot: Provider;
}

/**
 * The part of an Octokit client this duty's pipeline needs, whole: reading a
 * thread and the corpus through `TrackerApi`, finding and replacing this
 * duty's own comment through `CommentApi`. A real client satisfies both at
 * once, the same relationship every other pair of ports in `core/forge.ts`
 * already has.
 */
type Api = TrackerApi & CommentApi;

/** Everything the run concluded, whatever path it took to conclude it. */
export interface Outcome {
  readonly language: string | null;
  /** The candidate the verdict named, before the confidence floor is checked. Null for no proposal. */
  readonly duplicateOf: number | null;
  readonly confidence: number;
  /** The BM25 score that put the proposed candidate in front of the judge. 0 when there is no proposal. */
  readonly lexicalScore: number;
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  /** Why there is no verdict, when there is none. */
  readonly note: string | null;
  readonly rank: RankInfo;
  readonly pivot: PivotInfo;
  /** What `act` would publish, or null when there is nothing eligible to. */
  readonly proposal: Proposal | null;
  /** The fingerprint `proposal` was computed against, alongside it. Null whenever `proposal` is. */
  readonly fingerprint: string | null;
  /**
   * The verdict's own rationale, already sanitised — set whenever a
   * duplicate was named, even one under the confidence floor. Null when
   * there was no verdict at all. Carried separately from `proposal`, which is
   * null under the floor, because a report-only run still owes a reader
   * *why* — see `summary.ts`'s `verdict`.
   */
  readonly rationale: string | null;
  /**
   * Why this duty was granted nothing, when a written `capabilities:` block
   * exists and simply does not name it. `null` on every other path.
   */
  readonly ungranted: string | null;
}

/** This sweep's progress: the shared accumulator, holding this duty's own rows. */
export type SweepAccumulator = Accumulator<SweptThread>;

/**
 * The whole backlog, one thread at a time, through the identical pipeline a
 * single-thread run uses.
 *
 * No idempotent skip the way triage's sweep has one. Triage can tell a
 * taxonomized thread from an untaxonomized one by reading its labels — a free
 * fact. Whether a thread is a duplicate is exactly the question every thread
 * in this walk is asked, and there is no cheaper fact standing in for the
 * answer, so every candidate the walk reaches is processed.
 */
async function runSweep(
  acc: SweepAccumulator,
  api: Api,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<void> {
  if (authority.warrant.unnamed("duplicate")) {
    acc.ungranted = notGranted(authority.warrant).ungranted;
    return;
  }

  const listed = await listOpenThreads(api, context.repo, settings.since);
  // A duplicate check answers "does an issue already describe this" — a pull
  // request implementing something is not that, the same exclusion the
  // corpus itself makes.
  const candidates = listed.filter((thread) => !thread.isPullRequest);

  // Listed once for the whole walk, not once per thread this sweep checks —
  // every candidate here is ranked against the same corpus, and re-listing
  // it per thread would multiply a sweep's own request cost by however many
  // threads it processes. `decide` filters each thread's own number out of
  // this shared listing as it is reached, rather than this call excluding
  // it up front the way a single-thread run's own listing does.
  const corpus = await listCorpus(
    api,
    context.repo,
    null,
    settings.corpusLimit,
    settings.corpusSince,
    settings.maxBodyChars,
  );
  // Detecting a candidate's language is free (script/profile only, no
  // model), but still repeated for the same candidate on every thread the
  // walk ranks it against unless memoised here, once, across the whole
  // sweep — see `crossLanguageCorpus`.
  const languageCache = new Map<number, Language | null>();

  await sweepThreads(acc, candidates, settings, weather, {
    processOne: async (thread) => {
      const at = { ...context.repo, number: thread.number };
      const outcome = await decide(
        api,
        authority,
        thread.number,
        standingFromListing(thread),
        settings,
        stages,
        weather,
        corpus,
        languageCache,
      );
      const acted = await act(api, at, outcome, settings.dryRun);
      return { number: thread.number, outcome: describeOutcome(outcome, acted.done) };
    },
    // The walk's own check only catches the roster running dry *before* a
    // thread is decided. `decide` and `act` are exactly where a model actually
    // gets asked anything, so the roster can just as easily run out grounding
    // the last thread this walk was ever going to reach — the one iteration
    // after which the loop simply ends rather than looping back to ask again.
    // Checked here too, every iteration, so that case still marks `starvedRun`
    // rather than leaving the job summary silent about a starvation the
    // `starved` output already reported.
    afterEach: () => {
      if (starved(settings.models, weather)) acc.starvedRun = true;
    },
  });
}

/** One sweep row's outcome, in the fewest words that are true. */
function describeOutcome(outcome: Outcome, done: Done): string {
  if (outcome.ungranted !== null) return "not granted";
  if (outcome.duplicateOf === null) return "no duplicate";
  if (done.commented) return `proposed #${String(outcome.duplicateOf)}`;
  return `proposed #${String(outcome.duplicateOf)}, not applied`;
}

export async function run(): Promise<void> {
  const meter = createMeter();
  // Reassigned once `readSettings` has answered, inside the `try` below —
  // `endpoints` is not known until then. Left at its empty-alias default if
  // reading the settings themselves is what fails, which is fine: nothing
  // below that point ever runs.
  let weather = createWeather();
  let settings: Settings | null = null;
  let single: {
    readonly number: number;
    readonly outcome: Outcome;
    readonly done: Done;
    readonly posted: Posted | null;
  } | null = null;
  let bulk: SweepAccumulator | null = null;

  try {
    const base = readSettings();
    const client = assembleClient(base, meter, ["detect", "duplicate", "pivot"] as const);
    weather = client.weather;
    const api = getOctokit(base.token);
    const stages: Stages = client.stages;

    // The authority first, and before anything is spent — the same order and
    // the same reason `triage/main.ts` reads it in.
    const { authority, denied } = await openAuthority(base.warrant, api, context.repo, "duplicate");

    settings = {
      ...base,
      languages: dutyLanguages(authority.warrant, denied, core.getInput("languages")),
    };

    if (settings.sweep) {
      bulk = newAccumulator<SweptThread>();
      await runSweep(bulk, api, authority, settings, stages, weather);
    } else {
      const number = settings.number;
      // `readShared` refuses `sweep` combined with `number`, but a bare
      // `sweep: false` still leaves `number` nullable in the type.
      if (number === null) throw new Error("number: required outside `sweep`.");
      const at = { ...context.repo, number };

      // A written `capabilities:` block that does not name `duplicate` grants
      // it nothing, and no verdict this run could reach changes that — so
      // this sits here, before the thread or a single model call spends
      // anything on a decision that could never be applied. `denied` was
      // already read above, to decide `languages` — reused rather than
      // re-asked, the same fact either way.
      const outcome = denied
        ? notGranted(authority.warrant)
        : await decide(
            api,
            authority,
            number,
            await readStanding(api, at),
            settings,
            stages,
            weather,
          );

      const acted = await act(api, at, outcome, settings.dryRun);
      single = { number, outcome, done: acted.done, posted: acted.posted };
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
              ? "The sweep delivered what it could before the roster ran dry, and stopped " +
                "early — see `remaining`."
              : "This run delivered what it could rather than failing red — weather, not a " +
                "broken configuration."),
        );
      }

      if (settings.sweep && bulk !== null) {
        reportSweep(bulk, rosterStarved);
        await writeSummary(
          sweepPage(settings, bulk, meter.spent()) + authSection(weather.authFailures),
        );
      } else if (!settings.sweep && single !== null) {
        report(single.outcome, single.done, rosterStarved);
        await writeSummary(
          page(settings, single.number, single.outcome, single.done, single.posted, meter.spent()) +
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
 * identical under `dry-run`: a rehearsal that took a different path through
 * the pipeline would be rehearsing a run nobody is going to have.
 */
async function decide(
  api: Api,
  authority: Authority,
  thread: number,
  standing: Standing,
  settings: Settings,
  stages: Stages,
  weather: Weather,
  /**
   * A corpus already listed for the whole walk — a sweep's own, shared
   * across every thread it checks — or null for a single-thread run to list
   * its own, excluding just this thread as it pages. See `listCorpus`'s own
   * doc comment on `exclude`.
   */
  corpusSource: readonly CorpusThread[] | null = null,
  /** A candidate's detected language, memoised by issue number across a sweep's whole walk. Fresh per call outside `sweep`, where it buys nothing. */
  languageCache = new Map<number, Language | null>(),
): Promise<Outcome> {
  // Recursion guard: Reeve never checks its own proposal pull request against
  // the corpus. `listCorpus` already drops every pull request from the
  // corpus side, and a sweep's `candidates` filter already drops it from the
  // threads a walk decides about; the `number:` path has no listing to
  // filter it out of, so it is checked again here, in the one place both
  // paths call through.
  if (isReeveProposalPr(standing)) return recursionGuardOutcome();

  const warrant = authority.warrant;
  // Stripped the same way `corpus.ts` strips every candidate — see
  // `authorText`'s own doc comment for why. A thread already carrying a
  // published block (most likely `translate`'s) is compared on what its
  // author wrote, not on what a prior run appended underneath it.
  const rawBody = authorText(standing.body);
  const body = settings.maxBodyChars === null ? rawBody : rawBody.slice(0, settings.maxBodyChars);
  if (settings.maxBodyChars !== null && rawBody.length > settings.maxBodyChars) {
    core.warning(
      `Only the first ${String(settings.maxBodyChars)} characters of the body were read. Raise ` +
        "`max-body-chars`, or set it to `none`, to read the rest.",
    );
  }

  const { permitted, withheld } = narrowWarned(
    warrant.granted("duplicate", DEFAULT_CAPABILITIES),
    settings.apply,
    "duplicate",
    warrant.path,
  );

  /**
   * A run that reached no proposal: the guardrails still reported, nothing
   * else is.
   *
   * `confidence` is required, not defaulted, so every call site names its own
   * answer rather than inheriting one silently. `0` is the honest answer for
   * every caller that has no real verdict to report — no candidates reached
   * the judge, every model failed, the answer did not parse, or the answer
   * named a candidate outside the shortlist it was shown — and those callers
   * pass it explicitly. A verdict that *did* parse and named no duplicate is
   * a real, confident answer of its own — a model sure this is not a
   * duplicate is a different outcome from a judge that was never actually
   * asked, and a default of `0` would have made the two indistinguishable to
   * a reader of `score` without a caller ever having to notice it was relying
   * on one. Callers that have a real verdict in hand pass its `confidence`
   * through instead.
   */
  const nothing = (
    language: string | null,
    rankInfo: RankInfo,
    pivotInfo: PivotInfo,
    note: string | null,
    confidence: number,
  ): Outcome => ({
    language,
    duplicateOf: null,
    confidence,
    lexicalScore: 0,
    permitted,
    withheld,
    note,
    rank: rankInfo,
    pivot: pivotInfo,
    proposal: null,
    fingerprint: null,
    rationale: null,
    ungranted: null,
  });

  const detection = await detectLanguage(
    // The title when there is no body — a one-line issue is a real issue.
    body.length === 0 ? standing.title : body,
    settings.languages,
    createLanguagePicker(stages.detect, settings.models, weather),
  );
  const language = detection.language?.label ?? null;
  core.info(
    detection.language === null
      ? "The author's language is none of the configured ones."
      : `Author language ${detection.language.code} (by ${detection.by}).`,
  );

  const corpus =
    corpusSource === null
      ? await listCorpus(
          api,
          context.repo,
          thread,
          settings.corpusLimit,
          settings.corpusSince,
          settings.maxBodyChars,
        )
      : corpusSource.filter((entry) => entry.number !== thread);

  const queries = [`${standing.title}\n${body}`];
  let pivotUsed = false;
  let pivotNote: string | null = null;

  const pivotLanguage =
    settings.languages.length > 0 ? resolvePivot(authority.warrant, settings.languages) : null;
  const threadLanguage = detection.language;

  if (
    threadLanguage !== null &&
    pivotLanguage !== null &&
    threadLanguage.code !== pivotLanguage.code &&
    (await crossLanguageCorpus(settings.languages, pivotLanguage, corpus, languageCache))
  ) {
    const pivot = await translateToPivot({
      provider: stages.pivot,
      models: settings.models,
      title: standing.title,
      body,
      to: pivotLanguage,
      weather,
    });
    for (const failure of pivot.failures) {
      core.warning(`match: ${shown(settings.modelNames, failure.model)} — ${failure.reason}`);
    }
    if (pivot.draft !== null) {
      queries.push(`${pivot.draft.title}\n${pivot.draft.body}`);
      pivotUsed = true;
      pivotNote = `Bridged the query into ${pivotLanguage.label} to compare against candidates written in other languages.`;
      core.info(pivotNote);
    } else {
      pivotNote =
        "Cross-language matching could not translate this thread into the pivot language this " +
        "run — matching used the thread's own language only.";
      core.info(pivotNote);
    }
  }

  const ranked = rank(queries, corpus, settings.candidates);
  const rankInfo: RankInfo = { corpusSize: corpus.length, offered: ranked.length };
  const pivotInfo: PivotInfo = { used: pivotUsed, note: pivotNote };

  if (ranked.length === 0) return nothing(language, rankInfo, pivotInfo, null, 0);

  const judged = await judge({
    provider: stages.duplicate,
    models: settings.models,
    title: standing.title,
    body,
    language,
    candidates: ranked.map((entry) => entry.candidate),
    weather,
  });
  for (const failure of judged.failures) {
    core.warning(`duplicate: ${shown(settings.modelNames, failure.model)} — ${failure.reason}`);
  }
  if (judged.unreadable !== null) {
    core.warning(
      "The verdict could not be read, so nothing was proposed. A half-parsed answer is the shape " +
        `an injection produces, so it is refused whole — it began: ${excerpt(judged.unreadable)}`,
    );
  }

  // Every model failing and an answer nobody could read are different
  // configurations with the same outcome, and reporting neither would read
  // as a judge that simply agreed with nothing.
  const note =
    judged.unreadable !== null
      ? "the verdict did not parse"
      : judged.model === null
        ? "every model failed"
        : null;

  const verdict = judged.verdict;
  // A real verdict, not the absence of one — the judge was asked, answered,
  // and its answer parsed. `0` is reserved for when there is no verdict to
  // report at all, so this confident "not a duplicate" carries its own
  // `confidence` through rather than defaulting to the same number a run
  // that never got an answer would show.
  if (verdict.duplicateOf === null) {
    return nothing(language, rankInfo, pivotInfo, note, verdict.confidence);
  }

  // Re-validates `duplicateOf` against `ranked` — the exact shortlist the
  // judge was shown — then computes the fingerprint and assembles the
  // proposal. See `matchShortlist`'s own `ShortlistMatch` doc comment for the
  // full argument for why the re-validation exists at all.
  const match = matchShortlist({
    duplicateOf: verdict.duplicateOf,
    confidence: verdict.confidence,
    rawRationale: verdict.rationale,
    ranked,
    query: `${standing.title}\n${body}`,
    confidenceFloor: settings.confidence,
    attribution: settings.attribution,
    model: judged.model !== null ? shown(settings.modelNames, judged.model) : "unknown",
    language: detection.language?.code ?? null,
  });
  if (!match.ok) {
    core.warning(
      "The verdict named a thread outside the shortlist it was shown, so nothing was proposed. " +
        "That shape — a number the ranking never offered — is what a thread body trying to steer " +
        "the verdict at an arbitrary target looks like, and it is refused the same as an answer " +
        "that failed to parse.",
    );
    return nothing(
      language,
      rankInfo,
      pivotInfo,
      "the verdict named a thread outside the shortlist",
      0,
    );
  }
  if (!match.eligible) {
    core.info(
      `Confidence ${verdict.confidence.toFixed(2)} is under the floor of ` +
        `${settings.confidence.toFixed(2)} — reported, not applied.`,
    );
  }

  return {
    language,
    duplicateOf: verdict.duplicateOf,
    confidence: verdict.confidence,
    lexicalScore: match.lexicalScore,
    permitted,
    withheld,
    note,
    rank: rankInfo,
    pivot: pivotInfo,
    proposal: match.proposal,
    fingerprint: match.fingerprint,
    rationale: match.rationale,
    ungranted: null,
  };
}

/**
 * The outcome of a run this duty was never going to be allowed to act on.
 *
 * Green, not red — enumerating who may act is a maintainer's decision, and a
 * name the enumeration left out is a decision too. Reached instead of
 * `decide`, not by it, which is the whole reason it costs nothing to produce.
 */
function notGranted(warrant: Warrant): Outcome {
  return {
    language: null,
    duplicateOf: null,
    confidence: 0,
    lexicalScore: 0,
    permitted: [],
    withheld: [],
    note: null,
    rank: { corpusSize: 0, offered: 0 },
    pivot: { used: false, note: null },
    proposal: null,
    fingerprint: null,
    rationale: null,
    ungranted:
      `\`${warrant.path}\`'s \`capabilities:\` block does not name \`duplicate\`; once that block ` +
      "exists it is the whole answer, so add `duplicate: [comment]` to it (or remove the block to " +
      "return to defaults).",
  };
}

/**
 * The outcome of `decide` reaching Reeve's own proposal pull request
 * directly — via `number:`, since a sweep's own listing never offers it as a
 * candidate. Green, not red, the same shape `notGranted` gives a run this
 * duty was never allowed onto at all.
 */
function recursionGuardOutcome(): Outcome {
  return {
    language: null,
    duplicateOf: null,
    confidence: 0,
    lexicalScore: 0,
    permitted: [],
    withheld: [],
    note: null,
    rank: { corpusSize: 0, offered: 0 },
    pivot: { used: false, note: null },
    proposal: null,
    fingerprint: null,
    rationale: null,
    ungranted:
      "This is Reeve's own proposal pull request — every duty skips it, duplicate included.",
  };
}

/**
 * The one function here that writes to the tracker — a single find-and-
 * replace under this duty's own marker, guarded by the intersection of what
 * the warrant grants and what `apply` asks for. Not reached at all under
 * `dry-run`.
 *
 * **`close` is never read out of `outcome.permitted` here, on purpose, even
 * though `Api`'s `issues.update` could carry `state: "closed"` and `close` is
 * a name `CAPABILITIES` and `parseApply` both already accept.** `close`
 * exists in the warrant's vocabulary because `triage` mirrors it there, not
 * because this duty ever closes anything — see `docs/reference/duties/
 * duplicate.md`'s "never closes a thread" section. That means the guard a
 * duty which *does* close needs — refusing to re-close a thread a human just
 * reopened, so a maintainer's `reopened` is never fought — has nothing to
 * attach to here: there is no line in this function that could fire it,
 * on a fresh thread or a reopened one alike. A future duty that adds a real
 * close path adds that check where the close call is made; this one stays
 * safe by never making the call at all, which is the stronger guarantee.
 *
 * **`dryRun` reads through `rehearse` rather than substituting a stand-in.**
 * `done.commented` stays `false` either way — a dry run leaves nothing
 * standing on the thread, and that output answers exactly that question, not
 * what a real run would have left. `posted`, though, carries the disposition
 * `rehearse` actually found — `postOrReplace`'s own read half, no writes —
 * so `summary.ts`'s `disposition` can say the true "would have posted" /
 * "would have replaced" / "unchanged" instead of a dead branch standing in
 * for it. See `action.yml`'s `dry-run` input for the same distinction spelled
 * out for a reader of the outputs.
 */
async function act(
  api: Api,
  at: Location,
  outcome: Outcome,
  dryRun: boolean,
): Promise<{ readonly done: Done; readonly posted: Posted | null }> {
  if (outcome.proposal === null || outcome.fingerprint === null) {
    return { done: { commented: false }, posted: null };
  }
  if (!outcome.permitted.includes("comment")) {
    return { done: { commented: false }, posted: null };
  }

  if (dryRun) {
    const posted = await rehearse(api, at, outcome.proposal, outcome.fingerprint);
    return { done: { commented: false }, posted };
  }

  const posted = await postOrReplace(api, at, outcome.proposal, outcome.fingerprint);
  // `withheld` (B1's fail-closed answer to a search that could not tell "no
  // comment" from "a comment past the page it read") never wrote anything —
  // `commented` answers whether Reeve's comment stands on the thread after
  // this run, and on that path it does not.
  return { done: { commented: posted !== "withheld" }, posted };
}

/** Enough of an unreadable answer to recognise it, on one line. */
function excerpt(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`;
}

await run();
