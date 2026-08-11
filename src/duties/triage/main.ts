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
  listOpenThreads,
  listRepositoryLabels,
  readStanding,
  type Effects,
  type Standing,
  type TrackerApi,
} from "../../core/forge.js";
import { counted, fraction, readShared, whole } from "../../core/inputs.js";
import { type Language } from "../../core/languages.js";
import { createMemory, readStore } from "../../core/memory.js";
import { createMeter, metered } from "../../core/meter.js";
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

import { sift } from "./spam.js";
import { summarize, summarizeSweep, type Done, type Run, type SweptThread } from "./summary.js";
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
  readonly maxBodyChars: number;
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
    maxBodyChars: whole("max-body-chars", core.getInput("max-body-chars")),
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
  readonly memory: { readonly size: number; readonly recalled: number };
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
  let bulk: SweepAccumulator | null = null;

  try {
    const base = readSettings();
    const api = getOctokit(base.token);
    const provider = createProvider({ baseUrl: base.baseUrl, apiKey: base.apiKey });

    const stages: Stages = {
      detect: metered(provider, meter, "detect"),
      screen: metered(provider, meter, "screen"),
      triage: metered(provider, meter, "triage"),
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
    const resolution = resolveLanguages(authority.warrant, core.getInput("languages"));
    if (resolution.notice !== null) core.notice(resolution.notice);
    settings = { ...base, languages: resolution.languages };

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
      let outcome: Outcome;
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
        outcome = await decide(authority, standing, settings, stages, weather);
      }

      const done = settings.dryRun
        ? NOTHING_DONE
        : await act(createEffects(api, at), authority.warrant, outcome);
      single = { number, outcome, done };
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
  const body = standing.body.slice(0, settings.maxBodyChars);
  if (standing.body.length > settings.maxBodyChars) {
    // Said, because a truncated body is a verdict reached on less than the
    // author wrote, and whoever reads that verdict deserves to know which.
    core.warning(
      `Only the first ${String(settings.maxBodyChars)} characters of the body were read. ` +
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
    memory: { size: 0, recalled: 0 },
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
  const recalled = memory.recall(`${standing.title}\n${body}`, RECALLED);
  core.info(
    `Recalled ${String(recalled.length)} of ${String(memory.size)} correction(s) ` +
      `from \`${settings.corrections}\`.`,
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
    memory: { size: memory.size, recalled: recalled.length },
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
    memory: { size: 0, recalled: 0 },
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
