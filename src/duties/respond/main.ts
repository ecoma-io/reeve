/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * This is the top rung. Every other duty edits or labels something a
 * maintainer can quietly revert; this one writes a comment that reads, to
 * everyone downstream of it, as though somebody from the project answered.
 * That is the whole reason its defaults are the strictest in this repository
 * — `DEFAULT_CAPABILITIES` (see `capabilities.ts`) is empty, unlike every
 * other duty's — and the reason two of its guards (a human already spoke; a
 * thread already carries this duty's marker) are not inputs at all. An input
 * can be misconfigured. A guard that is code cannot be.
 *
 * The order:
 *
 *   1. Read the warrant, or build the implicit one, exactly as every other
 *      duty does. A `capabilities:` block that does not name `respond` is
 *      checked here, once, before a single request — the summary says why,
 *      and the run is green.
 *   2. Read the thread. An issue opened by a bot is not answered — replying
 *      to one is not what a "first reply" means, and no draft is worth
 *      writing for it.
 *   3. Walk the replies once, oldest first, and stop at whichever comes
 *      first: this duty's own marker, or a human's own reply. Both end the
 *      run for good rather than just this attempt. respond answers a thread
 *      once — it is not a chatbot, and it does not converse — so its own
 *      marker already on the thread means there is nothing left to decide,
 *      no matter how many times the issue has been edited since: an author
 *      editing their issue does not earn a second reply, and there is no
 *      input that farms one. A human's own reply means this duty is too
 *      late, and stays too late for — there is no input that lets it speak
 *      over a person either.
 *   4. Screen for spam and off-topic threads the same cheap way triage does,
 *      before a single expensive request is spent — a first-reply bot that
 *      courteously answers spam is a spam amplifier, not a feature.
 *   5. Detect the language the thread was opened in.
 *   6. Recall the nearest corrections this project has already made, bridged
 *      across languages through the pivot the same way triage does.
 *   7. Draft, judge, and compare the winner's confidence against the floor.
 *   8. Post — unless the floor, the double gate (`apply` and the warrant
 *      both have to grant `comment`), or `dry-run` withholds it. The draft
 *      itself is always reported on `respond-text`, whether or not it was
 *      posted, so a repository can route it to review instead.
 *
 * This file is excluded from coverage because it calls `run()` at import, so
 * measuring it would execute the action. It is exercised by driving the
 * built bundle against a stub API — see `main.integration.test.ts`.
 *
 * What is left here, rather than in `draft.ts`, `judge.ts`, `publish.ts`,
 * `guidance.ts` or `summary.ts`, is what does not stand alone from `decide`'s
 * own control flow: settings, the guards in points 2 and 3 above (including
 * `walkReplies`, the reply-walk guard's own read), and the two functions that
 * turn one run's `Outcome` into `core.setOutput` calls and a summary page.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import { createEffects, listReplies, readStanding, type Location } from "../../core/forge.js";
import {
  bounded,
  fraction,
  readCore,
  resolveEndpoints,
  threadNumber,
  whole,
  type Core,
} from "../../core/inputs.js";
import { type Language } from "../../core/languages.js";
import { isReeveProposalPr } from "../../core/marker.js";
import { createMemory, readStore, type Correction, type WeightedQuery } from "../../core/memory.js";
import { createMeter, metered } from "../../core/meter.js";
import { parseApply, narrow } from "../../core/enforce.js";
import { translateToPivot } from "../../core/pivot.js";
import {
  createRoutedProvider,
  createWeather,
  parseModels,
  parseSeats,
  settleAuth,
  shown,
  starved,
  type Names,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { assemble } from "../../core/publish.js";
import { sift } from "../../core/spam.js";
import { authSection, writeSummary } from "../../core/summary.js";
import {
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

import { draft } from "./draft.js";
import { readGuidance } from "./guidance.js";
import { judge } from "./judge.js";
import {
  marker,
  publication,
  responseFingerprint,
  type Decision,
  type Responded,
} from "./publish.js";
import { summarize, type Run } from "./summary.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";

/** `warrant`'s own default in `action.yml`, repeated here rather than read back out of it. */
const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

/** How many recalled corrections `draft.ts` is handed. Same figure triage uses. */
const RECALLED = 4;

interface Settings extends Core {
  readonly number: number;
  /** The languages this run reads. Resolved from the warrant or the input — see `resolveLanguages`. */
  readonly languages: readonly Language[];
  readonly warrant: string;
  /** What this run may do, from the `apply` input alone — narrowed against the warrant per run. */
  readonly apply: readonly Capability[];
  readonly judges: readonly (readonly string[])[];
  readonly judgeNames: Names;
  readonly drafts: number;
  readonly confidence: number;
  /** Repo-relative path to the maintainer-authored guidance file. */
  readonly guidance: string;
  /** `null` is no bound at all — see `bounded`'s doc comment for the sentinel rule. */
  readonly maxBodyChars: number | null;
  readonly corrections: string;
  /** The cheap roster asked whether a thread is spam or off-topic. Empty turns the check off. */
  readonly screenModels: readonly string[];
  readonly screenNames: Names;
  /** What this repository is about, in the maintainer's own words — the same input triage reads. */
  readonly about: string;
}

/**
 * The inputs, parsed and rejected here rather than deeper in.
 *
 * Built on `readCore` rather than `readShared` — that helper also reads
 * `sweep`, `since` and `limit`, which this duty does not have an opinion
 * about at all. `respond` answers one thread, the one that triggered it: an
 * issue's first reply is not something a backfill writes retroactively over a
 * backlog, it is something that happens once, when the thread is new. So this
 * reads exactly the inputs `action.yml` declares, no more.
 *
 * `languages` is missing from what this returns, the same way it is missing
 * from translate's `readSettings`: it needs the warrant, and reading the
 * warrant is async while every other input here is not — `run` completes the
 * object once `resolveAuthority` has answered.
 */
function readSettings(): Omit<Settings, "languages"> {
  // First, so that `api-key` is registered as a secret before anything this
  // duty adds on top of it can fail and get quoted into a log.
  const base = readCore();
  const panel = parseSeats(core.getInput("judge-models"));
  const cheap = parseModels(core.getInput("screen-models"));

  return {
    ...base,
    number: threadNumber(),
    warrant: core.getInput("warrant", { required: true }),
    apply: parseApply(core.getInput("apply", { required: true })),
    judges: panel.seats,
    judgeNames: panel.names,
    drafts: whole("drafts", core.getInput("drafts")),
    confidence: fraction("confidence", core.getInput("confidence")),
    guidance: core.getInput("guidance"),
    maxBodyChars: bounded("max-body-chars", core.getInput("max-body-chars")),
    corrections: core.getInput("corrections", { required: true }),
    screenModels: cheap.models,
    screenNames: cheap.names,
    about: core.getInput("about"),
  };
}

/** One provider per stage, each counting its own requests under its own name. */
interface Stages {
  readonly screen: Provider;
  readonly detect: Provider;
  readonly draft: Provider;
  readonly judge: Provider;
  readonly pivot: Provider;
}

/** What one run decided, before it is turned into outputs or a summary page. */
interface Outcome {
  /** Why this run stopped before reaching a verdict. `null` once it reached one. */
  readonly note: string | null;
  readonly language: string | null;
  readonly responded: Responded | null;
  readonly confidence: number | null;
  readonly published: boolean;
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
}

/** What {@link settled} lets a call site override — everything else is `decide`'s own default. */
type Settled = Partial<
  Pick<Outcome, "note" | "language" | "responded" | "confidence" | "published">
>;

/**
 * Whichever comes first, on the thread's own page, oldest first: this duty's
 * own marker, or a human's own reply — see `decide`'s own doc comment,
 * point 3, for why both end the run for good. A page GitHub truncated before
 * either turned up means this duty cannot rule either out, and refuses to
 * guess. `null` is the only outcome that lets `decide` continue past it.
 */
async function walkReplies(
  api: ReturnType<typeof getOctokit>,
  at: Location,
  settled: (over: Settled) => Outcome,
): Promise<Outcome | null> {
  const { replies, more } = await listReplies(api, at);
  let alreadyAnswered = false;
  let humanFirst = false;
  for (const reply of replies) {
    if (marker.split(reply.body).fingerprint !== null) {
      alreadyAnswered = true;
      break;
    }
    if (!reply.isBot) {
      humanFirst = true;
      break;
    }
  }
  if (alreadyAnswered) {
    core.info(
      `#${String(at.number)}: already answered — respond speaks once and does not converse.`,
    );
    return settled({
      note:
        "This thread already carries this duty's own reply. respond answers a thread once and " +
        "does not converse — editing the issue does not earn a second reply, and there is no " +
        "input that reopens this.",
    });
  }
  if (humanFirst) {
    core.info(
      `#${String(at.number)}: a human already replied — this duty only ever writes the first reply.`,
    );
    return settled({
      note:
        "A human already replied to this thread before this run looked at it. Answering the " +
        "first reply is the whole of what this duty does, and there is no input that lets it " +
        "speak over a person who got there first.",
    });
  }
  if (more) {
    // Neither guard fired on the page this run actually read, and there is
    // more of the thread this run never saw — this duty's own marker, or a
    // human's reply, could be sitting past the first hundred. The top rung
    // fails closed rather than draft a reply on an "unanswered so far" guess
    // this thin: see D12 and this file's own doc comment on why an input
    // cannot widen this duty's authority to speak.
    core.warning(
      `#${String(at.number)}: the reply list was truncated before this duty could rule out its ` +
        "own marker or a human reply — refusing to guess.",
    );
    return settled({
      note:
        "Could not verify the thread is unanswered (reply list truncated). This duty stops rather " +
        "than draft — let alone post — a first reply it cannot be sure is still owed.",
    });
  }
  return null;
}

/**
 * The whole decision for one thread: whether to speak at all, what to say,
 * and whether this run was allowed to post it.
 */
async function decide(
  api: ReturnType<typeof getOctokit>,
  at: Location,
  warrant: Warrant,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<Outcome> {
  const { permitted, withheld } = narrow(
    warrant.granted("respond", DEFAULT_CAPABILITIES),
    settings.apply,
  );
  for (const capability of withheld) {
    core.warning(
      `\`apply\` asks for \`${capability}\`, which \`${warrant.path}\` does not grant to respond. ` +
        "The narrower of the two wins.",
    );
  }

  /**
   * Every one of this duty's thirteen `Outcome`-shaped returns goes through
   * here — the six early guards below that stop before a draft exists, the
   * six post-draft returns further down that stop with one already written,
   * and the one return that actually posts. All thirteen share `permitted`/
   * `withheld` (`narrow` decides both once, above, for the whole run) and the
   * same five defaults; each call site overrides only the fields that one
   * case actually differs by.
   */
  const settled = (over: Settled = {}): Outcome => ({
    note: null,
    language: null,
    responded: null,
    confidence: null,
    published: false,
    permitted,
    withheld,
    ...over,
  });

  const standing = await readStanding(api, at);
  // Recursion guard: Reeve never drafts a reply to its own proposal pull
  // request. In practice `standing.author.isBot` below would already stop
  // this — the proposal PR is opened under this run's own token — but the
  // guard is written explicitly rather than left to that coincidence, the
  // same one spelling every other duty checks.
  if (isReeveProposalPr(standing)) {
    return settled({
      note: "This is Reeve's own proposal pull request — every duty skips it, respond included.",
    });
  }
  if (standing.author.isBot) {
    core.info(`#${String(at.number)}: opened by a bot account — a first reply is not owed to one.`);
    return settled({
      note: "The issue's opener is a bot account, and a first reply is not owed to one — no draft was written.",
    });
  }

  // One read of the whole page, walked oldest first — GitHub's own order, and
  // the order a reader sees. Stops at whichever comes first: this duty's own
  // marker, or a human's own reply — both end the run for good, not just this
  // attempt. respond answers a thread once; its own marker already there
  // settles the question no matter how many times the issue has been edited
  // since, which is what keeps an edit from farming a second reply. A reply
  // from some other bot, or with neither trait, is neither — it is skipped,
  // and the walk continues past it. See `walkReplies`.
  const walked = await walkReplies(api, at, settled);
  if (walked !== null) return walked;

  const limit = settings.maxBodyChars;
  const body = limit === null ? standing.body : standing.body.slice(0, limit);
  if (limit !== null && standing.body.length > limit) {
    core.warning(
      `Only the first ${String(limit)} characters of the body were read. Raise \`max-body-chars\` to read the rest.`,
    );
  }

  // The same cheap screen triage runs, before a single expensive request —
  // spam and off-topic threads are not owed a courteous reply, and a
  // first-reply bot that gives them one is a spam amplifier. `sift` is a
  // no-op when `screen-models` is empty, which is the default.
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
    core.info(
      `#${String(at.number)}: screened out as ${sifted.dropped.reason} — ${sifted.dropped.note}.`,
    );
    return settled({
      note:
        `This thread was screened out as ${sifted.dropped.reason} — ${sifted.dropped.note}. A ` +
        "first reply is not owed to it.",
    });
  }

  const detection = await detectLanguage(
    body.length === 0 ? standing.title : body,
    settings.languages,
    createLanguagePicker(stages.detect, settings.models, weather, settings.temperature),
  );
  const language = detection.language;
  core.info(
    language === null
      ? `#${String(at.number)}: language not identified (${String(detection.candidates.length)} candidate(s)).`
      : `#${String(at.number)}: language ${language.code} (by ${detection.by}).`,
  );

  const record = responseFingerprint(standing.title, body, language?.code ?? null);

  // `recall: 0` (or a negative override) is a promise as much as a setting:
  // the store is not touched at all, not merely searched-and-returns-nothing
  // — the same contract triage's own recall gate honors.
  const recallCount = warrant.memory?.recall ?? RECALLED;
  let recalled: readonly Correction[] = [];

  if (recallCount > 0) {
    const store = await readStore(settings.corrections);
    for (const line of store.unreadable) core.warning(`corrections: ${line}`);
    const memory = createMemory(store.corrections);

    const queries: WeightedQuery[] = [{ text: `${standing.title}\n${body}`, against: "own" }];
    // The same pivot bridge triage uses: the first configured language is this
    // project's pivot, and a store with corrections in other languages is worth
    // bridging into it before recalling — see `core/pivot.ts`. A thread already
    // written in the pivot language has nothing to gain from being translated
    // into itself, so that case spends no provider call here either.
    const pivotLanguage =
      settings.languages.length > 0 ? resolvePivot(warrant, settings.languages) : null;
    const worthBridging =
      language !== null &&
      pivotLanguage !== null &&
      language.code !== pivotLanguage.code &&
      store.corrections.some((correction) => correction.language !== language.code);
    if (worthBridging) {
      // The cheap roster, same as triage's own bridge — a mechanical
      // translation for recall does not need the roster a first reply is
      // drafted with, and falls back to it only when `screen-models` was
      // never configured.
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
    core.info(
      `Recalled ${String(recalled.length)} of ${String(memory.size)} correction(s) from \`${settings.corrections}\`.`,
    );
  } else {
    core.info(
      "Recall is disabled (`memory.recall` is 0 or lower) — the corrections store was not read.",
    );
  }

  const guidance = await readGuidance(settings.guidance);

  const standingLabels: Label[] = standing.labels
    .map((name) => warrant.labelNamed(name))
    .filter((entry): entry is Label => entry !== undefined);

  const drafted = await draft({
    provider: stages.draft,
    models: settings.models,
    title: standing.title,
    body,
    language: language?.label ?? null,
    standing: standingLabels,
    recalled,
    guidance,
    drafts: settings.drafts,
    weather,
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
  });

  const modelName = (id: string) => shown(settings.modelNames, id);
  for (const failure of drafted.failures)
    core.warning(`draft: ${modelName(failure.model)} — ${failure.reason}`);
  if (drafted.unreadable.length > 0) {
    core.warning(
      `draft: ${String(drafted.unreadable.length)} answer(s) did not parse as a draft — discarded rather than read best-effort.`,
    );
  }

  if (drafted.attempts.length === 0) {
    core.warning(`#${String(at.number)}: no draft survived this run.`);
    return settled({ language: language?.label ?? null });
  }

  const verdict = await judge({
    provider: stages.judge,
    judges: settings.judges,
    title: standing.title,
    body,
    attempts: drafted.attempts,
    weather,
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
  });
  const judgeName = (id: string) => shown(settings.judgeNames, id);
  for (const failure of verdict.failures)
    core.warning(`judge: ${judgeName(failure.model)} — ${failure.reason}`);

  if (verdict.winner === null) {
    core.warning(`#${String(at.number)}: the panel could not settle on a draft this run.`);
    return settled({ language: language?.label ?? null });
  }

  const cast = verdict.votes.map((vote) => ({
    model: judgeName(vote.model),
    pick: modelName(vote.pick),
  }));
  const contested = drafted.attempts.length > 1 || verdict.votes.length > 0;
  const decision: Decision | null = contested
    ? {
        confidence: verdict.winner.confidence,
        drafts: drafted.attempts.length,
        decidedBy: verdict.decidedBy,
        votes: cast,
      }
    : null;

  const confidence = verdict.winner.confidence;
  const responded: Responded = {
    language: language?.label ?? null,
    languageCode: language?.code ?? null,
    // The real text a model wrote, always — never blanked for a reason not to
    // post it. See `publish.ts`'s doc comment on `Responded.text`.
    text: verdict.winner.text,
    model: modelName(verdict.winner.model),
    decision,
    fingerprint: record,
  };

  if (confidence < settings.confidence) {
    core.warning(
      `#${String(at.number)}: confidence ${confidence.toFixed(2)} is below the floor ` +
        `(${settings.confidence.toFixed(2)}) — the draft was written to \`respond-text\` but not posted.`,
    );
    return settled({ language: responded.language, responded, confidence });
  }

  if (!permitted.includes("comment")) {
    core.warning(
      `#${String(at.number)}: \`comment\` is not granted, so this run's draft was not posted.`,
    );
    return settled({ language: responded.language, responded, confidence });
  }

  // Computed once and checked here, right before the only two places this
  // duty ever renders a comment body: never post a marker with nothing under
  // it. `publication` already returns no sections for an empty draft, but the
  // invariant is enforced here, locally, rather than trusted silently — a
  // marker-only comment is indistinguishable from an answer to a reader who
  // cannot see this duty's source.
  const pub = publication(responded);
  if (pub.sections.length === 0) {
    core.warning(
      `#${String(at.number)}: the winning draft rendered nothing to post — refusing to post a ` +
        "marker with no reply under it.",
    );
    return settled({ language: responded.language, responded, confidence });
  }

  if (settings.dryRun) {
    const would = assemble("", marker, pub);
    core.info(`Dry run — #${String(at.number)} would have received:\n${would}`);
    return settled({ language: responded.language, responded, confidence });
  }

  // Reaching here means the walk above found neither this duty's own marker
  // nor a human's reply, so this is always a brand-new comment — there is no
  // update-in-place path, because respond never posts a second time on the
  // same thread.
  const effects = createEffects(api, at);
  await effects.comment(assemble("", marker, pub));
  core.info(`#${String(at.number)}: posted the first reply.`);

  return settled({ language: responded.language, responded, confidence, published: true });
}

function notGranted(warrant: Warrant): string {
  return (
    `\`${warrant.path}\`'s \`capabilities:\` block does not name \`respond\`; once that block exists ` +
    "it is the whole answer, so add `respond: [comment]` to it to grant a first reply (or remove " +
    "the block to return to defaults, which is still nothing — see `DEFAULT_CAPABILITIES`)."
  );
}

export async function run(): Promise<void> {
  // Declared out here, and written in `finally`, so a run that fails halfway
  // still reports what it decided and what it spent.
  const meter = createMeter();
  // Reassigned once `readSettings` has answered, inside the `try` below —
  // `endpoints` is not known until then. Left at its empty-alias default if
  // reading the settings themselves is what fails, which is fine: nothing
  // below that point ever runs.
  let weather = createWeather();
  let settings: Settings | null = null;
  let authority: Authority | null = null;
  let outcome: Outcome | null = null;
  let ungranted: string | null = null;

  try {
    const base = readSettings();
    weather = createWeather(new Set(base.endpoints.map((endpoint) => endpoint.alias)), [
      ...base.models,
      ...base.screenModels,
      ...base.judges.flat(),
    ]);
    const api = getOctokit(base.token);
    const provider = createRoutedProvider(resolveEndpoints(base));

    const stages: Stages = {
      screen: metered(provider, meter, "screen"),
      detect: metered(provider, meter, "detect"),
      draft: metered(provider, meter, "draft"),
      judge: metered(provider, meter, "judge"),
      pivot: metered(provider, meter, "pivot"),
    };

    const read = await readWarrant(base.warrant, { defaultPath: DEFAULT_WARRANT_PATH });
    authority = await resolveAuthority(read, base.warrant, api, context.repo);

    // A duty the warrant does not name spends nothing deciding what to say,
    // including the request `resolveLanguages` might otherwise need to make
    // sense of a `languages` input a repository that never intended to grant
    // this duty anything may never have configured at all.
    const denied = authority.warrant.unnamed("respond");
    if (denied) {
      ungranted = notGranted(authority.warrant);
      settings = { ...base, languages: [] };
    } else {
      const resolution = resolveLanguages(authority.warrant, core.getInput("languages"));
      if (resolution.notice !== null) core.notice(resolution.notice);

      // Same warrant-wins, input-falls-back pattern as `languages` above.
      const about = resolveAbout(authority.warrant, base.about);
      if (about.notice !== null) core.notice(about.notice);

      settings = { ...base, languages: resolution.languages, about: about.about };

      const at: Location = { ...context.repo, number: settings.number };
      outcome = await decide(api, at, authority.warrant, settings, stages, weather);
    }

    // Deferred half of the multi-endpoint amendment to D12: a single-endpoint
    // run never reaches this with anything to say — `reckon` already threw
    // the moment its one endpoint answered unauthenticated. Only fires once
    // every endpoint configured turned out to be misconfigured the same way.
    settleAuth(weather);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (settings !== null && authority !== null) {
      const rosterStarved = starved(settings.models, weather);
      if (rosterStarved) {
        core.warning(
          "Every model in `models` failed on capacity this run — weather, not a broken " +
            "configuration. This run delivered whatever it could before the roster ran dry.",
        );
      }

      report(outcome, rosterStarved);
      await writeSummary(
        page(settings, authority, outcome, ungranted, meter.spent()) +
          authSection(weather.authFailures),
      );
    }
  }
}

/** Every output, written on every path that reaches an answer — including "nothing". */
function report(outcome: Outcome | null, rosterStarved: boolean): void {
  core.setOutput("responded", String(outcome?.published ?? false));
  core.setOutput("language", outcome?.language ?? "");
  core.setOutput("respond-text", outcome?.responded?.text ?? "");
  core.setOutput("starved", String(rosterStarved));
}

function page(
  settings: Settings,
  authority: Authority,
  outcome: Outcome | null,
  ungranted: string | null,
  spent: Run["spent"],
): string {
  return summarize({
    thread: settings.number,
    dryRun: settings.dryRun,
    note: outcome?.note ?? null,
    language: outcome?.language ?? null,
    responded: outcome?.responded ?? null,
    confidence: outcome?.confidence ?? null,
    floor: settings.confidence,
    published: outcome?.published ?? false,
    permitted: outcome?.permitted ?? [],
    withheld: outcome?.withheld ?? [],
    spent,
    modelNames: settings.modelNames,
    judgeNames: settings.judgeNames,
    warrant: settings.warrant,
    implicit: authority.implicit,
    ungranted,
  });
}

await run();
