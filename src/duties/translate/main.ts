/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. Each decision it reaches for lives in a
 * module that is tested on its own — most of them in the core, which is shared
 * with every other duty — and the only judgement made here is the order they run
 * in and what a failure at each step means for the run:
 *
 *   1. Read the warrant — or, missing one at the default path, build the
 *      implicit warrant the same way triage does. `languages` comes from the
 *      warrant's own `languages:` key — or, the key silent, the duty's
 *      documented default (`DEFAULT_LANGUAGES` below).
 *   1a. A written `duties:` block that does not name `translate` is
 *      checked here, once, before a single thread is read — sweep or not,
 *      exactly as triage's own enumeration is total. Nothing below this line
 *      runs; the summary says why, and the run is green.
 *   1b. Read the glossary at `glossary-dir` — the terms this project keeps in
 *      one spelling, whatever language a thread is translated into. One
 *      Contents API read for the whole run, empty when there is no file, which
 *      is the common case. The same file `harmonise` reads.
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
 *      warrant's `duties:` block was written without granting
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
 * What is left here, after `engine.ts` (the draft-and-judge loop), `text.ts`
 * (steps 2–9, per text), `budget.ts` (the max-requests budget) and
 * `inputs.ts` (the pure parsing behind `targets`/`readBody`/chunking) each
 * took their own piece, is the wiring above and the one function reading
 * inputs directly: `readSettings` — `readAttribution` is shared with
 * `duplicate` and lives in `core/inputs.ts`. `main.integration.test.ts`'s
 * own audit of every `getInput`/`getBooleanInput` call scans exactly two
 * files — this one and `core/inputs.js` — for the call sites it expects; a
 * function that calls `core.getInput` has to live in one of those two places
 * or that test stops proving what it proves.
 *
 * **This duty's `dryRun` check lives inside `text.ts`'s `translateText`**,
 * between drafting and the `edit-body` permission check — not here at the
 * call site the way triage checks it, and not inside `act` the way duplicate
 * does. See `translateText`'s own doc comment for why the ordering there is
 * load-bearing; the three duties' three placements are an accepted
 * divergence (design §1.2), not something this wave unifies.
 *
 *
 * **What this file no longer does, because `core/` does it for every duty
 * that needs it.** Reading the shared inputs (`readCore`), assembling the
 * provider client with its rotation, temperature and metering
 * (`assembleClient`), opening the authority — warrant file or the implicit
 * one — and warning about withheld capabilities (`openAuthority`), walking
 * the backlog (`sweepThreads`), and ending the run
 * (`warnIfStarved`, `writeRunSummary`, `reportNoSweep`). Each of those was a
 * near-copy in four or five duties; each is now one tested module, called
 * from here.
 *
 * This file is excluded from coverage because it calls `run()` at import, so
 * measuring it would execute the action. It is exercised by driving the built
 * bundle against a stub API, which is what a runner does — see
 * `main.integration.test.ts`.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { listOpenThreads, readStanding } from "../../core/forge.js";
import { loadGlossary, type GlossaryEntry } from "../../core/glossary.js";
import {
  bounded,
  parseAttribution,
  readShared,
  whole,
  type ApiKeySpec,
  type EndpointSpec,
} from "../../core/inputs.js";
import { type Language, parseLanguages } from "../../core/languages.js";
import { isFingerprint, isReeveProposalPr } from "../../core/marker.js";
import {
  assembleClient,
  createWeather,
  parseSeats,
  settleAuth,
  type Names,
  type Weather,
} from "../../core/provider.js";
import { createMeter, type Meter } from "../../core/meter.js";
import {
  warnIfStarved,
  warnIfPanelIdle,
  failIfRosterExhausted,
  writeRunSummary,
} from "../../core/summary.js";
import {
  newAccumulator,
  remainingOf,
  reportNoSweep,
  sweepThreads,
  type SweepAccumulator as Accumulator,
} from "../../core/sweep.js";
import {
  dutyLanguages,
  openAuthority,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";

import { budgetExhausted, createBudget, type Budget } from "./budget.js";
import { type Stages } from "./engine.js";
import { parseChunkChars } from "./inputs.js";
import { summarize, summarizeSweep, type Run, type SweptThread } from "./summary.js";
import { processThread, type Report, type ThreadResult } from "./text.js";
import { marker, type Attribution } from "./publish.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";

/** This sweep's progress: the shared accumulator, holding this duty's own rows. */
type SweepAccumulator = Accumulator<SweptThread>;

/**
 * What `translate` translates into when the warrant's `languages:` key is
 * silent — the duty's own documented default, resolved when nothing in the
 * warrant has an opinion.
 */
const DEFAULT_LANGUAGES: readonly Language[] = parseLanguages("en, vi, zh");

export interface Settings {
  readonly token: string;
  /** The thread to work on, or null in `sweep`. */
  readonly number: number | null;
  readonly models: readonly string[];
  /** What to call each of them, keyed by model id. */
  readonly modelNames: Names;
  readonly languages: readonly Language[];
  readonly warrant: string;
  /** What the file grants — the sole authority, so the run's only `permitted` list. */
  readonly permitted: readonly Capability[];
  readonly judges: readonly (readonly string[])[];
  /** What to call each seat, keyed by every model that seat may be filled by. */
  readonly judgeNames: Names;
  readonly drafts: number;
  /** `null` is no bound at all — see `bounded`'s doc comment for the sentinel rule. */
  readonly maxBodyChars: number | null;
  readonly replies: boolean;
  /** How many of a thread's newest replies one run reads. `null` is no bound. */
  readonly maxReplies: number | null;
  /** How large one chunk of a body can be before it is its own request. See `parseChunkChars`. */
  readonly chunkChars: number;
  /** Where the glossary lives in the repository — the path `glossary-dir` named. */
  readonly glossaryDir: string;
  /**
   * The terms this project keeps in one spelling, read from `glossaryDir` once
   * per run and handed to every draft and every score. Empty when there is no
   * file at that path, which is the common case — see `core/glossary.ts`.
   */
  readonly glossary: readonly GlossaryEntry[];
  /**
   * How many provider requests — detection, drafting and judging combined —
   * this run may spend before it stops asking for more. `null` is no bound.
   * See `budgetExhausted`.
   */
  readonly maxRequests: number | null;
  readonly attribution: Attribution;
  /**
   * Whether the published block carries the line naming what wrote it. Applies
   * to a thread's body only — `translateReplies` refuses it for a reply
   * whatever this says, so a chatty thread never collects one logo per comment.
   */
  readonly branding: boolean;
  readonly dryRun: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly sweep: boolean;
  readonly since: Date | null;
  readonly limit: number | null;
  readonly endpoints: readonly EndpointSpec[];
  readonly apiKeys: readonly ApiKeySpec[];
  readonly requestTimeoutMs: number;
  readonly temperature: number | undefined;
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
 * `languages`, `permitted` and `glossary` are missing from what this returns.
 * The first two need the warrant and the third needs a Contents API read, and
 * all three are async while every other input here is not — `run` completes the
 * object once `resolveAuthority` and the glossary read have answered.
 */
function readSettings(): Omit<Settings, "languages" | "permitted" | "glossary"> {
  const shared = readShared();
  const panel = parseSeats(core.getInput("judge-models"));

  return {
    ...shared,
    warrant: core.getInput("warrant", { required: true }),
    judges: panel.seats,
    judgeNames: panel.names,
    drafts: whole("drafts", core.getInput("drafts")),
    maxBodyChars: bounded("max-body-chars", core.getInput("max-body-chars")),
    replies: core.getBooleanInput("translate-replies"),
    maxReplies: bounded("max-replies", core.getInput("max-replies")),
    chunkChars: parseChunkChars(core.getInput("chunk-chars")),
    glossaryDir: core.getInput("glossary-dir", { required: true }),
    maxRequests: bounded("max-requests", core.getInput("max-requests")),
    attribution: readAttribution(),
    // Read here rather than anywhere deeper for the reason this file's own
    // header gives: the action-contract audit scans exactly two files for
    // `getInput` call sites, and a third would leave it proving less than it
    // claims to.
    branding: core.getBooleanInput("show-branding"),
  };
}

/**
 * `show-attribution`, read in this file and parsed by the shared
 * `parseAttribution` in `core/inputs.ts`. The getInput call stays here so the
 * action-contract audit keeps seeing it in one of the two files it scans.
 */
function readAttribution(): Attribution {
  return parseAttribution(core.getInput("show-attribution"));
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
    `\`${warrant.path}\`'s \`duties:\` block does not name \`translate\`; once that block ` +
    "exists it is the whole answer, so add `translate: [edit-body]` to it (or remove the block " +
    "to return to defaults)."
  );
}

/**
 * A single-thread run's placeholder result for a thread this duty never
 * reached `translateText` for — shared by the two reasons that short-circuit
 * before a read: no grant at all, and the recursion guard below.
 */
function skippedResult(number: number, reason: string): ThreadResult {
  return {
    looked: [],
    translated: {
      what: `#${String(number)}`,
      from: null,
      posted: [],
      skipped: [],
      budgetSkipped: [],
      note: null,
      published: false,
    },
    replies: 0,
    ungranted: reason,
  };
}

/**
 * Recursion guard: Reeve never translates its own proposal pull request's
 * body — see `isReeveProposalPr`'s own doc comment for why the marker alone
 * is a complete signal.
 */
const RECURSION_GUARD_REASON =
  "This is Reeve's own proposal pull request — every duty skips it, translate included.";

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
  meter: Meter,
  budget: Budget,
): Promise<void> {
  // Once, before the listing — exactly as triage's sweep — because the warrant
  // is checked once per run, not once per thread, and a listing this duty was
  // never going to act on is a request worth not making at all.
  if (authority.warrant.unnamed("translate")) {
    acc.ungranted = notGranted(authority.warrant);
    return;
  }

  const listed = await listOpenThreads(api, context.repo, settings.since);

  await sweepThreads(acc, listed, settings, weather, {
    alreadyDone: (thread) =>
      // The idempotent skip: a body already carrying this duty's marker has
      // been translated at least once before, whatever the exact language set
      // was that run — the same "already decided about" reading triage's own
      // marker-carrying skip gives it, and free for the same reason: nothing
      // here calls the tracker or a model, only `marker.split` on text the
      // listing already fetched.
      //
      // The digest, not the marker: the marker's shape is public and anyone
      // can type it, so `<!-- reeve:translate source= -->` (or any payload that
      // is not a real digest) carries no evidence a translation exists — and
      // counts as untranslated, so a forged empty marker cannot permanently
      // withhold a thread from sweeps. A real 16-hex digest is the only claim
      // of prior work this line accepts.
      //
      // Recursion guard on the same line: Reeve never translates its own
      // proposal pull request, and the listing already carries `isPullRequest`
      // and `body`, so this costs nothing beyond the marker check.
      isFingerprint(marker.split(thread.body).fingerprint ?? "") || isReeveProposalPr(thread),
    // The same self-imposed ceiling `translateText` and `translateReplies`
    // check within one thread, checked here as well so a sweep never starts a
    // thread it cannot even begin — leaving it for `remaining` is cheaper
    // than starting it and stopping mid-language. `budget.denied` is what
    // `run`'s `finally` reads back; nothing here needs its own copy of the
    // answer, including when the very last candidate is the one that denies
    // work inside its own per-language or per-reply checkpoint with no
    // further iteration left to notice — `budget` already has it by then.
    exhausted: () => budgetExhausted(settings, meter, budget),
    processOne: async (thread) => {
      const at = { ...context.repo, number: thread.number };
      const result = await processThread(
        api,
        at,
        thread.body,
        settings,
        stages,
        weather,
        meter,
        budget,
        failIfRosterExhausted,
      );
      return { number: thread.number, outcome: describeOutcome(result) };
    },
  });
}

export async function run(): Promise<void> {
  // Declared out here, and written in `finally`, so a run that fails halfway
  // still reports what it did and what it spent — including a sweep stopped
  // early by capacity starvation, which leaves `bulk` holding every thread
  // already processed before the loop broke.
  const meter = createMeter();
  // `denied` is set exactly once, by `budgetExhausted` — see `createBudget`'s
  // doc comment in `budget.ts` for why one mutable object rather than a
  // recomputed boolean.
  const budget = createBudget();
  // Reassigned once `readSettings` has answered, inside the `try` below —
  // `endpoints` is not known until then. Left at its empty-alias default if
  // reading the settings themselves is what fails, which is fine: nothing
  // below that point ever runs.
  let weather = createWeather();
  let settings: Settings | null = null;
  let authority: Authority | null = null;
  let single: { readonly number: number; readonly result: ThreadResult } | null = null;
  let bulk: SweepAccumulator | null = null;

  try {
    const base = readSettings();
    warnIfPanelIdle(base.judges, base.drafts);
    const client = assembleClient(base, meter, ["detect", "draft", "judge"] as const, [
      base.judges.flat(),
    ]);
    weather = client.weather;
    const api = getOctokit(base.token);
    const stages: Stages = client.stages;

    const opened = await openAuthority(base.warrant, api, context.repo, "translate");
    authority = opened.authority;
    const denied = opened.denied;

    // Only now, for the same reason triage waits: whether the warrant answers
    // `languages` is the authority's to decide, and only once it has can
    // `settings` become the object every stage below already expects. Except
    // when the same authority already denied this duty outright — that run is
    // promised a green no-op, and a duty that will never translate has no
    // business failing red over a `languages` nobody configured for it.
    const languages = dutyLanguages(authority.warrant, denied, DEFAULT_LANGUAGES);

    // Once, and only for the run nobody has configured at all: the warrant
    // never wrote `languages:`. Saying so once is cheap next to staying
    // silent forever about a choice nobody actually made.
    if (!denied && authority.warrant.languages === null) {
      core.notice(
        "languages: running on the default (`en, vi, zh`) — nobody has set this yet. " +
          "Write `languages:` in the warrant to choose on purpose.",
      );
    }

    // The file is the whole authority — nothing upstream can widen or narrow
    // it, so the grant is the permitted list, decided once here for the run.
    const permitted = authority.warrant.granted("translate", DEFAULT_CAPABILITIES);

    // One Contents API read for the whole run, before a single thread is
    // looked at. The glossary is repository configuration at the ref that
    // triggered this workflow — the same file `harmonise` reads, down to the
    // default path — so a sweep of a hundred threads reads it once rather than
    // once per thread, and a `dry-run` reads it exactly as a real run does:
    // nothing here writes anything. A missing file is the common case and is
    // silent, so this costs an ordinary 404 and no configuration at all.
    const glossary = await loadGlossary(api, context.repo, base.glossaryDir, "translate");
    if (glossary.length > 0) {
      core.info(
        `glossary: ${String(glossary.length)} term${glossary.length === 1 ? "" : "s"} from ` +
          `\`${base.glossaryDir}\` will be carried through unchanged.`,
      );
    }

    settings = {
      ...base,
      languages,
      permitted,
      glossary,
    };

    if (settings.sweep) {
      bulk = newAccumulator<SweptThread>();
      await runSweep(bulk, api, authority, settings, stages, weather, meter, budget);
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
        result = skippedResult(number, notGranted(authority.warrant));
      } else {
        const standing = await readStanding(api, at);
        // Same guard as the sweep's listing-time filter, checked here
        // instead against the one thread this run named directly — a
        // `number:` backfill has no listing to have filtered it out of.
        result = isReeveProposalPr(standing)
          ? skippedResult(number, RECURSION_GUARD_REASON)
          : await processThread(
              api,
              at,
              standing.body,
              settings,
              stages,
              weather,
              meter,
              budget,
              failIfRosterExhausted,
            );
      }
      single = { number, result };
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
    if (settings !== null && authority !== null) {
      const rosterStarved = warnIfStarved(settings.models, weather, settings.sweep);

      // `budget.denied` answers this the same way for both modes — see
      // `createBudget`'s doc comment in `budget.ts`.
      const budgetSpent = budget.denied;
      if (budgetSpent) {
        core.warning(
          "`max-requests` was reached this run. " +
            (settings.sweep
              ? "The sweep delivered what it could before the budget ran out, and " +
                "stopped early — see `remaining`."
              : "What was already drafted still publishes; anything past the budget " +
                "was left for a later run."),
        );
      }

      if (settings.sweep && bulk !== null) {
        reportSweep(bulk, rosterStarved, budgetSpent);
        await writeRunSummary(sweepPage(settings, bulk, meter.spent(), budgetSpent), weather);
      } else if (!settings.sweep && single !== null) {
        report(single.result.translated, single.result.replies, rosterStarved, budgetSpent);
        await writeRunSummary(
          page(settings, authority, single.number, single.result, meter.spent()),
          weather,
        );
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
function report(
  translated: Report,
  replies: number,
  rosterStarved: boolean,
  budgetSpent: boolean,
): void {
  core.setOutput("source-language", translated.from?.code ?? "");
  core.setOutput("translated", JSON.stringify(translated.posted.map((entry) => entry.to.code)));
  core.setOutput("skipped", JSON.stringify(translated.skipped.map((language) => language.code)));
  core.setOutput("replies-translated", String(replies));
  core.setOutput("starved", String(rosterStarved));
  core.setOutput("budget-exhausted", String(budgetSpent));
  // `skipped` is not repeated by `reportNoSweep` — this mode already gave it
  // its own meaning two lines up.
  reportNoSweep();
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
function reportSweep(bulk: SweepAccumulator, rosterStarved: boolean, budgetSpent: boolean): void {
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("skipped", String(bulk.skipped));
  core.setOutput("remaining", String(remainingOf(bulk)));
  core.setOutput("starved", String(rosterStarved));
  core.setOutput("budget-exhausted", String(budgetSpent));
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

function sweepPage(
  settings: Settings,
  bulk: SweepAccumulator,
  spent: Run["spent"],
  budgetSpent: boolean,
): string {
  return summarizeSweep({
    dryRun: settings.dryRun,
    results: bulk.results,
    skipped: bulk.skipped,
    remaining: remainingOf(bulk),
    starvedRun: bulk.starvedRun,
    budgetExhausted: budgetSpent,
    spent,
    modelNames: settings.modelNames,
    judgeNames: settings.judgeNames,
    warrant: settings.warrant,
    ungranted: bulk.ungranted,
  });
}

await run();
