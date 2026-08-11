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

import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import {
  alreadyTaxonomized,
  enforceLabels,
  narrow,
  owners,
  parseApply,
  type Refusal,
} from "../../core/enforce.js";
import {
  createEffects,
  isBotAuthor,
  listCorrectionFiles,
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
import { bounded, counted, fraction, readShared } from "../../core/inputs.js";
import { type Language } from "../../core/languages.js";
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
  createProvider,
  createWeather,
  parseModels,
  shown,
  starved,
  type Names,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { screen } from "../../core/screen.js";
import { sift } from "../../core/spam.js";
import { writeSummary } from "../../core/summary.js";
import {
  checkLabelsExist,
  readWarrant,
  resolveAuthority,
  resolveLanguages,
  type Authority,
  type Capability,
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
 * How many corrections reach the prompt.
 *
 * Not an input, deliberately. The number that matters is how many are close
 * enough to be worth showing, and that is what retrieval already decides —
 * anything scoring nothing is dropped before this cap applies. What is left is
 * a ceiling on prompt length, and a consumer tuning it would be tuning a proxy
 * for a cost the summary already shows them directly.
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
  readonly limit: number;
}

/**
 * Everything but `languages`, which cannot be read here: whether the warrant
 * or the input answers it is a question only `resolveAuthority`'s result can
 * settle, and that read is async while every other input here is not. `run`
 * completes the object once the warrant has been read.
 */
function readSettings(): Omit<Settings, "languages"> {
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
}

function newAccumulator(): SweepAccumulator {
  return { results: [], skipped: 0, starvedRun: false, candidates: 0, ungranted: null };
}

/**
 * The whole backlog, one thread at a time, through the identical pipeline a
 * single-thread run uses.
 *
 * Ungranted, capped labels-exist checking and per-thread deciding all happen
 * exactly once each — the first two before the loop, because they are facts
 * about the run rather than about any one thread, and the last one inside it,
 * because that is `decide`'s whole job.
 */
async function runSweep(
  acc: SweepAccumulator,
  api: TrackerApi,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<void> {
  if (authority.warrant.unnamed("triage")) {
    acc.ungranted = notGranted(authority.warrant).ungranted;
    return;
  }

  if (!authority.implicit) {
    checkLabelsExist(
      authority.warrant,
      (await listRepositoryLabels(api, context.repo)).map((label) => label.name),
    );
  }

  const listed = await listOpenThreads(api, context.repo, settings.since);
  // Triage sweeps issues only — a taxonomy of bug/docs/feature labels is a
  // judgement about an issue, and the listing endpoint returns pull requests
  // too, distinguishable only by this field.
  const candidates = listed.filter((thread) => !thread.isPullRequest);
  acc.candidates = candidates.length;

  for (const thread of candidates) {
    if (acc.results.length >= settings.limit) break;

    // The idempotent skip: free, and counted separately from `processed` so a
    // rerun over a mostly-triaged backlog reports honestly rather than looking
    // like it did nothing.
    if (alreadyTaxonomized(authority.warrant, thread.labels)) {
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
    };
    const outcome = await decide(authority, standing, settings, stages, weather);
    const done = settings.dryRun
      ? NOTHING_DONE
      : await act(createEffects(api, at), authority.warrant, outcome);
    acc.results.push({ number: thread.number, outcome: describeOutcome(outcome, done) });
  }
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
  const weather = createWeather();
  let settings: Settings | null = null;
  let single: { readonly number: number; readonly outcome: Outcome; readonly done: Done } | null =
    null;
  let recorded: { readonly number: number; readonly outcome: RecordOutcome } | null = null;
  let bulk: SweepAccumulator | null = null;

  try {
    const base = readSettings();
    const api = getOctokit(base.token);
    const provider = createProvider({ baseUrl: base.baseUrl, apiKey: base.apiKey });

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
    settings = { ...base, languages: resolution === null ? [] : resolution.languages };

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
        if (!authority.implicit) {
          // Against the repository's own labels, so a taxonomy naming one
          // that was renamed fails as the configuration problem it is, rather
          // than arriving as a model that agreed with nothing. Skipped in
          // implicit mode: the taxonomy IS the repository's own labels there,
          // and checking it against itself would be a tautology.
          checkLabelsExist(
            authority.warrant,
            (await listRepositoryLabels(api, at)).map((label) => label.name),
          );
        }

        // `record` takes a labelled/unlabelled event, from a human, and only
        // when both the file and the workflow's `apply` grant it — the same
        // narrowing every other capability goes through. Every other event,
        // or the capability simply not granted, is today's behaviour: a
        // verdict, not a recording.
        const trigger = recordTrigger();
        const grantedCapabilities = authority.warrant.granted("triage", DEFAULT_CAPABILITIES);
        const { permitted } = narrow(grantedCapabilities, settings.apply);

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

        if (trigger.eligible && permitted.includes("record")) {
          recordOutcome = await recordCorrection(
            api,
            at,
            standing,
            authority,
            settings,
            stages,
            weather,
          );
        } else {
          outcome = await decide(authority, standing, settings, stages, weather);
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
        await writeSummary(sweepPage(settings, bulk, meter.spent()));
      } else if (!settings.sweep && recorded !== null) {
        reportRecordRun(recorded.outcome, rosterStarved);
        await writeSummary(recordPage(settings, recorded.number, recorded.outcome, meter.spent()));
      } else if (!settings.sweep && single !== null) {
        report(single.outcome, single.done, settings.dryRun, rosterStarved);
        await writeSummary(
          page(settings, single.number, single.outcome, single.done, meter.spent()),
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

  const store = await readStore(settings.corrections);
  for (const line of store.unreadable) {
    // Loud, because this is a committed file that maintainers open by hand:
    // losing one example is not worth losing the verdict, and losing it
    // silently is not worth anything.
    core.warning(`corrections: ${line}`);
  }
  const memory = createMemory(store.corrections);

  const queries: WeightedQuery[] = [{ text: `${standing.title}\n${body}`, against: "own" }];

  // The pivot bridge is worth a request only when it could change the answer:
  // the thread's own language has to be known, a pivot language has to be
  // configured, and the store has to hold at least one correction that is not
  // already in the thread's own language. A store that shares one language
  // with the thread has nothing a translated query would reach that the plain
  // one above does not already reach — so that case, the common one, spends
  // no provider call here at all.
  const pivotLanguage = settings.languages[0] ?? null;
  const threadLanguage = detection.language;
  const worthBridging =
    threadLanguage !== null &&
    pivotLanguage !== null &&
    store.corrections.some((correction) => correction.language !== threadLanguage.code);

  if (worthBridging) {
    const draft = await translateToPivot({
      provider: stages.pivot,
      models: settings.screenModels.length > 0 ? settings.screenModels : settings.models,
      title: standing.title,
      body,
      to: pivotLanguage,
      weather,
    });
    if (draft !== null) {
      queries.push({
        text: `${draft.title}\n${draft.body}`,
        against: { pivot: pivotLanguage.code },
      });
    } else {
      core.info(
        "Cross-language recall could not translate this thread into the pivot language this run " +
          "— recall used the thread's own language only.",
      );
    }
  }

  const recalled = memory.recallAcrossQueries(queries, RECALLED);
  const pivotRecalled =
    threadLanguage === null
      ? 0
      : recalled.filter(
          (correction) =>
            correction.language !== null && correction.language !== threadLanguage.code,
        ).length;
  core.info(
    `Recalled ${String(recalled.length)} of ${String(memory.size)} correction(s) ` +
      `from \`${settings.corrections}\`` +
      (pivotRecalled > 0
        ? `, ${String(pivotRecalled)} of them recorded in a language other than the thread's.`
        : "."),
  );

  const triaged = await triage({
    provider: stages.triage,
    models: settings.models,
    title: standing.title,
    body,
    taxonomy: warrant.labels,
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
    memory: { size: memory.size, recalled: recalled.length, pivotRecalled },
    implicit: authority.implicit,
    excludedLabels: authority.excludedLabels,
    ungranted: null,
  } as const;

  // The floor before the taxonomy, so a verdict nobody trusts is not also
  // reported as four labels the warrant refused. It proposed them; it was
  // simply not confident enough for that to be the interesting part.
  if (verdict.confidence < settings.confidence) {
    if (verdict.labels.length > 0) {
      core.info(
        `Confidence ${verdict.confidence.toFixed(2)} is under the floor of ` +
          `${settings.confidence.toFixed(2)} — reported, not applied.`,
      );
    }
    return { ...decided, applied: [], refused: [] };
  }

  const decision = enforceLabels(warrant, verdict.labels, standing.labels);
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
 */
async function recordCorrection(
  contentsApi: ContentsApi,
  at: Location,
  standing: Standing,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<RecordOutcome> {
  const warrant = authority.warrant;
  const limit = settings.maxBodyChars;
  const body = limit === null ? standing.body : standing.body.slice(0, limit);

  const detection = await detectLanguage(
    body.length === 0 ? standing.title : body,
    settings.languages,
    createLanguagePicker(
      stages.detect,
      settings.screenModels.length > 0 ? settings.screenModels : settings.models,
      weather,
    ),
  );
  // The code, because that is what the store and the pivot comparison below
  // both compare against — the same convention `decide`'s recall path reads
  // corrections by. The output-facing `language` a maintainer reads on this
  // run's page is a different value, further down: the same label the
  // ordinary `decide` path reports, so a workflow reading this action's
  // `language` output sees the same shape whichever path produced it.
  const code = detection.language?.code ?? null;

  // Taxonomy-filtered: a label some other tool or automation applied is not a
  // maintainer correcting this duty's taxonomy, and recording it would teach
  // recall a category triage was never asked to propose.
  const decidedLabels = standing.labels.filter((name) => warrant.labelNamed(name) !== undefined);

  const pivotLanguage = settings.languages[0] ?? null;
  let pivot: Correction["pivot"] = null;
  let pivotNote: string | null = null;
  if (pivotLanguage !== null && code !== null && code !== pivotLanguage.code) {
    const draft = await translateToPivot({
      provider: stages.pivot,
      models: settings.screenModels.length > 0 ? settings.screenModels : settings.models,
      title: standing.title,
      body,
      to: pivotLanguage,
      weather,
    });
    if (draft !== null) {
      pivot = {
        language: pivotLanguage.code,
        title: draft.title,
        excerpt: draft.body.slice(0, EXCERPT),
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
    thread: at.number,
    at: new Date().toISOString(),
    title: standing.title,
    excerpt: body.slice(0, EXCERPT),
    language: code,
    proposed: [],
    decided: decidedLabels,
    by: senderLogin(),
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
    await writeCorrection(contentsApi, at, settings.corrections, correction);
  }

  return {
    recorded: true,
    language: detection.language?.label ?? null,
    decided: decidedLabels,
    pivot: pivot !== null,
    pivotNote,
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
    const index = lines.findIndex((line) => {
      if (line.trim().length === 0) return false;
      const existing = parseCorrection(line);
      return existing !== null && existing.thread === correction.thread;
    });

    if (index !== -1) {
      lines[index] = formatCorrection(correction);
      await writeContentsFile(
        contentsApi,
        at,
        file.path,
        `${lines.join("\n").replace(/\n*$/, "")}\n`,
        commitMessage(correction),
        file.sha,
      );
      return;
    }
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
  const shard = `${path.replace(/\/+$/, "")}/${monthShard()}.ndjson`;
  const existing = await readContentsFile(contentsApi, at, shard);
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
  // A sweep never records either — `record` fires on a single labelled event,
  // never on a backlog walk — so this is `false` on every sweep run too.
  core.setOutput("recorded", "false");
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
    spent,
    modelNames: settings.modelNames,
    screenNames: settings.screenNames,
  });
}

await run();
