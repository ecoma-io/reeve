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
 * **Retraction authority comes from the file, but removal still checks who
 * applied it.** A label a track names as its clock-hand is machine-managed
 * by the warrant's own declaration (the north-star's D3 amendment) — that
 * declaration is what makes removing it thinkable at all. It is not,
 * however, licence to remove *any* instance of that label: un-staling here
 * only ever retracts a labelling this duty's own actor is the most recent
 * author of (see `isOwnApplied`). A human who hand-applied the same label
 * name, or a different bot migrated away from, is never touched — absent or
 * ambiguous attribution leaves the label alone and says nothing, the same
 * "a human's label is not ours to touch" rule the rest of this duty follows.
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
  /**
   * The login this run's own token authenticates as, resolved once per run
   * by the caller. Both firing evidence and un-staling attribution compare
   * against this — see `isOwnApplied`.
   */
  readonly ownLogin: string;
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
 * world moved on since it was applied (a reset produced a later anchor). It
 * is queued for removal in `toUnstale` only when it also passes the
 * clock-hand exception's attribution gate — the most recent `labeled` event
 * for that label was raised by this run's own login (`isOwnApplied`).
 * Absent or ambiguous attribution (no matching event in the fetched
 * history, or someone else's) leaves the label alone: a human's label, or
 * one left by a different bot a repository is migrating away from, is never
 * ours to touch. Steps the walk never reaches this run (later rungs of the
 * ladder) are swept for the same orphaned-label check in a second pass,
 * since their labels being present at all is evidence enough without an
 * anchor to compare against.
 *
 * **A step that talks — carries `say:` or `close: true` — fires by marker
 * comment,** the mechanism described above. **A step that only carries
 * `label:`, with neither, fires by label event instead:** `main.ts` never
 * posts a comment `apply` did not grant `comment` for, and a marker only
 * this duty's own comment can carry is not a record a label-only step can
 * depend on without risking exactly that flip-flop — labelled, found
 * "unmarked" next run for lack of `comment`, un-staled, relabelled, forever.
 * Reading the label's own most recent same-actor `labeled` event instead
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
  // A `never` override exempts the track from new actions, but a label our
  // own actor left behind is still ours to clean up — compute staleness
  // across the whole track before returning (see the module doc comment).
  if (overrideRes.neverExempt) {
    return { due: null, toUnstale: collectStaleLabels(track.steps, facts) };
  }

  const start = trackStart(track, facts);
  if (start === null) {
    return { due: null, toUnstale: collectStaleLabels(track.steps, facts) };
  }

  const toUnstale: string[] = [];
  let anchor = start;
  let due: DueStep | null = null;
  // Index of the step the walk stopped at — due, or not yet due. Steps past
  // this one were never reached by the anchor walk this run, so any of
  // their own labels found on the thread are unconditionally orphaned; see
  // the loop below this one.
  let stoppedAt = track.steps.length;

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
      // Two-part attribution, the same way the label path owns a firing: the
      // comment must carry this duty's real fingerprint *and* be authored by
      // this run's own login. The fingerprint alone is forgeable — it is a
      // deterministic public hash over the track name and the anchor, both of
      // which a stranger can read — so without the authorship half, any
      // commenter who computes the digest could read a step as fired, anchor
      // the clock to their own comment, and walk a `when:` track into
      // permanent suppression. A human's comment (or a second bot's) is not
      // evidence this duty's own step fired.
      const marker = facts.comments.find(
        (comment) =>
          isOwnActor(comment.login, facts.ownLogin) &&
          MARKER.split(comment.body).fingerprint === fp,
      );
      firedAt = marker?.createdAt ?? null;
    } else if (step.label !== null) {
      const applied = latestOwnLabelEvent(facts.events, step.label, facts.ownLogin);
      firedAt = applied !== null && applied >= anchor ? applied : null;
    }

    if (
      step.label !== null &&
      facts.labels.includes(step.label) &&
      firedAt === null &&
      isOwnApplied(facts.events, step.label, facts.ownLogin)
    ) {
      toUnstale.push(step.label);
    }

    if (firedAt !== null) {
      anchor = firedAt;
      continue;
    }

    stoppedAt = index;
    if (now.getTime() >= anchor.getTime() + after) {
      due = { track, stepIndex: index, step, anchor, fingerprint: fp };
    }
    break;
  }

  // Steps beyond the one the walk stopped at were never reached this run —
  // the ladder cannot have advanced past a step that has not fired, so any
  // of their labels still on the thread are leftovers, not evidence.
  for (const label of collectStaleLabels(track.steps.slice(stoppedAt + 1), facts)) {
    toUnstale.push(label);
  }

  // The step about to fire this run (if any) is not stale — main.ts is
  // about to (re)apply its own label as part of firing it, and a same-run
  // apply-then-remove would silently advance the ladder without the label
  // ever surviving to be seen.
  const filtered =
    due !== null && due.step.label !== null
      ? toUnstale.filter((label) => label !== due.step.label)
      : toUnstale;

  return { due, toUnstale: filtered };
}

/** Every step's own label, present on the thread and attributed to our own actor — the un-staling candidates that need no anchor to identify. */
function collectStaleLabels(steps: readonly LifecycleStep[], facts: TrackFacts): readonly string[] {
  const stale: string[] = [];
  for (const step of steps) {
    if (
      step.label !== null &&
      facts.labels.includes(step.label) &&
      isOwnApplied(facts.events, step.label, facts.ownLogin)
    ) {
      stale.push(step.label);
    }
  }
  return stale;
}

/**
 * Whether `login` is this run's own actor.
 *
 * The empty-string half is the whole reason this is a function rather than
 * `===`. `resolveOwnLogin` returns `""` for an identity GitHub would not
 * report, and `readEvents`/`readComments` write `""` for an actor it no
 * longer carries — a deleted account, an app whose installation is gone.
 * Those are two different unknowns, and `===` called them the same actor: a
 * run whose own login could not be read attributed **every actorless event
 * to itself**, which is the exact opposite of what the three call sites
 * below are for.
 *
 * Measured before it was fixed: a `labeled` event with no actor got its label
 * removed, and an actorless comment carrying a forgeable fingerprint was read
 * as this duty's own step firing — advancing a track to its *closing* step on
 * a thread nobody had nudged.
 *
 * Unknown is never a match. Both sides have to be somebody.
 */
function isOwnActor(login: string, ownLogin: string): boolean {
  return ownLogin.length > 0 && login === ownLogin;
}

/**
 * Whether the most recent `labeled` event for `label`, across every actor
 * this run fetched history for, was raised by `ownLogin` — the attribution
 * gate un-staling requires. `false` on no event at all (no history reached
 * far enough back) and on any event authored by someone else, human or
 * bot: absent or ambiguous attribution is not this duty's to act on.
 */
function isOwnApplied(events: readonly TimedEvent[], label: string, ownLogin: string): boolean {
  let latest: TimedEvent | null = null;
  for (const event of events) {
    if (event.event !== "labeled" || event.label !== label) continue;
    if (latest === null || event.createdAt > latest.createdAt) latest = event;
  }
  return latest !== null && isOwnActor(latest.login, ownLogin);
}

/** The latest `labeled` event for `label` this run's own login raised — the firing evidence a label-only step reads instead of a marker comment. */
function latestOwnLabelEvent(
  events: readonly TimedEvent[],
  label: string,
  ownLogin: string,
): Date | null {
  let latest: Date | null = null;
  for (const event of events) {
    if (event.event !== "labeled" || event.label !== label) continue;
    if (!isOwnActor(event.login, ownLogin)) continue;
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
