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
import { narrowWarned, parseApply } from "../../core/enforce.js";
import {
  createLifecycleEffects,
  isCapacityError,
  listOpenThreads,
  listRepositoryLabels,
  readStanding,
  type Location,
  type Standing,
} from "../../core/forge.js";
import { bounded, parseSince, threadNumber } from "../../core/inputs.js";
import { parseLanguages, type Language } from "../../core/languages.js";
import { isReeveProposalPr, markerFor } from "../../core/marker.js";
import { writeSummary } from "../../core/summary.js";
import {
  newAccumulator,
  remainingOf,
  type SweepAccumulator as Accumulator,
} from "../../core/sweep.js";
import {
  checkLifecycleLabelsExist,
  openAuthority,
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
import {
  isDraftPr,
  readComments,
  readEvents,
  resolveOwnLogin,
  type LifecycleApi,
} from "./timeline.js";
import { DEFAULT_CAPABILITIES, LIFECYCLE_CAPABILITIES } from "./capabilities.js";

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
  /** Why nothing was even evaluated — no `lifecycle:` policy, a `capabilities:` block that does not name this duty, or one of the hard pre-track skips (recursion guard, closed thread, unreadable creation date, `threads:` kind mismatch, draft exemption). `null` on every other path. */
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

/** Whether `threads:` admits a thread of this kind at all. */
function threadKindAllowed(threads: LifecyclePolicy["threads"], isPullRequest: boolean): boolean {
  if (threads === "both") return true;
  return threads === "prs" ? isPullRequest : !isPullRequest;
}

/**
 * What every thread this run touches needs answered exactly once, not once
 * per thread — the capability narrowing (A13) and the run's own identity
 * (A1's attribution gate) are the same answer for every candidate, so `run()`
 * resolves them a single time and hands them down.
 */
interface RunContext {
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  readonly ownLogin: string;
}

async function evaluateThread(
  api: LifecycleApi,
  authority: Authority,
  at: Location,
  standing: Standing,
  settings: Settings,
  ctx: RunContext,
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

  // Recursion guard: Reeve never touches its own proposal pull request —
  // not a reminder, not a stale label, not a close. A sweep already filters
  // this out of its listing before spending a read on it; the `number:`
  // path has no listing to filter, so it is checked again here.
  if (isReeveProposalPr(standing)) {
    return notGranted(
      "This is Reeve's own proposal pull request — every duty skips it, lifecycle included.",
    );
  }

  // A maintainer's own close decision is never reopened, spoken to, or
  // relabelled by a backfill run naming a closed thread directly.
  if (standing.closed) {
    return notGranted(
      `#${String(at.number)} is already closed — lifecycle only ever acts on open threads.`,
    );
  }

  // `threads:` gates which kind of thread this policy runs on at all.
  if (!threadKindAllowed(policy.threads, standing.isPullRequest)) {
    return notGranted(
      `\`${warrant.path}\`'s \`lifecycle.threads: ${policy.threads}\` does not include ` +
        `${standing.isPullRequest ? "pull requests" : "issues"}.`,
    );
  }

  // A thread whose creation date this run could not read never starts an
  // inactivity clock at the Unix epoch — that would read as "instantly
  // overdue" for every track with no `when:`. Skip rather than guess.
  if (standing.createdAt.getTime() === 0) {
    return notGranted(
      `#${String(at.number)}'s creation date could not be read this run — skipped rather than ` +
        "treated as instantly overdue.",
    );
  }

  if (standing.isPullRequest && policy.exempt.drafts && (await isDraftPr(api, at))) {
    return notGranted(
      `#${String(at.number)} is a draft pull request, exempt per \`exempt.drafts\`.`,
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
      ownLogin: ctx.ownLogin,
    },
    new Date(),
  );

  return {
    language,
    actions: decision.actions,
    unstale: decision.unstale,
    permanentlyExempt: decision.permanentlyExempt,
    permitted: ctx.permitted,
    withheld: ctx.withheld,
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

/**
 * The full ledger of what this thread's evaluation would do — computed the
 * same way whether or not it is actually written. Dry-run and a live run
 * disagree only about the `effects.*` calls below, never about what counts
 * as "would happen": rehearsal is the documented rollout story for the one
 * duty that closes things, so a dry-run sweep that renders "Nothing due." on
 * every row would be worse than useless — it would look clean right before
 * the first live run closes threads nobody previewed.
 */
async function act(
  effects: ReturnType<typeof createLifecycleEffects>,
  outcome: Outcome,
  exempt: LifecycleExempt,
  dryRun: boolean,
): Promise<Done> {
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
      if (!dryRun) await effects.addLabels([action.step.label]);
      labeled.push(action.step.label);
    }

    if (action.step.say !== null || action.step.close) {
      if (!dryRun) {
        const say = action.step.say !== null ? renderSay(action.step.say, outcome.language) : null;
        const closeText = action.step.close ? renderClose(outcome.language) : null;
        const body = [say, closeText].filter((line): line is string => line !== null).join("\n\n");
        const marker = MARKER.render(fingerprintFor(action.track, action.stepIndex, action.anchor));
        await effects.comment(
          `${body}\n\n${footer(action.track, exempt, outcome.language)}\n\n${marker}`,
        );
      }
      commented = true;
    }

    if (action.step.close) {
      if (!dryRun) await effects.closeAsNotPlanned();
      closed = true;
    }
  }

  const unstaled: string[] = [];
  if (outcome.permitted.includes("label")) {
    for (const label of outcome.unstale) {
      if (!dryRun) await effects.removeLabel(label);
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

/**
 * This sweep's progress: the shared accumulator, holding this duty's own rows.
 *
 * `starvedRun` means something different here than it does for the three
 * duties that sweep with a model roster. They run dry when every model is
 * grounded, which `starved` can be asked about for free before each thread;
 * lifecycle asks a model nothing at all, so the only capacity that can run out
 * on it is GitHub's own — a 429, a 5xx, a timeout — which is a fact only a
 * failed request can report. That is why this duty keeps its own loop rather
 * than `sweepThreads`: the check it needs is a `catch`, not a predicate.
 */
type SweepAccumulator = Accumulator<SweptThread>;

/**
 * Mutates `acc` in place rather than building and returning a fresh one, so
 * that a throw partway through the loop — a 429, a dropped connection —
 * leaves every write already made sitting in `acc`, visible to `run()`'s
 * `finally` block. A function that only ever returns its accumulator on the
 * happy path loses everything it did the moment something above it throws;
 * D12 says GitHub capacity is weather, not a reason to report zero outputs
 * and no summary for a sweep that closed twenty threads before the
 * twenty-first request failed.
 */
async function runSweep(
  acc: SweepAccumulator,
  api: LifecycleApi,
  authority: Authority,
  settings: Settings,
  ctx: RunContext,
): Promise<void> {
  if (authority.warrant.lifecycle === null) {
    acc.ungranted =
      `\`${authority.warrant.path}\` writes no \`lifecycle:\` key, so this duty has no policy to ` +
      "run.";
    return;
  }
  if (authority.warrant.unnamed("lifecycle")) {
    acc.ungranted = `\`${authority.warrant.path}\`'s \`capabilities:\` block does not name \`lifecycle\`.`;
    return;
  }

  const policy = authority.warrant.lifecycle;
  const listed = await listOpenThreads(api, context.repo, settings.since);
  // Oldest-created first — the thread that has waited longest for a clock
  // check is the one most likely to already be overdue, unlike a sweep whose
  // own work budget wants the newest backlog first.
  const ordered = [...listed].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  acc.candidates = ordered.length;

  for (const thread of ordered) {
    if (settings.limit !== null && acc.results.length >= settings.limit) break;

    // Cheap pre-filters straight off the listing — a thread this policy
    // could never evaluate, or Reeve's own proposal PR, never costs a
    // per-thread read (`readStanding` + comments + events) and never
    // consumes `limit`. Everything else — `exempt.labels`, `never:`
    // overrides, a permanent exemption — still gets a full read, because
    // un-staling has to keep working for exactly those threads (see A11);
    // pre-filtering them here the way this filter drops kind-mismatched
    // threads would silently break that.
    if (!threadKindAllowed(policy.threads, thread.isPullRequest) || isReeveProposalPr(thread)) {
      acc.skipped += 1;
      continue;
    }

    const at = { ...context.repo, number: thread.number };
    try {
      // The sweep listing carries no milestone/assignee/author state — read
      // the full standing per candidate, the same per-thread cost
      // `duplicate`'s sweep accepts for facts its own listing does not carry
      // either.
      const standing = await readStanding(api, at);
      const outcome = await evaluateThread(api, authority, at, standing, settings, ctx);
      // One thread's own effects, not shared across the sweep — `close`/`comment`/`addLabels` all need this thread's own issue number.
      const effects = createLifecycleEffects(api, at);
      const done = await act(effects, outcome, policy.exempt, settings.dryRun);
      acc.results.push({ number: thread.number, outcome, done });
    } catch (error) {
      if (isCapacityError(error)) {
        acc.starvedRun = true;
        break;
      }
      // Auth errors (401/403) are configuration, not weather — D12 says
      // those stay red. Let them propagate to `run()`'s own catch; `acc` is
      // already visible to the `finally` block either way.
      throw error;
    }
  }
}

export async function run(): Promise<void> {
  let settings: Settings | null = null;
  let single: { readonly number: number; readonly outcome: Outcome; readonly done: Done } | null =
    null;
  const bulk = newAccumulator<SweptThread>();
  let ranSweep = false;

  try {
    const base = readSettings();
    const api = getOctokit(base.token) as unknown as LifecycleApi;

    // `denied` is not read here: unlike the four duties that decide it once up
    // front, lifecycle asks `unnamed("lifecycle")` per thread inside
    // `evaluateThread`, because a sweep that is denied still has threads to
    // report on. And `languages` is resolved leniently — an unconfigured pair
    // is not refused here, it reads as English — so this is
    // `resolveThreadLanguages` rather than the strict `dutyLanguages`.
    const { authority } = await openAuthority(base.warrant, api, context.repo, "lifecycle");
    const languages = resolveThreadLanguages(authority.warrant, core.getInput("languages"));
    settings = { ...base, languages };

    // The label-existence rehearsal check runs before branching, so the
    // very first run against a single thread — not just a sweep — catches a
    // misspelled clock-hand label, the same way it always has for a sweep.
    if (authority.warrant.lifecycle !== null) {
      const existingLabels = (await listRepositoryLabels(api, context.repo)).map(
        (label) => label.name,
      );
      checkLifecycleLabelsExist(authority.warrant, existingLabels);
    }

    // Capability narrowing is the same answer for every thread this run
    // touches — resolved and warned about once here, not once per thread.
    const grantedRaw = authority.warrant.granted("lifecycle", DEFAULT_CAPABILITIES);
    const granted = grantedRaw.filter((capability) => LIFECYCLE_CAPABILITIES.includes(capability));
    const grantedButUnused = grantedRaw.filter(
      (capability) => !LIFECYCLE_CAPABILITIES.includes(capability),
    );
    if (grantedButUnused.length > 0) {
      core.notice(
        `\`${authority.warrant.path}\` grants lifecycle ` +
          `${grantedButUnused.map((capability) => `\`${capability}\``).join(", ")}, which this duty ` +
          "has no use for.",
      );
    }
    const { permitted, withheld } = narrowWarned(
      granted,
      settings.apply,
      "lifecycle",
      settings.warrant,
    );

    // Resolved once per run and cached — the attribution gate every
    // un-staling decision reads needs to know who "our own actor" is before
    // it can tell a label we applied from one a human, or a different bot,
    // did.
    const ownLogin = await resolveOwnLogin(api);
    const ctx: RunContext = { permitted, withheld, ownLogin };

    if (settings.sweep) {
      ranSweep = true;
      await runSweep(bulk, api, authority, settings, ctx);
    } else {
      const number = settings.number;
      if (number === null) throw new Error("number: required outside `sweep`.");
      const at = { ...context.repo, number };
      const standing = await readStanding(api, at);
      const outcome = await evaluateThread(api, authority, at, standing, settings, ctx);
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
      if (ranSweep) {
        report(bulk);
        await writeSummary(
          renderSweepPage(
            settings.warrant,
            settings.dryRun,
            bulk.results,
            bulk.ungranted,
            bulk.starvedRun,
          ),
        );
      } else if (single !== null) {
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
  // `skipped` now covers every exemption layer, not just labels: threads
  // this sweep never spent a read on (`bulk.skipped` — kind mismatch, the
  // recursion guard) plus threads it did read but that turned out ungranted
  // or permanently exempt once evaluated.
  const evaluatedSkipped = bulk.results.filter(
    (row) => row.outcome.ungranted !== null || row.outcome.permanentlyExempt !== null,
  ).length;
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("remaining", String(remainingOf(bulk)));
  core.setOutput("starved", String(bulk.starvedRun));
  core.setOutput("skipped", String(bulk.skipped + evaluatedSkipped));
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
