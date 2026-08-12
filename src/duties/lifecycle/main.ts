/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * **No implicit policy.** Every other duty falls back to some narrow default
 * when a warrant is absent or silent; lifecycle has none, because no
 * pre-existing artifact states a staleness policy the way a repository's own
 * label descriptions state a taxonomy. An absent `lifecycle:` key — whether
 * because the file never wrote one, or because there is no file at all — is
 * a green no-op naming the missing key, the same shape `notGranted` reports
 * for a `capabilities:` block that exists and simply does not name this
 * duty. Both are checked before a single thread is fetched.
 *
 * **No model call, anywhere in this duty.** `message.ts` explains why the
 * design's optional model-translation fallback was cut; the rest of the
 * pipeline below never had one to cut — every decision here is a function of
 * label state, comment/event timestamps and durations from the warrant, all
 * of it deterministic and none of it worth a request.
 *
 * **A due step fires atomically, or not at all this run.** `act` below
 * checks every capability one step's action would need — `label` for its
 * `label:`, `comment` for its `say:`/close explanation, `close` for
 * `close: true` — against what `apply` and the warrant both grant, and skips
 * the whole step unless every one of them is permitted. Firing part of a
 * step (adding the label but not posting the marker that records it fired)
 * would leave a state neither this run nor the next could tell from a step
 * that simply had not fired yet.
 *
 * This file is excluded from coverage because it calls `run()` at import —
 * `clock.ts` and `message.ts` carry this duty's tested logic.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { detectLanguage } from "../../core/detect.js";
import { narrow, parseApply } from "../../core/enforce.js";
import {
  createLifecycleEffects,
  listOpenThreads,
  listRepositoryLabels,
  readStanding,
  type Location,
  type Standing,
} from "../../core/forge.js";
import { bounded, parseSince, threadNumber } from "../../core/inputs.js";
import { parseLanguages, type Language } from "../../core/languages.js";
import { markerFor } from "../../core/marker.js";
import { writeSummary } from "../../core/summary.js";
import {
  checkLifecycleLabelsExist,
  readWarrant,
  resolveAuthority,
  type Authority,
  type Capability,
  type LifecycleExempt,
  type LifecyclePolicy,
  type LifecycleStep,
  type Warrant,
} from "../../core/warrant.js";

import { evaluateLifecycle, fingerprintFor, type DueStep } from "./clock.js";
import { footer, renderClose, renderSay } from "./message.js";
import { renderSweepPage, renderThreadPage } from "./summary.js";
import { readComments, readEvents, type LifecycleApi } from "./timeline.js";

/** `lifecycle`'s own default, once a `lifecycle:` policy exists and no `capabilities:` block says otherwise. */
const DEFAULT_CAPABILITIES: readonly Capability[] = ["label", "comment"];

/** The full ladder this duty ever asks for — anything else the warrant names for it is inert here, not an error; see `Warrant.granted`'s own doc comment for why a per-duty enumeration is not this module's to validate. */
const LIFECYCLE_CAPABILITIES: readonly Capability[] = ["label", "comment", "close"];

/** `warrant`'s own default in `action.yml`, repeated here rather than read back out of it. */
const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

const MARKER = markerFor("lifecycle");

interface Settings {
  readonly token: string;
  readonly number: number | null;
  readonly languages: readonly Language[];
  readonly warrant: string;
  readonly apply: readonly Capability[];
  readonly dryRun: boolean;
  readonly sweep: boolean;
  readonly since: Date | null;
  readonly limit: number | null;
}

function readSettings(): Omit<Settings, "languages"> {
  const sweep = core.getBooleanInput("sweep");
  const configuredNumber = core.getInput("number");
  if (sweep && configuredNumber.length > 0) {
    throw new Error(
      "sweep: cannot be combined with `number` — a sweep works the whole backlog and `number` " +
        "names one thread. Set one or the other.",
    );
  }
  // `threadNumber()` is the one house helper for this — same event-carries-no-
  // thread message every other duty gives, not a locally reinvented copy.
  const number = sweep ? null : threadNumber();

  return {
    token: core.getInput("github-token", { required: true }),
    number,
    warrant: core.getInput("warrant", { required: true }),
    apply: parseApply(core.getInput("apply", { required: true })),
    dryRun: core.getBooleanInput("dry-run"),
    sweep,
    since: parseSince(core.getInput("since")),
    limit: bounded("limit", core.getInput("limit")),
  };
}

/**
 * `languages:`/`languages` resolved leniently — unlike every other duty's
 * `resolveLanguages`, an unconfigured pair is not refused here, because a
 * repository whose tracks all use the built-in English text or an explicit
 * `say:` map never had a reason to configure either. `[]` reads as English
 * throughout `message.ts`.
 */
function resolveThreadLanguages(warrant: Warrant, rawInput: string): readonly Language[] {
  if (warrant.languages !== null) return warrant.languages;
  const trimmed = rawInput.trim();
  return trimmed.length === 0 ? [] : parseLanguages(trimmed);
}

interface Outcome {
  readonly language: string | null;
  readonly actions: readonly DueStep[];
  readonly unstale: readonly string[];
  readonly permanentlyExempt: string | null;
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  /** Why nothing was even evaluated — no `lifecycle:` policy, or a `capabilities:` block that does not name this duty. `null` on every other path. */
  readonly ungranted: string | null;
}

function notGranted(reason: string): Outcome {
  return {
    language: null,
    actions: [],
    unstale: [],
    permanentlyExempt: null,
    permitted: [],
    withheld: [],
    ungranted: reason,
  };
}

/** What one thread's `act` actually did. */
export interface Done {
  readonly labeled: readonly string[];
  readonly commented: boolean;
  readonly closed: boolean;
  readonly unstaled: readonly string[];
  /** Due steps this run recognised but could not act on — a capability the warrant or `apply` withheld. */
  readonly dueNotGranted: number;
}

const NOTHING_DONE: Done = {
  labeled: [],
  commented: false,
  closed: false,
  unstaled: [],
  dueNotGranted: 0,
};

async function evaluateThread(
  api: LifecycleApi,
  authority: Authority,
  at: Location,
  standing: Standing,
  settings: Settings,
): Promise<Outcome> {
  const warrant = authority.warrant;
  const policy = warrant.lifecycle;
  if (policy === null) {
    return notGranted(
      `\`${warrant.path}\` writes no \`lifecycle:\` key, so this duty has no policy to run — ` +
        "there is no default the way a taxonomy has one. Write `lifecycle:` to configure it.",
    );
  }
  if (warrant.unnamed("lifecycle")) {
    return notGranted(
      `\`${warrant.path}\`'s \`capabilities:\` block does not name \`lifecycle\`; once that block ` +
        "exists it is the whole answer, so add `lifecycle: [label, comment]` to it (or remove the " +
        "block to return to defaults).",
    );
  }

  const grantedRaw = warrant.granted("lifecycle", DEFAULT_CAPABILITIES);
  const granted = grantedRaw.filter((capability) => LIFECYCLE_CAPABILITIES.includes(capability));
  const { permitted, withheld } = narrow(granted, settings.apply);
  for (const capability of withheld) {
    core.warning(
      `\`apply\` asks for \`${capability}\`, which \`${warrant.path}\` does not grant to lifecycle. ` +
        "The narrower of the two wins.",
    );
  }

  const [comments, events] = await Promise.all([readComments(api, at), readEvents(api, at)]);

  const detection = await detectLanguage(
    standing.body.length === 0 ? standing.title : standing.body,
    settings.languages,
  );
  const language = detection.language?.code ?? null;

  const decision = evaluateLifecycle(
    policy,
    {
      labels: standing.labels,
      milestone: standing.milestone,
      assignees: standing.assignees,
      createdAt: standing.createdAt,
      authorLogin: standing.author.login,
      comments,
      events,
      taxonomyNames: new Set(warrant.labels.map((label) => label.name)),
    },
    new Date(),
  );

  return {
    language,
    actions: decision.actions,
    unstale: decision.unstale,
    permanentlyExempt: decision.permanentlyExempt,
    permitted,
    withheld,
    ungranted: null,
  };
}

interface RequiredCheck {
  readonly ok: boolean;
  readonly missing: readonly Capability[];
}

function requiredCapabilities(step: LifecycleStep): readonly Capability[] {
  const caps: Capability[] = [];
  if (step.label !== null) caps.push("label");
  if (step.say !== null || step.close) caps.push("comment");
  if (step.close) caps.push("close");
  return caps;
}

function checkRequired(step: LifecycleStep, permitted: readonly Capability[]): RequiredCheck {
  const required = requiredCapabilities(step);
  const missing = required.filter((capability) => !permitted.includes(capability));
  return { ok: missing.length === 0, missing };
}

async function act(
  effects: ReturnType<typeof createLifecycleEffects>,
  outcome: Outcome,
  exempt: LifecycleExempt,
  dryRun: boolean,
): Promise<Done> {
  if (dryRun) return NOTHING_DONE;

  const labeled: string[] = [];
  let commented = false;
  let closed = false;
  let dueNotGranted = 0;

  for (const action of outcome.actions) {
    const check = checkRequired(action.step, outcome.permitted);
    if (!check.ok) {
      dueNotGranted += 1;
      core.info(
        `lifecycle: \`${action.track.name}\` step ${String(action.stepIndex)} is due but withheld — ` +
          `missing ${check.missing.join(", ")}.`,
      );
      continue;
    }

    if (action.step.label !== null) {
      await effects.addLabels([action.step.label]);
      labeled.push(action.step.label);
    }

    if (action.step.say !== null || action.step.close) {
      const say = action.step.say !== null ? renderSay(action.step.say, outcome.language) : null;
      const closeText = action.step.close ? renderClose(outcome.language) : null;
      const body = [say, closeText].filter((line): line is string => line !== null).join("\n\n");
      const marker = MARKER.render(fingerprintFor(action.track, action.stepIndex, action.anchor));
      await effects.comment(`${body}\n\n${footer(action.track, exempt)}\n\n${marker}`);
      commented = true;
    }

    if (action.step.close) {
      await effects.closeAsNotPlanned();
      closed = true;
    }
  }

  const unstaled: string[] = [];
  if (outcome.permitted.includes("label")) {
    for (const label of outcome.unstale) {
      await effects.removeLabel(label);
      unstaled.push(label);
    }
  } else if (outcome.unstale.length > 0) {
    core.info(
      `lifecycle: ${String(outcome.unstale.length)} label(s) are stale but \`label\` is withheld.`,
    );
  }

  return { labeled, commented, closed, unstaled, dueNotGranted };
}

interface SweptThread {
  readonly number: number;
  readonly outcome: Outcome;
  readonly done: Done;
}

interface SweepAccumulator {
  readonly results: SweptThread[];
  candidates: number;
  ungranted: string | null;
}

async function runSweep(
  api: LifecycleApi,
  authority: Authority,
  settings: Settings,
): Promise<SweepAccumulator> {
  const acc: SweepAccumulator = { results: [], candidates: 0, ungranted: null };

  if (authority.warrant.lifecycle === null) {
    acc.ungranted =
      `\`${authority.warrant.path}\` writes no \`lifecycle:\` key, so this duty has no policy to ` +
      "run.";
    return acc;
  }
  if (authority.warrant.unnamed("lifecycle")) {
    acc.ungranted = `\`${authority.warrant.path}\`'s \`capabilities:\` block does not name \`lifecycle\`.`;
    return acc;
  }

  const existingLabels = (await listRepositoryLabels(api, context.repo)).map((label) => label.name);
  checkLifecycleLabelsExist(authority.warrant, existingLabels);

  const threads = policyIncludesPulls(authority.warrant.lifecycle)
    ? await listOpenThreads(api, context.repo, settings.since)
    : (await listOpenThreads(api, context.repo, settings.since)).filter(
        (thread) => !thread.isPullRequest,
      );
  // Oldest-created first — the thread that has waited longest for a clock
  // check is the one most likely to already be overdue, unlike a sweep whose
  // own work budget wants the newest backlog first.
  const ordered = [...threads].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  acc.candidates = ordered.length;

  for (const thread of ordered) {
    if (settings.limit !== null && acc.results.length >= settings.limit) break;

    const at = { ...context.repo, number: thread.number };
    // The sweep listing carries no milestone/assignee/author state — read
    // the full standing per candidate, the same per-thread cost
    // `duplicate`'s sweep accepts for facts its own listing does not carry
    // either.
    const standing = await readStanding(api, at);
    const outcome = await evaluateThread(api, authority, at, standing, settings);
    // One thread's own effects, not shared across the sweep — `close`/`comment`/`addLabels` all need this thread's own issue number.
    const effects = createLifecycleEffects(api, at);
    const done = await act(effects, outcome, authority.warrant.lifecycle.exempt, settings.dryRun);
    acc.results.push({ number: thread.number, outcome, done });
  }

  return acc;
}

function policyIncludesPulls(policy: LifecyclePolicy): boolean {
  return policy.threads === "prs" || policy.threads === "both";
}

export async function run(): Promise<void> {
  let settings: Settings | null = null;
  let single: { readonly number: number; readonly outcome: Outcome; readonly done: Done } | null =
    null;
  let bulk: SweepAccumulator | null = null;

  try {
    const base = readSettings();
    const api = getOctokit(base.token) as unknown as LifecycleApi;

    const read = await readWarrant(base.warrant, { defaultPath: DEFAULT_WARRANT_PATH });
    const authority = await resolveAuthority(read, base.warrant, api, context.repo);
    const languages = resolveThreadLanguages(authority.warrant, core.getInput("languages"));
    settings = { ...base, languages };

    if (settings.sweep) {
      bulk = await runSweep(api, authority, settings);
    } else {
      const number = settings.number;
      if (number === null) throw new Error("number: required outside `sweep`.");
      const at = { ...context.repo, number };
      const standing = await readStanding(api, at);
      const outcome = await evaluateThread(api, authority, at, standing, settings);
      const done =
        authority.warrant.lifecycle === null
          ? NOTHING_DONE
          : await act(
              createLifecycleEffects(api, at),
              outcome,
              authority.warrant.lifecycle.exempt,
              settings.dryRun,
            );
      single = { number, outcome, done };
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (settings !== null) {
      if (settings.sweep && bulk !== null) {
        report(bulk);
        await writeSummary(
          renderSweepPage(settings.warrant, settings.dryRun, bulk.results, bulk.ungranted),
        );
      } else if (!settings.sweep && single !== null) {
        reportSingle(single.outcome, single.done);
        await writeSummary(
          renderThreadPage(
            settings.warrant,
            settings.dryRun,
            single.number,
            single.outcome,
            single.done,
          ),
        );
      }
    }
  }
}

function reportSingle(outcome: Outcome, done: Done): void {
  core.setOutput("processed", "0");
  core.setOutput("remaining", "0");
  core.setOutput("starved", "false");
  core.setOutput(
    "skipped",
    outcome.ungranted !== null || outcome.permanentlyExempt !== null ? "true" : "false",
  );
  core.setOutput("reminded", String(done.commented));
  core.setOutput("labeled", String(done.labeled.length));
  core.setOutput("closed", String(done.closed));
  core.setOutput("unstaled", String(done.unstaled.length));
  core.setOutput("due-not-granted", String(done.dueNotGranted));
}

function report(bulk: SweepAccumulator): void {
  const skipped = bulk.results.filter(
    (row) => row.outcome.ungranted !== null || row.outcome.permanentlyExempt !== null,
  ).length;
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("remaining", String(Math.max(bulk.candidates - bulk.results.length, 0)));
  core.setOutput("starved", "false");
  core.setOutput("skipped", String(skipped));
  core.setOutput("reminded", String(bulk.results.filter((row) => row.done.commented).length));
  core.setOutput(
    "labeled",
    String(bulk.results.reduce((sum, row) => sum + row.done.labeled.length, 0)),
  );
  core.setOutput("closed", String(bulk.results.filter((row) => row.done.closed).length));
  core.setOutput(
    "unstaled",
    String(bulk.results.reduce((sum, row) => sum + row.done.unstaled.length, 0)),
  );
  core.setOutput(
    "due-not-granted",
    String(bulk.results.reduce((sum, row) => sum + row.done.dueNotGranted, 0)),
  );
}

await run();
