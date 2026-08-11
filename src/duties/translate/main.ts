/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. Each decision it reaches for lives in a
 * module that is tested on its own — most of them in the core, which is shared
 * with every other duty — and the only judgement made here is the order they run
 * in and what a failure at each step means for the run:
 *
 *   1. Read the warrant — or, missing one at the default path, build the
 *      implicit warrant the same way triage does. `languages` comes from
 *      whichever of the warrant's own `languages:` key and the `languages`
 *      input answers it, the file winning outright when it has an opinion.
 *   1a. A written `capabilities:` block that does not name `translate` is
 *      checked here, once, before a single thread is read — sweep or not,
 *      exactly as triage's own enumeration is total. Nothing below this line
 *      runs; the summary says why, and the run is green.
 *   2. Read the thread, and keep only the author's half of the body — anything
 *      below the marker is this duty's own output, not a source.
 *   3. Stop when there is nothing to translate — an empty body, or text with no
 *      prose in it at all — and stop when the fingerprint of that half and the
 *      target languages matches what is already published. This is what makes an
 *      edit-triggered rerun free, and it is what stops the loop that writing into
 *      the body creates.
 *   4. Truncate to `max-body-chars`, and remember that the block has to say so.
 *   5. Detect the source language — script, then profile, then a model, and
 *      `null` is a real answer meaning none of the configured languages wrote
 *      it.
 *   6. Translate into every configured language except the one it came from.
 *   7. Let the panel pick between the drafts the score admitted.
 *   8. Append the translations to the body, under the marker — unless the
 *      warrant's `capabilities:` block was written without granting
 *      `edit-body`, in which case every step up to here still ran and only
 *      the write is withheld.
 *   9. When `translate-replies` is on, do all of the above again per reply.
 *
 * **Steps 2–8 are one function, run once per text.** A reply has an author, a
 * body, and a reader who needs it in their language, so it gets the same
 * treatment rather than a cheaper one — including its own fingerprint, which is
 * what keeps a hundred-reply backfill from re-spending anything on the
 * ninety-nine that have not changed.
 *
 * **A language that fails does not fail the run.** A provider out of quota for
 * Chinese must still publish the English translation that worked, and say which
 * one it could not do. Only a broken configuration and a thread that cannot be
 * read are `setFailed` — everything else is a warning and a `skipped` output a
 * workflow can branch on. A reply that fails is smaller still: it is warned
 * about and the run moves to the next one, because a thread whose body
 * translated and whose fourth reply did not is better off published than
 * failed.
 *
 * This file is excluded from coverage because it calls `run()` at import, so
 * measuring it would execute the action. It is exercised by driving the built
 * bundle against a stub API, which is what a runner does — see
 * `main.integration.test.ts`.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createLanguagePicker, detectLanguage, residue } from "../../core/detect.js";
import {
  createReply,
  createThread,
  listOpenThreads,
  listReplies,
  type Thread,
} from "../../core/forge.js";
import { readShared, whole } from "../../core/inputs.js";
import { type Language } from "../../core/languages.js";
import {
  createProvider,
  createWeather,
  parseSeats,
  shown,
  starved,
  type Names,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { assemble, publish } from "../../core/publish.js";
import { createMeter, metered } from "../../core/meter.js";
import { writeSummary } from "../../core/summary.js";
import {
  readWarrant,
  resolveAuthority,
  resolveLanguages,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";

import { translate } from "./draft.js";
import { judge } from "./judge.js";
import { summarize, summarizeSweep, type Looked, type Run, type SweptThread } from "./summary.js";
import {
  marker,
  publication,
  translationFingerprint,
  type Attribution,
  type Posted,
  type Translated,
} from "./publish.js";

/**
 * What this duty may do when the warrant says nothing about it.
 *
 * `edit-body` and nothing else — it is the only thing this duty has ever
 * done, and the default belongs here rather than in the warrant reader
 * because only this duty knows that editing the body is the whole of its
 * work.
 */
const DEFAULT_CAPABILITIES: readonly Capability[] = ["edit-body"];

/**
 * `warrant`'s own default in `action.yml`, repeated here rather than read
 * back out of it — see triage's identical constant for why.
 */
const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

interface Settings {
  readonly token: string;
  /** The thread to work on, or null in `sweep`. */
  readonly number: number | null;
  readonly models: readonly string[];
  /** What to call each of them, keyed by model id. */
  readonly modelNames: Names;
  readonly languages: readonly Language[];
  readonly warrant: string;
  /** What the warrant grants this duty. Checked once per run, not per text. */
  readonly permitted: readonly Capability[];
  readonly judges: readonly (readonly string[])[];
  /** What to call each seat, keyed by every model that seat may be filled by. */
  readonly judgeNames: Names;
  readonly drafts: number;
  readonly maxBodyChars: number;
  readonly replies: boolean;
  readonly attribution: Attribution;
  readonly dryRun: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly sweep: boolean;
  readonly since: Date | null;
  readonly limit: number;
}

/**
 * The inputs, parsed and rejected here rather than deeper in.
 *
 * The five every duty shares come from the core, so `models` means the same
 * thing here as it will in the next duty a consumer configures. What is left is
 * this duty's own, and every problem it throws on is a typo in a workflow file:
 * a run that continued past one would translate into a language nobody asked for
 * or spend a provider's budget on a number that was never a number.
 *
 * `languages` and `permitted` are missing from what this returns. Both need
 * the warrant, and reading the warrant is async while every other input here
 * is not — `run` completes the object once `resolveAuthority` has answered.
 */
function readSettings(): Omit<Settings, "languages" | "permitted"> {
  const shared = readShared();
  const panel = parseSeats(core.getInput("judge-models"));

  return {
    ...shared,
    warrant: core.getInput("warrant", { required: true }),
    judges: panel.seats,
    judgeNames: panel.names,
    drafts: whole("drafts", core.getInput("drafts")),
    maxBodyChars: whole("max-body-chars", core.getInput("max-body-chars")),
    replies: core.getBooleanInput("translate-replies"),
    attribution: readAttribution(),
  };
}

/**
 * The `show-attribution` input, refused rather than guessed at.
 *
 * A misspelling is a workflow that would otherwise publish a hundred bodies with
 * the wrong amount of detail in them and say nothing — and the fingerprint means
 * the run that fixes the spelling will not rewrite them. Failing on the first
 * thread is the cheap end of that.
 */
function readAttribution(): Attribution {
  const raw = core.getInput("show-attribution").trim().toLowerCase();
  if (raw === "none" || raw === "model" || raw === "detail") return raw;
  throw new Error(`show-attribution: expected \`none\`, \`model\` or \`detail\`, got \`${raw}\`.`);
}

/**
 * The author's own words, and whether the tail of them was left behind.
 *
 * Split before truncation, so the limit applies to what is actually translated
 * rather than being spent on a block a previous run wrote. Takes text rather
 * than fetching it, because a reply's body arrives from the listing that found
 * it and a body arrives from the thread — the same three answers either way.
 */
function readBody(
  body: string,
  limit: number,
): { official: string; source: string; truncated: boolean; published: string | null } {
  const { official, fingerprint: published } = marker.split(body);
  return {
    official,
    source: official.slice(0, limit),
    truncated: official.length > limit,
    published,
  };
}

/**
 * The languages to translate into: every configured one except the one the
 * thread is already written in.
 *
 * A thread whose language is none of the configured ones is translated into all
 * of them. That is the honest reading of "no source language among these": a
 * German issue in a repository set up for English, Vietnamese and Chinese needs
 * all three, and there is nothing to leave out.
 */
function targets(languages: readonly Language[], from: Language | null): readonly Language[] {
  if (from === null) return languages;
  const source = from.code.toLowerCase();
  return languages.filter((language) => language.code.toLowerCase() !== source);
}

/**
 * One provider per stage, each counting its own requests.
 *
 * Three handles on the same endpoint rather than one, because the meter records
 * a purpose and a stage is the only thing that knows its own. Built once in
 * `run` and passed down, so a stage cannot be metered as another one by being
 * called from the wrong place.
 */
interface Stages {
  readonly detect: Provider;
  readonly draft: Provider;
  readonly judge: Provider;
}

async function translateInto(
  to: Language,
  settings: Settings,
  stages: Stages,
  from: Language | null,
  source: string,
  weather: Weather,
): Promise<Posted | null> {
  const drafted = await translate({
    provider: stages.draft,
    models: settings.models,
    source,
    from,
    to,
    languages: settings.languages,
    drafts: settings.drafts,
    weather,
  });

  // Named as the workflow named them, everywhere a person reads them. A
  // maintainer who called a model `Careful` did so because the id is theirs to
  // keep, and a warning quoting the id would hand it to the log they masked it
  // out of.
  const model = (id: string): string => shown(settings.modelNames, id);

  for (const failure of drafted.failures) {
    core.warning(`${to.code}: ${model(failure.model)} failed — ${failure.reason}`);
  }
  for (const refused of drafted.refused) {
    core.warning(
      `${to.code}: ${model(refused.model)} was refused — ${refused.score.reason ?? "unscored"}`,
    );
  }

  const verdict = await judge({
    provider: stages.judge,
    judges: settings.judges,
    source,
    to,
    attempts: drafted.attempts,
    weather,
  });

  const seat = (id: string): string => shown(settings.judgeNames, id);

  for (const failure of verdict.failures) {
    core.warning(`${to.code}: judge ${seat(failure.model)} — ${failure.reason}`);
  }

  if (verdict.winner === null) return null;

  const cast = verdict.votes.map((vote) => ({ model: seat(vote.model), pick: model(vote.pick) }));
  const votes = cast.map((vote) => `${vote.model}→${vote.pick}`).join(", ");
  core.info(
    `${to.code}: ${model(verdict.winner.model)} by ${verdict.decidedBy}` +
      ` (score ${verdict.winner.score.value.toFixed(3)}${votes.length > 0 ? `, ${votes}` : ""})`,
  );

  // A contest only when there was one. One draft that no judge voted on won by
  // being the only candidate, and `Scored 0.91 of 1.00, decided by score` reads
  // like a field of losers was beaten. Leaving it absent lets the block say the
  // one true thing — which model wrote this — and stop.
  const contested = drafted.attempts.length > 1 || verdict.votes.length > 0;

  return {
    to,
    text: verdict.winner.text,
    model: model(verdict.winner.model),
    ...(contested
      ? {
          decision: {
            score: verdict.winner.score.value,
            drafts: drafted.attempts.length,
            decidedBy: verdict.decidedBy,
            votes: cast,
          },
        }
      : {}),
  };
}

/**
 * What one text cost and produced, whether it was a body or a reply.
 *
 * `Looked` is the reporting half and lives with the summary that renders it;
 * what this adds is the one thing only the caller needs — whether anything was
 * actually written, which is what `replies-translated` counts.
 */
interface Report extends Looked {
  /** True when this text got a translation written to it this run. */
  readonly published: boolean;
}

function nothing(what: string, note: string): Report {
  return { what, from: null, posted: [], skipped: [], note, published: false };
}

/**
 * Steps 1–7 for one text, wherever it lives.
 *
 * `what` names the text in the log — `#42` or `#42 comment 991` — because a run
 * over a thread and twelve replies otherwise reports thirteen indistinguishable
 * verdicts. `thread` is the port to write back through, so this function never
 * knows whether it is editing an issue body or a comment.
 */
async function translateText(
  what: string,
  body: string,
  thread: Thread,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<Report> {
  const { official, source, truncated, published } = readBody(body, settings.maxBodyChars);
  if (source.trim().length === 0) {
    core.info(`${what} has an empty body — nothing to translate.`);
    return nothing(what, "empty body");
  }

  // A stack trace, a log paste, a bare URL: text with no prose in it is written
  // the same way in every language, so there is nothing here to translate into
  // anything. Screened before detection rather than after it, because detection
  // would honestly answer `unknown` — and `unknown` means "translate into all of
  // them", which is the most expensive answer available for the one input where
  // no answer is worth anything.
  if (residue(source).trim().length === 0) {
    core.info(`${what} has no prose in it — nothing to translate.`);
    return nothing(what, "no prose to translate");
  }

  // Before a single request is made, because the whole value of this check is
  // that it costs nothing. Publishing fires the `edited` event this workflow
  // listens for, so the run that event starts has to reach this line and stop —
  // that is the termination argument, and it holds for a PAT and an App
  // installation, which get no recursion prevention from GitHub.
  // Over `source` rather than `official`, so the digest describes the text that
  // is actually translated. Hashing the whole body while translating a prefix of
  // it made `max-body-chars` a one-way door: raising it left the marker matching
  // and the run skipping, so the tail the block promises to come back for never
  // was. The two are the same string whenever nothing was truncated, which is
  // why a thread translated in full keeps the marker it already has.
  const wanted = translationFingerprint(source, settings.languages);
  if (published === wanted) {
    core.info(`${what} already carries the translation for this text and these languages.`);
    return nothing(what, "already translated");
  }

  if (truncated) {
    core.warning(
      `${what}: only the first ${String(settings.maxBodyChars)} characters were ` +
        "translated. Raise `max-body-chars` to translate the rest.",
    );
  }

  const detection = await detectLanguage(
    source,
    settings.languages,
    createLanguagePicker(stages.detect, settings.models, weather),
  );
  core.info(
    detection.language === null
      ? `${what}: source language is none of the configured ones (${String(detection.candidates.length)} candidates).`
      : `${what}: source language ${detection.language.code} (by ${detection.by}).`,
  );

  const posted: Posted[] = [];
  const skipped: Language[] = [];
  for (const to of targets(settings.languages, detection.language)) {
    const translated = await translateInto(
      to,
      settings,
      stages,
      detection.language,
      source,
      weather,
    );
    if (translated === null) {
      core.warning(`${what} ${to.code}: no model produced a translation this run.`);
      skipped.push(to);
    } else {
      posted.push(translated);
    }
  }

  // What the run got, not what it was asked for. `wanted` above is the whole
  // configured set; this is the set that came back, plus the source language,
  // which the run legitimately had nothing to translate into. The two are equal
  // exactly when nothing was skipped — so a language a provider could not
  // translate this run leaves a marker the next run does not match, and the next
  // run tries it again instead of reading its own claim and stopping.
  const achieved = translationFingerprint(source, [
    ...posted.map((entry) => entry.to),
    ...(detection.language === null ? [] : [detection.language]),
  ]);

  const translated: Translated = {
    from: detection.language,
    posted,
    skipped,
    truncated,
    fingerprint: achieved,
    attribution: settings.attribution,
  };

  if (settings.dryRun) {
    const would = publication(translated);
    core.info(
      would.sections.length === 0
        ? `Dry run — ${what} would have been left alone: no language produced a translation.`
        : `Dry run — ${what} would have become:\n${assemble(official, marker, would)}`,
    );
    return { what, from: detection.language, posted, skipped, note: null, published: false };
  }

  // Guarded here and nowhere earlier: detection, drafting and judging all ran
  // and all spent whatever they were going to spend, exactly as they would
  // under an `apply: none` narrowing in triage — a capability the warrant
  // withheld is a reason not to write, not a reason not to have decided.
  if (!settings.permitted.includes("edit-body")) {
    if (posted.length > 0) {
      core.warning(
        `${what}: \`${settings.warrant}\` does not grant \`edit-body\` to translate, so ` +
          `${posted.length === 1 ? "the translation" : `${String(posted.length)} translations`} ` +
          `drafted this run ${posted.length === 1 ? "was" : "were"} not published.`,
      );
    }
    return { what, from: detection.language, posted: [], skipped, note: null, published: false };
  }

  const outcome = await publish(thread, marker, publication(translated));
  core.info(
    outcome.action === "none"
      ? `${what}: nothing written — ${outcome.reason}.`
      : `${what}: ${outcome.action}.`,
  );

  return {
    what,
    from: detection.language,
    posted,
    skipped,
    note: null,
    published: outcome.action === "published",
  };
}

/**
 * Every reply on the thread, each translated on its own terms.
 *
 * Its own detection and its own fingerprint per reply, rather than the thread's:
 * a Vietnamese issue routinely collects English answers, and a reply inherits
 * neither the language of the body nor the language of the reply above it.
 *
 * Sequential rather than concurrent. The provider Reeve is built for is whatever
 * a consumer can run for nothing, and firing a hundred completions at one is how
 * a run that would have finished gets rate-limited into failing halfway.
 */
async function translateReplies(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
  settings: Settings,
  stages: Stages,
  looked: Looked[],
  weather: Weather,
): Promise<number> {
  const { replies, more } = await listReplies(api, at);
  if (more) {
    core.warning(
      `#${String(at.number)} has more replies than one run reads, so the oldest were not ` +
        "translated. They are picked up by editing them, or by a run against a smaller thread.",
    );
  }

  let published = 0;
  for (const reply of replies) {
    const translated = await translateText(
      `#${String(at.number)} comment ${String(reply.id)}`,
      reply.body,
      createReply(api, at, reply),
      settings,
      stages,
      weather,
    );
    looked.push(translated);
    if (translated.published) published += 1;
  }
  return published;
}

/**
 * Steps 1–8 for one thread, from a body already in hand.
 *
 * The single call both modes route every thread through — `run` for the one
 * thread an event named, `runSweep` for however many `limit` allows — so a
 * change to what translating one thread involves cannot land in one mode and
 * not the other. Takes the body rather than fetching it, so a sweep spends no
 * second request on a thread its own listing already read.
 */
interface ThreadResult {
  readonly looked: readonly Looked[];
  readonly translated: Report;
  readonly replies: number;
  /**
   * Why this duty was granted nothing, when a written `capabilities:` block
   * simply does not name it — `null` on every path that reached `decide`'s
   * translate equivalent at all, including one that translated nothing for
   * an ordinary reason.
   */
  readonly ungranted: string | null;
}

async function processThread(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
  body: string,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<ThreadResult> {
  const thread = createThread(api, at);
  const translated = await translateText(
    `#${String(at.number)}`,
    body,
    thread,
    settings,
    stages,
    weather,
  );
  const looked: Looked[] = [translated];

  const replies = settings.replies
    ? await translateReplies(api, at, settings, stages, looked, weather)
    : 0;

  return { looked, translated, replies, ungranted: null };
}

/**
 * The outcome of a run this duty was never going to be allowed to act on.
 *
 * Green, not red — enumerating who may act is a maintainer's decision, and a
 * name the enumeration left out is a decision too, just not one that grants
 * anything. Nothing here reached `translateText`, which is the entire point:
 * this is reached instead of it, not by it, so it costs nothing to produce.
 */
function notGranted(warrant: Warrant): string {
  return (
    `\`${warrant.path}\`'s \`capabilities:\` block does not name \`translate\`; once that block ` +
    "exists it is the whole answer, so add `translate: [edit-body]` to it (or remove the block " +
    "to return to defaults)."
  );
}

/**
 * A sweep's progress, mutated in place rather than assembled and returned.
 *
 * The reason is the same as triage's: nothing here throws an
 * `AuthenticationFailure` past this point that a `finally` block still needs
 * to report from, but `runSweep` can stop early on capacity starvation, and
 * `run`'s `finally` reports whatever was built up to that point either way.
 */
interface SweepAccumulator {
  readonly results: SweptThread[];
  skipped: number;
  starvedRun: boolean;
  candidates: number;
  /** Set once, before the listing, when the warrant never named this duty at all. */
  ungranted: string | null;
}

function newAccumulator(): SweepAccumulator {
  return { results: [], skipped: 0, starvedRun: false, candidates: 0, ungranted: null };
}

/** Candidates neither processed nor skipped — what a next sweep still has to look at. */
function remainingOf(acc: SweepAccumulator): number {
  return Math.max(acc.candidates - acc.results.length - acc.skipped, 0);
}

/** One sweep row's outcome, in the fewest words that are true. */
function describeOutcome(result: ThreadResult): string {
  if (result.translated.note !== null) return result.translated.note;

  const parts: string[] = [];
  if (result.translated.posted.length > 0) {
    parts.push(`published ${result.translated.posted.map((entry) => entry.to.code).join(", ")}`);
  }
  if (result.translated.skipped.length > 0) {
    parts.push(`skipped ${result.translated.skipped.map((language) => language.code).join(", ")}`);
  }
  // Both empty means every configured language was also the source language —
  // a single-language configuration reading its own thread, which has nothing
  // left to translate into and nothing wrong with it either.
  if (parts.length === 0) parts.push("no target languages");
  if (result.replies > 0) {
    parts.push(`${String(result.replies)} repl${result.replies === 1 ? "y" : "ies"} translated`);
  }

  return parts.join("; ");
}

/**
 * The whole backlog, one thread at a time, through the identical pipeline a
 * single-thread run uses.
 *
 * Translate sweeps issues and pull requests both — a contributor reading a
 * thread in their own language does not care which kind it is, and the
 * listing endpoint already returns both. Triage is the duty that has to tell
 * them apart, because a label taxonomy is a judgement about an issue; a
 * translation is not.
 */
async function runSweep(
  acc: SweepAccumulator,
  api: ReturnType<typeof getOctokit>,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<void> {
  // Once, before the listing — exactly as triage's sweep — because the warrant
  // is checked once per run, not once per thread, and a listing this duty was
  // never going to act on is a request worth not making at all.
  if (authority.warrant.unnamed("translate")) {
    acc.ungranted = notGranted(authority.warrant);
    return;
  }

  const listed = await listOpenThreads(api, context.repo, settings.since);
  acc.candidates = listed.length;

  for (const thread of listed) {
    if (acc.results.length >= settings.limit) break;

    // The idempotent skip: a body already carrying this duty's marker has been
    // translated at least once before, whatever the exact language set was
    // that run — the same "already decided about" reading `alreadyTaxonomized`
    // gives triage's skip, and free for the same reason: nothing here calls
    // the tracker or a model, only `marker.split` on text the listing already
    // fetched.
    if (marker.split(thread.body).fingerprint !== null) {
      acc.skipped += 1;
      continue;
    }

    if (starved(settings.models, weather)) {
      acc.starvedRun = true;
      break;
    }

    const at = { ...context.repo, number: thread.number };
    const result = await processThread(api, at, thread.body, settings, stages, weather);
    acc.results.push({ number: thread.number, outcome: describeOutcome(result) });
  }
}

export async function run(): Promise<void> {
  // Declared out here, and written in `finally`, so a run that fails halfway
  // still reports what it did and what it spent — including a sweep stopped
  // early by capacity starvation, which leaves `bulk` holding every thread
  // already processed before the loop broke.
  const meter = createMeter();
  const weather = createWeather();
  let settings: Settings | null = null;
  let authority: Authority | null = null;
  let single: { readonly number: number; readonly result: ThreadResult } | null = null;
  let bulk: SweepAccumulator | null = null;

  try {
    const base = readSettings();
    const api = getOctokit(base.token);
    const provider = createProvider({ baseUrl: base.baseUrl, apiKey: base.apiKey });

    const stages: Stages = {
      detect: metered(provider, meter, "detect"),
      draft: metered(provider, meter, "draft"),
      judge: metered(provider, meter, "judge"),
    };

    const read = await readWarrant(base.warrant, { defaultPath: DEFAULT_WARRANT_PATH });
    authority = await resolveAuthority(read, base.warrant, api, context.repo);

    // Only now, for the same reason triage waits: whether the warrant or the
    // input answers `languages` is the authority's to decide, and only once it
    // has can `settings` become the object every stage below already expects.
    const resolution = resolveLanguages(authority.warrant, core.getInput("languages"));
    if (resolution.notice !== null) core.notice(resolution.notice);

    settings = {
      ...base,
      languages: resolution.languages,
      permitted: authority.warrant.granted("translate", DEFAULT_CAPABILITIES),
    };

    if (settings.sweep) {
      bulk = newAccumulator();
      await runSweep(bulk, api, authority, settings, stages, weather);
    } else {
      const number = settings.number;
      // `readShared` refuses `sweep` combined with `number`, but a bare
      // `sweep: false` still leaves `number` nullable in the type — this is
      // the one place that has to become certain of it.
      if (number === null) throw new Error("number: required outside `sweep`.");
      const at = { ...context.repo, number };

      // The same once-before-anything-else short-circuit as `runSweep`'s,
      // reached here instead for the single thread this run named — a thread
      // this duty was never going to be allowed to touch is not worth a
      // request to read it.
      let result: ThreadResult;
      if (authority.warrant.unnamed("translate")) {
        result = {
          looked: [],
          translated: {
            what: `#${String(number)}`,
            from: null,
            posted: [],
            skipped: [],
            note: null,
            published: false,
          },
          replies: 0,
          ungranted: notGranted(authority.warrant),
        };
      } else {
        const body = await createThread(api, at).read();
        result = await processThread(api, at, body, settings, stages, weather);
      }
      single = { number, result };
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    // Nothing to report when the settings themselves were the problem: no
    // request was made, and a page saying so would be a page about a typo.
    if (settings !== null && authority !== null) {
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
        await writeSummary(sweepPage(settings, bulk, meter.spent()));
      } else if (!settings.sweep && single !== null) {
        report(single.result.translated, single.result.replies, rosterStarved);
        await writeSummary(page(settings, authority, single.number, single.result, meter.spent()));
      }
    }
  }
}

/**
 * Every output, written on every path that reaches an answer — including the
 * ones that answer "nothing". A workflow branching on `skipped` needs it to be
 * an empty array rather than an unset output on the run where everything worked.
 *
 * The three language outputs describe the thread's own body and not its replies.
 * A reply has its own source language and its own skipped set, and folding
 * twelve of those into one array would produce a value no workflow could act on
 * — so replies report the one thing that is answerable across all of them: how
 * many got a translation written.
 */
function report(translated: Report, replies: number, rosterStarved: boolean): void {
  core.setOutput("source-language", translated.from?.code ?? "");
  core.setOutput("translated", JSON.stringify(translated.posted.map((entry) => entry.to.code)));
  core.setOutput("skipped", JSON.stringify(translated.skipped.map((language) => language.code)));
  core.setOutput("replies-translated", String(replies));
  core.setOutput("starved", String(rosterStarved));
  // `0`, not unset: `processed`/`remaining` are a sweep's own outputs, and a
  // single-thread run answers both honestly at zero rather than leaving a
  // workflow that reads them on every run reading an empty string on this one.
  // `skipped` is not repeated here — this mode already gave it its own meaning
  // two lines up.
  core.setOutput("processed", "0");
  core.setOutput("remaining", "0");
}

/**
 * `processed`, `skipped` and `remaining` — a sweep's own outputs.
 *
 * `skipped` means something different here than it does in `report` above: a
 * count of threads rather than a JSON array of language codes. The two never
 * run in the same job — `sweep` and `number` are mutually exclusive at
 * `readShared` — so the name is free to mean whichever thing this mode
 * actually has, and `action.yml` documents both readings under it rather than
 * inventing a second output nobody would think to look for.
 */
function reportSweep(bulk: SweepAccumulator, rosterStarved: boolean): void {
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("skipped", String(bulk.skipped));
  core.setOutput("remaining", String(remainingOf(bulk)));
  core.setOutput("starved", String(rosterStarved));
}

function page(
  settings: Settings,
  authority: Authority,
  thread: number,
  result: ThreadResult,
  spent: Run["spent"],
): string {
  return summarize({
    thread,
    dryRun: settings.dryRun,
    looked: result.looked,
    spent,
    modelNames: settings.modelNames,
    judgeNames: settings.judgeNames,
    warrant: settings.warrant,
    implicit: authority.implicit,
    ungranted: result.ungranted,
  });
}

function sweepPage(settings: Settings, bulk: SweepAccumulator, spent: Run["spent"]): string {
  return summarizeSweep({
    dryRun: settings.dryRun,
    results: bulk.results,
    skipped: bulk.skipped,
    remaining: remainingOf(bulk),
    starvedRun: bulk.starvedRun,
    spent,
    modelNames: settings.modelNames,
    judgeNames: settings.judgeNames,
    warrant: settings.warrant,
    ungranted: bulk.ungranted,
  });
}

await run();
