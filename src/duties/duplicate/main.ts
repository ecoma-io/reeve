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
 *      through `./corpus.ts`'s own unbounded-paging listing — deliberately
 *      not `listOpenThreads`, which stops at a fixed page ceiling meant for a
 *      sweep's work budget rather than for an index a maintainer configured.
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
 * This file is excluded from coverage because it calls `run()` at import, so
 * measuring it would execute the action. It is exercised by driving the built
 * bundle against a stub API — see `main.integration.test.ts`.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import { narrow, parseApply } from "../../core/enforce.js";
import {
  listOpenThreads,
  readStanding,
  type Location,
  type Standing,
  type TrackerApi,
} from "../../core/forge.js";
import { bounded, fraction, parseSince, readShared, whole } from "../../core/inputs.js";
import type { Language } from "../../core/languages.js";
import { createMeter, metered } from "../../core/meter.js";
import { translateToPivot } from "../../core/pivot.js";
import {
  createProvider,
  createWeather,
  shown,
  starved,
  type Names,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { sanitize } from "../../core/sanitize.js";
import { writeSummary } from "../../core/summary.js";
import {
  readWarrant,
  resolveAuthority,
  resolveLanguages,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";

import { authorText, listCorpus, type CorpusThread } from "./corpus.js";
import {
  postOrReplace,
  proposalFingerprint,
  rehearse,
  type Attribution,
  type CommentApi,
  type Posted,
  type Proposal,
} from "./publish.js";
import { documentOf, rank } from "./rank.js";
import {
  summarize,
  summarizeSweep,
  type Done,
  type PivotInfo,
  type RankInfo,
  type Run,
  type SweptThread,
} from "./summary.js";
import { judge } from "./verdict.js";

/**
 * What this duty may do when the warrant says nothing about it: nothing.
 *
 * Unlike triage's cheapest-reversible-action default, there is no capability
 * here worth granting for free. A label a run got wrong costs one click to
 * remove; a comment naming the wrong thread as a duplicate is a claim posted
 * in public about somebody else's report, and that is not a default a duty
 * should reach for on a repository that never wrote an opinion about it.
 */
const DEFAULT_CAPABILITIES: readonly Capability[] = [];

/** `warrant`'s own default in `action.yml`, repeated here rather than read back out of it. */
const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

interface Settings {
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
  readonly limit: number;
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
interface Outcome {
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

/**
 * A sweep's progress, mutated in place rather than assembled and returned —
 * the same reason `triage/main.ts`'s accumulator is: an `AuthenticationFailure`
 * thrown partway down the loop still leaves whatever was already processed
 * readable from `run`'s `finally` block.
 */
interface SweepAccumulator {
  readonly results: SweptThread[];
  starvedRun: boolean;
  candidates: number;
  ungranted: string | null;
}

function newAccumulator(): SweepAccumulator {
  return { results: [], starvedRun: false, candidates: 0, ungranted: null };
}

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
  acc.candidates = candidates.length;

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

  for (const thread of candidates) {
    if (acc.results.length >= settings.limit) break;
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
      // The sweep listing this candidate came from does not carry who opened
      // it — only `readStanding`'s single-thread fetch does — and nothing in
      // `duplicate`'s own decision reads it: ranking a candidate against the
      // thread in hand never turns on who either one's author is.
      author: { login: "", isBot: false },
    };
    const outcome = await decide(
      api,
      authority,
      thread.number,
      standing,
      settings,
      stages,
      weather,
      corpus,
      languageCache,
    );
    const acted = await act(api, at, outcome, settings.dryRun);
    acc.results.push({ number: thread.number, outcome: describeOutcome(outcome, acted.done) });

    // The pre-loop check above only catches the roster running dry *before*
    // a thread is decided. `decide` and `act` are exactly where a model
    // actually gets asked anything, so the roster can just as easily run out
    // grounding the last thread this walk was ever going to reach — the one
    // iteration after which the loop simply ends rather than looping back to
    // ask again. Checked here too, every iteration, so that case still marks
    // `starvedRun` rather than leaving the job summary silent about a
    // starvation the `starved` output already reported.
    if (starved(settings.models, weather)) acc.starvedRun = true;
  }
}

/** Candidates the walk did not reach — the limit, or the roster running dry. */
function remainingOf(acc: SweepAccumulator): number {
  return Math.max(acc.candidates - acc.results.length, 0);
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
  const weather = createWeather();
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
    const api = getOctokit(base.token);
    const provider = createProvider({ baseUrl: base.baseUrl, apiKey: base.apiKey });

    const stages: Stages = {
      detect: metered(provider, meter, "detect"),
      duplicate: metered(provider, meter, "duplicate"),
      pivot: metered(provider, meter, "pivot"),
    };

    // The authority first, and before anything is spent — the same order and
    // the same reason `triage/main.ts` reads it in.
    const read = await readWarrant(base.warrant, { defaultPath: DEFAULT_WARRANT_PATH });
    const authority = await resolveAuthority(read, base.warrant, api, context.repo);

    const denied = authority.warrant.unnamed("duplicate");
    const resolution = denied
      ? null
      : resolveLanguages(authority.warrant, core.getInput("languages"));
    if (resolution !== null && resolution.notice !== null) core.notice(resolution.notice);
    settings = { ...base, languages: resolution === null ? [] : resolution.languages };

    if (settings.sweep) {
      bulk = newAccumulator();
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
        await writeSummary(sweepPage(settings, bulk, meter.spent()));
      } else if (!settings.sweep && single !== null) {
        report(single.outcome, single.done, rosterStarved);
        await writeSummary(
          page(settings, single.number, single.outcome, single.done, single.posted, meter.spent()),
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

  const { permitted, withheld } = narrow(
    warrant.granted("duplicate", DEFAULT_CAPABILITIES),
    settings.apply,
  );
  for (const capability of withheld) {
    core.warning(
      `\`apply\` asks for \`${capability}\`, which \`${warrant.path}\` does not grant to duplicate. ` +
        "The narrower of the two wins.",
    );
  }

  /**
   * A run that reached no proposal: the guardrails still reported, nothing
   * else is.
   *
   * `confidence` defaults to `0`, which is the honest answer for every caller
   * that has no real verdict to report — no candidates reached the judge,
   * every model failed, the answer did not parse, or the answer named a
   * candidate outside the shortlist it was shown. But a verdict that *did*
   * parse and named no duplicate is a real, confident answer of its own — a
   * model sure this is not a duplicate is a different outcome from a judge
   * that was never actually asked, and `0` would make the two indistinguishable
   * to a reader of `score`. Callers that have a real verdict in hand pass its
   * `confidence` through explicitly instead of taking this default.
   */
  const nothing = (
    language: string | null,
    rankInfo: RankInfo,
    pivotInfo: PivotInfo,
    note: string | null,
    confidence = 0,
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

  const pivotLanguage = settings.languages[0] ?? null;
  const threadLanguage = detection.language;

  if (
    threadLanguage !== null &&
    pivotLanguage !== null &&
    threadLanguage.code !== pivotLanguage.code &&
    (await crossLanguageCorpus(settings.languages, pivotLanguage, corpus, languageCache))
  ) {
    const draft = await translateToPivot({
      provider: stages.pivot,
      models: settings.models,
      title: standing.title,
      body,
      to: pivotLanguage,
      weather,
    });
    if (draft !== null) {
      queries.push(`${draft.title}\n${draft.body}`);
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

  if (ranked.length === 0) return nothing(language, rankInfo, pivotInfo, null);

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

  // `parseVerdict` already refuses a `duplicate_of` that does not name one of
  // the `candidates` it was given — that is what makes an injected "this
  // duplicates #999" in a thread body unable to steer a verdict at a thread
  // the ranking never surfaced. This re-checks the same fact against `ranked`
  // — the exact shortlist this call passed as those `candidates` — on
  // purpose: the number that reaches `Outcome`, an output, or a published
  // comment must be traceable to a candidate this run's own ranking offered,
  // not merely to a candidate `verdict.ts` was trusted to have checked. A
  // miss here can only mean that invariant broke somewhere upstream, and the
  // right response to that is the same as an unparseable answer — discard,
  // never best-effort — not to fall back to a `0` score and publish anyway.
  const matched = ranked.find((entry) => entry.candidate.number === verdict.duplicateOf);
  if (matched === undefined) {
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
    );
  }
  const lexicalScore = matched.score;
  // Sanitised once, used both by `proposal` below (only when eligible) and by
  // `Outcome.rationale` (always, once a verdict named a candidate the
  // shortlist actually offered) — a report-only run under the floor still
  // owes a reader *why*, which `proposal` alone cannot answer since it is
  // null there.
  const rationale = sanitize(verdict.rationale);

  const eligible = verdict.confidence >= settings.confidence;
  if (!eligible) {
    core.info(
      `Confidence ${verdict.confidence.toFixed(2)} is under the floor of ` +
        `${settings.confidence.toFixed(2)} — reported, not applied.`,
    );
  }

  // Over the thread's own text and the shortlist the judge was actually
  // shown — see `proposalFingerprint`'s own doc comment for why that, and not
  // the static config knobs that produced the shortlist, is what makes a
  // grown corpus re-ask and an identical rerun stop.
  const fp = proposalFingerprint(
    `${standing.title}\n${body}`,
    ranked.map((entry) => entry.candidate.number),
  );

  const proposal: Proposal | null = eligible
    ? {
        duplicateOf: verdict.duplicateOf,
        confidence: verdict.confidence,
        lexicalScore,
        rationale,
        model: judged.model !== null ? shown(settings.modelNames, judged.model) : "unknown",
        attribution: settings.attribution,
      }
    : null;

  return {
    language,
    duplicateOf: verdict.duplicateOf,
    confidence: verdict.confidence,
    lexicalScore,
    permitted,
    withheld,
    note,
    rank: rankInfo,
    pivot: pivotInfo,
    proposal,
    // Under the floor, `duplicate-of`/`score` still answer, but there is
    // nothing eligible to fingerprint against a write that will never happen.
    fingerprint: eligible ? fp : null,
    rationale,
    ungranted: null,
  };
}

/**
 * Whether at least one corpus candidate is written in the pivot language
 * specifically — not merely in some language other than the thread's own —
 * which is the fact `action.yml`'s own `languages` input promises triggers
 * the bridge, and the fact that makes `translateToPivot` worth a request. A
 * corpus that holds a candidate in a third configured language but none in
 * the pivot would still fail to match after the bridge ran, so checking
 * "not the thread's language" would spend a translation a same-language BM25
 * pass could never have used anyway.
 *
 * Every check here is free: `detectLanguage` is called with no `pick`
 * argument, so it never reaches past script narrowing and the local
 * byte-ngram profile — no model, no request, whatever the size of `corpus`.
 * A candidate `detectLanguage` cannot place at all (`by: "none"`) proves
 * nothing either way and is skipped rather than counted as a match, the same
 * caution `detectLanguage`'s own callers use everywhere else.
 *
 * `cache` memoises a candidate's detected language by its issue number.
 * Cheap on its own, but a sweep offers the same candidate to this function
 * once per thread the walk checks it against, and without this the free
 * detection above would repeat that many times over for no new answer.
 */
async function crossLanguageCorpus(
  languages: readonly Language[],
  pivotLanguage: Language,
  corpus: readonly CorpusThread[],
  cache: Map<number, Language | null>,
): Promise<boolean> {
  for (const candidate of corpus) {
    let detected: Language | null;
    if (cache.has(candidate.number)) {
      detected = cache.get(candidate.number) ?? null;
    } else {
      detected = (await detectLanguage(documentOf(candidate), languages)).language;
      cache.set(candidate.number, detected);
    }
    if (detected !== null && detected.code === pivotLanguage.code) return true;
  }
  return false;
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
 * The one function here that writes to the tracker — a single find-and-
 * replace under this duty's own marker, guarded by the intersection of what
 * the warrant grants and what `apply` asks for. Not reached at all under
 * `dry-run`.
 *
 * **`close` is never read out of `outcome.permitted` here, on purpose, even
 * though `Api`'s `issues.update` could carry `state: "closed"` and `close` is
 * a name `CAPABILITIES` and `parseApply` both already accept.** `close`
 * exists in the warrant's vocabulary because `triage` mirrors it there, not
 * because this duty ever closes anything — see `docs/usage/duties/
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

/**
 * Every output, written on every single-thread path that reaches an answer —
 * including the ones that answer "nothing". A workflow branching on
 * `duplicate-of` needs it to be an empty string rather than an unset output
 * on the run where nothing was proposed.
 */
function report(outcome: Outcome, done: Done, rosterStarved: boolean): void {
  core.setOutput("duplicate-of", outcome.duplicateOf === null ? "" : String(outcome.duplicateOf));
  core.setOutput("score", outcome.confidence.toFixed(2));
  core.setOutput("language", outcome.language ?? "");
  core.setOutput("commented", String(done.commented));
  core.setOutput("starved", String(rosterStarved));
  // `0`, not unset — a single-thread run answers a sweep's own outputs
  // honestly at zero rather than leaving a workflow that reads them on every
  // run reading an empty string on this one.
  core.setOutput("processed", "0");
  core.setOutput("remaining", "0");
}

/**
 * `processed` and `remaining` — a sweep's own outputs. `starved` is shared
 * vocabulary between the two modes, so it keeps the same name here. The
 * single-thread outputs are left unset on a sweep run, the same choice
 * `triage/main.ts`'s own `reportSweep` makes: none of them name one thread,
 * and a workflow reading `duplicate-of` off a sweep was never going to find
 * one thread's answer there either way.
 */
function reportSweep(bulk: SweepAccumulator, rosterStarved: boolean): void {
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("remaining", String(remainingOf(bulk)));
  core.setOutput("starved", String(rosterStarved));
}

function page(
  settings: Settings,
  thread: number,
  outcome: Outcome,
  done: Done,
  posted: Posted | null,
  spent: Run["spent"],
): string {
  return summarize({
    thread,
    dryRun: settings.dryRun,
    warrant: settings.warrant,
    language: outcome.language,
    ungranted: outcome.ungranted,
    duplicateOf: outcome.duplicateOf,
    confidence: outcome.confidence,
    floor: settings.confidence,
    lexicalScore: outcome.lexicalScore,
    rank: outcome.rank,
    pivot: outcome.pivot,
    note: outcome.note,
    permitted: outcome.permitted,
    withheld: outcome.withheld,
    rationale: outcome.rationale,
    done,
    posted,
    spent,
    modelNames: settings.modelNames,
  });
}

function sweepPage(settings: Settings, bulk: SweepAccumulator, spent: Run["spent"]): string {
  return summarizeSweep({
    dryRun: settings.dryRun,
    warrant: settings.warrant,
    results: bulk.results,
    remaining: remainingOf(bulk),
    starvedRun: bulk.starvedRun,
    ungranted: bulk.ungranted,
    spent,
    modelNames: settings.modelNames,
  });
}

await run();
