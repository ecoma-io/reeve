/**
 * Pure decision logic for one thread's lifecycle tracks: no network call, no
 * clock but `now`, handed in rather than read — everything here is a
 * function of facts a caller already gathered and is unit-tested as such.
 *
 * **Nothing here is stored.** A track's current anchor — the timestamp every
 * step's timing and fingerprint is computed from — is recomputed from the
 * thread's own comments and events on every run. A reset is not an event
 * this module records; it is simply a later anchor than the one a prior
 * step's marker was computed against, which is what makes that marker's
 * fingerprint stop matching and a fresh cycle begin — see `evaluateTrack`.
 *
 * **Retraction authority comes from the file, not from history.** A label a
 * track names as its clock-hand is machine-managed by the warrant's own
 * declaration (the north-star's D3 amendment), so un-staling here never
 * checks who applied a label before removing it — contrast a duty that
 * retracts a label nobody declared machine-managed, which would need to
 * check timeline attribution instead. That harder case does not arise here.
 */
import type {
  LifecycleExempt,
  LifecycleOverride,
  LifecyclePolicy,
  LifecycleResets,
  LifecycleStep,
  LifecycleTrack,
} from "../../core/warrant.js";
import { fingerprint, markerFor } from "../../core/marker.js";
import type { TimedComment, TimedEvent } from "./timeline.js";

/** Every fact a clock computation reads, gathered once per thread by the caller. */
export interface TrackFacts {
  readonly labels: readonly string[];
  readonly milestone: string | null;
  readonly assignees: readonly string[];
  readonly createdAt: Date;
  readonly authorLogin: string;
  readonly comments: readonly TimedComment[];
  readonly events: readonly TimedEvent[];
  /** Every name in the warrant's taxonomy — for `exempt.taxonomy`. */
  readonly taxonomyNames: ReadonlySet<string>;
}

const MARKER = markerFor("lifecycle");

/** Event types that count as activity — everything a human visibly did to the thread. */
const ACTIVITY_EVENTS = new Set([
  "labeled",
  "unlabeled",
  "milestoned",
  "demilestoned",
  "assigned",
  "unassigned",
  "reopened",
]);

function isFromAuthor(login: string, authorLogin: string): boolean {
  return authorLogin.length > 0 && login === authorLogin;
}

/**
 * The latest human (non-bot) signal on the thread that qualifies as a reset
 * under `resets` — every comment, plus every {@link ACTIVITY_EVENTS} event,
 * scoped to the thread's author alone when `resets` is `"author"`.
 */
export function latestQualifyingActivity(facts: TrackFacts, resets: LifecycleResets): Date | null {
  let latest: Date | null = null;
  const consider = (at: Date, isBot: boolean, login: string): void => {
    if (isBot) return;
    if (resets === "author" && !isFromAuthor(login, facts.authorLogin)) return;
    if (latest === null || at > latest) latest = at;
  };

  for (const comment of facts.comments) consider(comment.createdAt, comment.isBot, comment.login);
  for (const event of facts.events) {
    if (!ACTIVITY_EVENTS.has(event.event)) continue;
    consider(event.createdAt, event.isBot, event.login);
  }
  return latest;
}

/**
 * Where a track's clock currently starts counting from — recomputed fresh
 * every run, which is what makes a reset self-healing rather than something
 * this module has to notice and act on separately.
 *
 * A `when:` track starts at the last *human* application of its label —
 * `null` when that never happened, meaning the track has not started.  An
 * inactivity track starts at the thread's creation, or later, whichever
 * qualifying activity (per `resets`) is more recent.
 */
export function trackStart(track: LifecycleTrack, facts: TrackFacts): Date | null {
  if (track.when !== null) {
    let latest: Date | null = null;
    for (const event of facts.events) {
      if (event.event !== "labeled" || event.label !== track.when || event.isBot) continue;
      if (latest === null || event.createdAt > latest) latest = event.createdAt;
    }
    return latest;
  }

  const qualifying = latestQualifyingActivity(facts, track.resets);
  if (qualifying === null || qualifying < facts.createdAt) return facts.createdAt;
  return qualifying;
}

/** What resolving `lifecycle.overrides` against a thread's current labels decided, for one track. */
export interface OverrideResolution {
  /** True when a `never` override matched — the whole track is exempt this run. */
  readonly neverExempt: boolean;
  /** The longest `after` override that matched, replacing the first step's `after` on an inactivity track. `null` when none matched. */
  readonly firstStepAfter: number | null;
}

export function resolveOverrides(
  overrides: readonly LifecycleOverride[],
  labels: readonly string[],
): OverrideResolution {
  let neverExempt = false;
  let firstStepAfter: number | null = null;
  for (const override of overrides) {
    if (!labels.includes(override.label)) continue;
    if (override.never) {
      neverExempt = true;
      continue;
    }
    if (override.after !== null && (firstStepAfter === null || override.after > firstStepAfter)) {
      firstStepAfter = override.after;
    }
  }
  return { neverExempt, firstStepAfter };
}

/** One track's step, due right now — what `act` in `main.ts` turns into a write. */
export interface DueStep {
  readonly track: LifecycleTrack;
  readonly stepIndex: number;
  readonly step: LifecycleStep;
  readonly anchor: Date;
  readonly fingerprint: string;
}

/** One track's evaluation this run: at most one step due, plus any of its own labels found stale. */
export interface TrackEvaluation {
  readonly due: DueStep | null;
  readonly toUnstale: readonly string[];
}

/**
 * Walks one track's steps in order from its current anchor, looking for a
 * marker comment matching each step's expected fingerprint.
 *
 * A step whose marker is found has fired; its comment's own timestamp
 * becomes the next step's anchor, and the walk continues. The first step
 * whose marker is *not* found is where the walk stops: due now (returned as
 * `due`), or not yet (nothing to do this run) — a step further down the
 * ladder can never be evaluated before the one in front of it has actually
 * fired, because there is no anchor to compute it from.
 *
 * A step that carries a `label:` currently on the thread, but whose firing
 * evidence does not match this run's freshly computed anchor, is stale: the
 * world moved on since it was applied (a reset produced a later anchor), so
 * it is queued for removal in `toUnstale` — see this module's own doc
 * comment on why that check needs no history, only the warrant's
 * declaration that the label is this track's own clock-hand.
 *
 * **A step that talks — carries `say:` or `close: true` — fires by marker
 * comment,** the mechanism described above. **A step that only carries
 * `label:`, with neither, fires by label event instead:** `main.ts` never
 * posts a comment `apply` did not grant `comment` for, and a marker only
 * this duty's own comment can carry is not a record a label-only step can
 * depend on without risking exactly that flip-flop — labelled, found
 * "unmarked" next run for lack of `comment`, un-staled, relabelled, forever.
 * Reading the label's own most recent bot-authored `labeled` event instead
 * needs only the `label` capability the step already required, and — since
 * that event's timestamp is compared against the same recomputed `anchor`
 * every marker check already uses — gets the identical reset-invalidates-it
 * property for free, no fingerprint required.
 */
export function evaluateTrack(
  track: LifecycleTrack,
  facts: TrackFacts,
  overrideRes: OverrideResolution,
  now: Date,
): TrackEvaluation {
  if (overrideRes.neverExempt) return { due: null, toUnstale: [] };

  const start = trackStart(track, facts);
  if (start === null) return { due: null, toUnstale: [] };

  const toUnstale: string[] = [];
  let anchor = start;

  for (let index = 0; index < track.steps.length; index += 1) {
    const step = track.steps[index];
    if (step === undefined) break;

    const after =
      index === 0 && track.when === null && overrideRes.firstStepAfter !== null
        ? overrideRes.firstStepAfter
        : step.after;

    const talks = step.say !== null || step.close;
    const fp = fingerprintFor(track, index, anchor);

    let firedAt: Date | null = null;
    if (talks) {
      const marker = facts.comments.find(
        (comment) => MARKER.split(comment.body).fingerprint === fp,
      );
      firedAt = marker?.createdAt ?? null;
    } else if (step.label !== null) {
      const applied = latestBotLabelEvent(facts.events, step.label);
      firedAt = applied !== null && applied >= anchor ? applied : null;
    }

    if (step.label !== null && facts.labels.includes(step.label) && firedAt === null) {
      toUnstale.push(step.label);
    }

    if (firedAt !== null) {
      anchor = firedAt;
      continue;
    }

    const due = now.getTime() >= anchor.getTime() + after;
    if (!due) return { due: null, toUnstale };
    return { due: { track, stepIndex: index, step, anchor, fingerprint: fp }, toUnstale };
  }

  return { due: null, toUnstale };
}

/** The latest `labeled` event for `label` a bot account raised — the firing evidence a label-only step reads instead of a marker comment. */
function latestBotLabelEvent(events: readonly TimedEvent[], label: string): Date | null {
  let latest: Date | null = null;
  for (const event of events) {
    if (event.event !== "labeled" || event.label !== label || !event.isBot) continue;
    if (latest === null || event.createdAt > latest) latest = event.createdAt;
  }
  return latest;
}

/** The fingerprint a step's marker carries when it fires from a given anchor — shared by `evaluateTrack` and whichever code in `main.ts` posts the marker. */
export function fingerprintFor(track: LifecycleTrack, stepIndex: number, anchor: Date): string {
  return fingerprint(anchor.toISOString(), [track.name, String(stepIndex)]);
}

/**
 * Whether a bot closed this thread and a human later reopened it — the
 * reopened-after-close guard. Thread-wide rather than per-track: the close
 * event itself does not say which track's step closed it (only the marker
 * comment posted alongside it would, and decoding that back to a track name
 * is not worth the complexity for a guard whose only job is to decline
 * closing again). Blocking every track's `close` step once any bot close was
 * reopened is the D3-safe direction — over-cautious, never wrong.
 */
export function closeBlocked(facts: TrackFacts): boolean {
  let lastBotClose: Date | null = null;
  for (const event of facts.events) {
    if (event.event === "closed" && event.isBot) {
      if (lastBotClose === null || event.createdAt > lastBotClose) lastBotClose = event.createdAt;
      continue;
    }
    if (event.event === "reopened" && !event.isBot && lastBotClose !== null) {
      if (event.createdAt > lastBotClose) return true;
    }
  }
  return false;
}

export function humanCommentCount(facts: TrackFacts): number {
  return facts.comments.filter((comment) => !comment.isBot).length;
}

function isMilestoneExempt(exempt: LifecycleExempt, facts: TrackFacts): boolean {
  if (exempt.milestones === false || facts.milestone === null) return false;
  if (exempt.milestones === true) return true;
  return exempt.milestones.includes(facts.milestone);
}

function isAssigneeExempt(exempt: LifecycleExempt, facts: TrackFacts): boolean {
  if (exempt.assignees === false || facts.assignees.length === 0) return false;
  if (exempt.assignees === true) return true;
  return facts.assignees.some((login) => (exempt.assignees as readonly string[]).includes(login));
}

/** Any taxonomy label on the thread other than this track's own `when:` label — a triaged thread's own category protects it. */
function isTaxonomyExempt(
  exempt: LifecycleExempt,
  facts: TrackFacts,
  track: LifecycleTrack,
): boolean {
  if (!exempt.taxonomy) return false;
  return facts.labels.some((label) => label !== track.when && facts.taxonomyNames.has(label));
}

/** What a full run of `lifecycle.tracks` decided for one thread. */
export interface LifecycleDecision {
  /** At most one due step per track, in track order. */
  readonly actions: readonly DueStep[];
  /** The union of every track's stale clock-hand labels, ready to remove. */
  readonly unstale: readonly string[];
  /** True when `exempt.labels` matched — every new action withheld, un-staling still runs (see doc comment). */
  readonly permanentlyExempt: string | null;
}

/**
 * Evaluates every track in `policy` against one thread's facts, folding in
 * all four exemption layers and the reopened-after-close guard.
 *
 * `exempt.labels` (layer 1) withholds every new action but does not skip
 * un-staling — removing a stale machine label is protective, in the
 * direction D3 already permits, so a thread a maintainer just protected
 * still gets a wrongly-lingering `stale` cleaned off it. Layers 2–4
 * (milestone, assignee, taxonomy) and the reopened guard are scoped to
 * `close` and new reminders only, the same reasoning.
 */
export function evaluateLifecycle(
  policy: LifecyclePolicy,
  facts: TrackFacts,
  now: Date,
): LifecycleDecision {
  const permanentlyExempt =
    policy.exempt.labels.find((name) => facts.labels.includes(name)) ?? null;
  const milestoneExempt = isMilestoneExempt(policy.exempt, facts);
  const assigneeExempt = isAssigneeExempt(policy.exempt, facts);
  const blocked = closeBlocked(facts);
  const commentGuard =
    policy.exempt.comments !== null && humanCommentCount(facts) >= policy.exempt.comments;

  const actions: DueStep[] = [];
  const unstale = new Set<string>();

  for (const track of policy.tracks) {
    const overrideRes = resolveOverrides(policy.overrides, facts.labels);
    const evaluation = evaluateTrack(track, facts, overrideRes, now);
    for (const label of evaluation.toUnstale) unstale.add(label);

    if (permanentlyExempt !== null) continue;
    if (milestoneExempt || assigneeExempt || isTaxonomyExempt(policy.exempt, facts, track))
      continue;
    if (evaluation.due === null) continue;
    if (evaluation.due.step.close && (blocked || commentGuard)) continue;

    actions.push(evaluation.due);
  }

  return { actions, unstale: [...unstale], permanentlyExempt };
}
