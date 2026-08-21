import { describe, expect, it } from "vitest";

import { fingerprint, markerFor } from "../../core/marker.js";
import type {
  LifecycleExempt,
  LifecycleOverride,
  LifecyclePolicy,
  LifecycleStep,
  LifecycleTrack,
} from "../../core/warrant.js";
import {
  closeBlocked,
  evaluateLifecycle,
  evaluateTrack,
  fingerprintFor,
  humanCommentCount,
  latestQualifyingActivity,
  resolveOverrides,
  trackStart,
  type TrackFacts,
} from "./clock.js";
import type { TimedComment, TimedEvent } from "./timeline.js";

const MARKER = markerFor("lifecycle");
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-01-01T00:00:00Z");
/** This run's own authenticated login, for the clock-hand attribution gate — see `clock.ts`'s `isOwnApplied`. */
const OWN_LOGIN = "reeve[bot]";

function comment(over: Partial<TimedComment> = {}): TimedComment {
  return { id: 1, body: "", login: "alice", isBot: false, createdAt: T0, ...over };
}

function event(over: Partial<TimedEvent> = {}): TimedEvent {
  return { event: "labeled", label: null, login: "alice", isBot: false, createdAt: T0, ...over };
}

function facts(over: Partial<TrackFacts> = {}): TrackFacts {
  return {
    labels: [],
    milestone: null,
    assignees: [],
    createdAt: T0,
    authorLogin: "alice",
    comments: [],
    events: [],
    taxonomyNames: new Set(),
    ownLogin: OWN_LOGIN,
    ...over,
  };
}

function step(over: Partial<LifecycleStep> = {}): LifecycleStep {
  return { after: DAY, label: null, say: null, close: false, ...over };
}

function track(over: Partial<LifecycleTrack> = {}): LifecycleTrack {
  return { name: "stale", when: null, resets: "any", steps: [], ...over };
}

const EXEMPT: LifecycleExempt = {
  labels: [],
  milestones: true,
  assignees: true,
  taxonomy: false,
  comments: null,
  drafts: true,
};

function policy(over: Partial<LifecyclePolicy> = {}): LifecyclePolicy {
  return { tracks: [], exempt: EXEMPT, overrides: [], threads: "issues", ...over };
}

describe("latestQualifyingActivity", () => {
  it("returns null when nothing qualifies", () => {
    expect(latestQualifyingActivity(facts(), "any")).toBeNull();
  });

  it("ignores bot comments and bot activity events", () => {
    const f = facts({
      comments: [comment({ isBot: true, createdAt: new Date(T0.getTime() + DAY) })],
      events: [event({ isBot: true, createdAt: new Date(T0.getTime() + 2 * DAY) })],
    });
    expect(latestQualifyingActivity(f, "any")).toBeNull();
  });

  it("takes the latest of comments and qualifying events", () => {
    const later = new Date(T0.getTime() + 2 * DAY);
    const f = facts({
      comments: [comment({ createdAt: T0 })],
      events: [event({ event: "labeled", createdAt: later })],
    });
    expect(latestQualifyingActivity(f, "any")).toEqual(later);
  });

  it("ignores an event type that is not activity", () => {
    const f = facts({
      events: [event({ event: "mentioned", createdAt: new Date(T0.getTime() + DAY) })],
    });
    expect(latestQualifyingActivity(f, "any")).toBeNull();
  });

  it("scopes to the thread's own author when resets is author", () => {
    const f = facts({
      comments: [
        comment({ login: "bob", createdAt: new Date(T0.getTime() + DAY) }),
        comment({ login: "alice", createdAt: T0 }),
      ],
    });
    expect(latestQualifyingActivity(f, "author")).toEqual(T0);
  });
});

describe("trackStart", () => {
  it("returns null for a when: track that has never seen its label applied by a human", () => {
    const t = track({ when: "needs-info" });
    expect(trackStart(t, facts())).toBeNull();
  });

  it("starts a when: track at the latest human application of its label", () => {
    const t = track({ when: "needs-info" });
    const later = new Date(T0.getTime() + DAY);
    const f = facts({
      events: [
        event({ event: "labeled", label: "needs-info", createdAt: T0 }),
        event({ event: "labeled", label: "needs-info", createdAt: later }),
        event({
          event: "labeled",
          label: "needs-info",
          createdAt: new Date(T0.getTime() + 5 * DAY),
          isBot: true,
        }),
      ],
    });
    expect(trackStart(t, f)).toEqual(later);
  });

  it("starts an inactivity track at creation when nothing qualifies", () => {
    expect(trackStart(track(), facts({ createdAt: T0 }))).toEqual(T0);
  });

  it("starts an inactivity track at the latest qualifying activity, when later than creation", () => {
    const later = new Date(T0.getTime() + DAY);
    const f = facts({ createdAt: T0, comments: [comment({ createdAt: later })] });
    expect(trackStart(track(), f)).toEqual(later);
  });

  it("never starts an inactivity track before creation, even if a stray comment predates it", () => {
    const earlier = new Date(T0.getTime() - DAY);
    const f = facts({ createdAt: T0, comments: [comment({ createdAt: earlier })] });
    expect(trackStart(track(), f)).toEqual(T0);
  });
});

describe("resolveOverrides", () => {
  const overrides: readonly LifecycleOverride[] = [
    { label: "pinned", after: null, never: true },
    { label: "low-priority", after: 3 * DAY, never: false },
    { label: "very-low-priority", after: 10 * DAY, never: false },
  ];

  it("finds no override when no labels match", () => {
    expect(resolveOverrides(overrides, [])).toEqual({ neverExempt: false, firstStepAfter: null });
  });

  it("sets neverExempt when a never override's label is present", () => {
    expect(resolveOverrides(overrides, ["pinned"])).toEqual({
      neverExempt: true,
      firstStepAfter: null,
    });
  });

  it("takes the longest after among matching after overrides", () => {
    expect(resolveOverrides(overrides, ["low-priority", "very-low-priority"])).toEqual({
      neverExempt: false,
      firstStepAfter: 10 * DAY,
    });
  });
});

describe("fingerprintFor", () => {
  it("is deterministic for the same track, step and anchor", () => {
    const t = track({ name: "stale" });
    expect(fingerprintFor(t, 0, T0)).toBe(fingerprintFor(t, 0, T0));
  });

  it("differs when the anchor changes", () => {
    const t = track({ name: "stale" });
    expect(fingerprintFor(t, 0, T0)).not.toBe(fingerprintFor(t, 0, new Date(T0.getTime() + DAY)));
  });

  it("differs when the step index changes", () => {
    const t = track({ name: "stale" });
    expect(fingerprintFor(t, 0, T0)).not.toBe(fingerprintFor(t, 1, T0));
  });

  it("differs when the track name changes", () => {
    expect(fingerprintFor(track({ name: "a" }), 0, T0)).not.toBe(
      fingerprintFor(track({ name: "b" }), 0, T0),
    );
  });

  it("matches core/marker.ts's own fingerprint function directly", () => {
    const t = track({ name: "stale" });
    expect(fingerprintFor(t, 2, T0)).toBe(fingerprint(T0.toISOString(), ["stale", "2"]));
  });
});

describe("evaluateTrack", () => {
  it("is inert when a never override matched", () => {
    const t = track({ steps: [step()] });
    const result = evaluateTrack(t, facts(), { neverExempt: true, firstStepAfter: null }, T0);
    expect(result).toEqual({ due: null, toUnstale: [] });
  });

  it("has nothing due when the track has not started", () => {
    const t = track({ when: "needs-info", steps: [step()] });
    const result = evaluateTrack(t, facts(), { neverExempt: false, firstStepAfter: null }, T0);
    expect(result).toEqual({ due: null, toUnstale: [] });
  });

  it("is not due before its first step's after has elapsed", () => {
    const t = track({ steps: [step({ after: DAY })] });
    const soon = new Date(T0.getTime() + DAY / 2);
    const result = evaluateTrack(
      t,
      facts({ createdAt: T0 }),
      { neverExempt: false, firstStepAfter: null },
      soon,
    );
    expect(result.due).toBeNull();
  });

  it("is due once the first step's after has elapsed", () => {
    const t = track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] });
    const due = new Date(T0.getTime() + DAY);
    const result = evaluateTrack(
      t,
      facts({ createdAt: T0 }),
      { neverExempt: false, firstStepAfter: null },
      due,
    );
    expect(result.due).not.toBeNull();
    expect(result.due?.stepIndex).toBe(0);
    expect(result.due?.anchor).toEqual(T0);
  });

  it("uses the override's after for the first step of an inactivity track", () => {
    const t = track({ steps: [step({ after: DAY })] });
    const at5 = new Date(T0.getTime() + 5 * DAY);
    const notYet = evaluateTrack(
      t,
      facts({ createdAt: T0 }),
      { neverExempt: false, firstStepAfter: 10 * DAY },
      at5,
    );
    expect(notYet.due).toBeNull();
  });

  it("advances to a later step once a talking step's marker is found, using the marker's own timestamp as the next anchor", () => {
    const t = track({
      name: "stale",
      steps: [step({ after: DAY, say: { kind: "built-in" } }), step({ after: DAY, close: true })],
    });
    const firedAt = new Date(T0.getTime() + DAY);
    const fp0 = fingerprintFor(t, 0, T0);
    const f = facts({
      createdAt: T0,
      comments: [
        comment({
          body: `text\n\n${MARKER.render(fp0)}`,
          login: OWN_LOGIN,
          isBot: true,
          createdAt: firedAt,
        }),
      ],
    });
    const notYetDue = evaluateTrack(t, f, { neverExempt: false, firstStepAfter: null }, firedAt);
    expect(notYetDue.due).toBeNull(); // step 2 needs another `after` from firedAt

    const dueNow = new Date(firedAt.getTime() + DAY);
    const result = evaluateTrack(t, f, { neverExempt: false, firstStepAfter: null }, dueNow);
    expect(result.due?.stepIndex).toBe(1);
    expect(result.due?.anchor).toEqual(firedAt);
  });

  it("ignores a stranger's comment carrying the exact computed fingerprint", () => {
    // The fingerprint is a deterministic public hash over the track name and
    // the anchor, both of which any reader of the thread can observe — so a
    // commenter who copies it in is not evidence this duty's own step fired.
    // Without the two-part check, a stranger could anchor the clock to their
    // own comment and walk a `when:` track into permanent suppression.
    const t = track({
      name: "stale",
      steps: [step({ after: DAY, say: { kind: "built-in" } }), step({ after: DAY, close: true })],
    });
    const fp0 = fingerprintFor(t, 0, T0);
    const f = facts({
      createdAt: T0,
      comments: [
        // A human commenter who read the track name off the warrant and the
        // anchor off the timeline, and pasted the computed digest.
        comment({
          body: `text\n\n${MARKER.render(fp0)}`,
          login: "alice",
          isBot: false,
          createdAt: T0,
        }),
      ],
    });

    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(T0.getTime() + DAY),
    );

    // Step 0 did not fire: the whole track's clock still starts from T0 and
    // nothing has advanced past it, so the first step is the one due.
    expect(result.due).not.toBeNull();
    expect(result.due?.stepIndex).toBe(0);
  });

  it("fires a label-only step from this run's own latest labeled event, not a marker", () => {
    const t = track({
      name: "stale",
      steps: [step({ after: DAY, label: "stale" }), step({ after: DAY, label: "very-stale" })],
    });
    const firedAt = new Date(T0.getTime() + DAY);
    const f = facts({
      createdAt: T0,
      labels: ["stale"],
      events: [event({ event: "labeled", label: "stale", login: OWN_LOGIN, createdAt: firedAt })],
    });
    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(firedAt.getTime() + DAY),
    );
    expect(result.due?.stepIndex).toBe(1);
    expect(result.toUnstale).toEqual([]);
  });

  it("queues a step's label for un-staling when it is on the thread but its firing evidence predates the current anchor", () => {
    const t = track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] });
    const staleApplication = new Date(T0.getTime() + DAY);
    // A human comment after the label was applied resets the clock to a later anchor.
    const reset = new Date(staleApplication.getTime() + DAY);
    const f = facts({
      createdAt: T0,
      labels: ["stale"],
      events: [
        event({ event: "labeled", label: "stale", login: OWN_LOGIN, createdAt: staleApplication }),
      ],
      comments: [comment({ login: "alice", createdAt: reset })],
    });
    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(reset.getTime() + 1),
    );
    expect(result.toUnstale).toEqual(["stale"]);
  });

  it("the clock-hand exception: never un-stales a label a human hand-applied, even when it is otherwise stale", () => {
    const t = track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] });
    const staleApplication = new Date(T0.getTime() + DAY);
    const reset = new Date(staleApplication.getTime() + DAY);
    const f = facts({
      createdAt: T0,
      labels: ["stale"],
      // A human, not this run's own login, applied the label most recently.
      events: [
        event({ event: "labeled", label: "stale", login: "bob", createdAt: staleApplication }),
      ],
      comments: [comment({ login: "alice", createdAt: reset })],
    });
    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(reset.getTime() + 1),
    );
    expect(result.toUnstale).toEqual([]);
  });

  it("the clock-hand exception: never un-stales a label a *different* bot applied last — the bot a project migrated away from", () => {
    // `clock.ts`'s own doctrine names this case: un-staling retracts only a
    // labelling this run's own actor is the most recent author of. A label
    // some other automation applied is as foreign as a human's — the whole
    // point of the attribution gate is that only one actor is this duty.
    const t = track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] });
    const staleApplication = new Date(T0.getTime() + DAY);
    const reset = new Date(staleApplication.getTime() + DAY);
    const f = facts({
      createdAt: T0,
      labels: ["stale"],
      // A different bot entirely — `[bot]` suffix and all — applied last.
      events: [
        event({
          event: "labeled",
          label: "stale",
          login: "stale-hunter[bot]",
          isBot: true,
          createdAt: staleApplication,
        }),
      ],
      comments: [comment({ login: "alice", createdAt: reset })],
    });
    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(reset.getTime() + 1),
    );
    expect(result.toUnstale).toEqual([]);
  });

  it("the clock-hand exception: never un-stales a label whose event names no actor at all", () => {
    // GitHub answers `actor: null` for an event whose account was deleted, and
    // `timeline.ts:169` reads that as the empty login. Ambiguous attribution,
    // by this module's own doctrine — so the label stays.
    const t = track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] });
    const staleApplication = new Date(T0.getTime() + DAY);
    const reset = new Date(staleApplication.getTime() + DAY);
    const f = facts({
      createdAt: T0,
      labels: ["stale"],
      events: [event({ event: "labeled", label: "stale", login: "", createdAt: staleApplication })],
      comments: [comment({ login: "alice", createdAt: reset })],
    });
    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(reset.getTime() + 1),
    );
    expect(result.toUnstale).toEqual([]);
  });

  it("never reads a comment from another login as its own step firing, however right the fingerprint is", () => {
    // The forgeable half of the two-part attribution at `clock.ts:238-249`.
    // The fingerprint is a public hash over the track name and the anchor, so
    // a stranger can compute it; only the authorship half stops them anchoring
    // the clock to their own comment and walking the ladder to the close.
    const t = track({
      name: "stale",
      resets: "author",
      steps: [step({ after: DAY, say: { kind: "built-in" } }), step({ after: DAY, close: true })],
    });
    const fp0 = fingerprintFor(t, 0, T0);
    const f = facts({
      createdAt: T0,
      comments: [
        comment({
          login: "mallory",
          body: MARKER.render(fp0),
          createdAt: new Date(T0.getTime() + DAY),
        }),
      ],
    });
    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(T0.getTime() + 5 * DAY),
    );
    // The first step is what is due — the ladder never advanced to the close.
    expect(result.due?.stepIndex).toBe(0);
  });

  // Two cases this duty gets WRONG when its own login is unreadable. Both
  // compare a login against `facts.ownLogin` with `===`, and two empty strings
  // compare equal:
  //
  //   - `resolveOwnLogin` (`timeline.ts:141`) answers `data.login ?? ""`;
  //   - `readEvents` (`timeline.ts:169`) and `readComments` (`:121`) answer
  //     `""` for an event or comment whose account GitHub no longer reports.
  //
  // So a run whose `getAuthenticated()` answered without a login attributes
  // every actorless `labeled` event to itself — un-staling a label this duty
  // never applied — and reads a deleted account's comment carrying the
  // (public, computable) fingerprint as its own step firing, which advances
  // the ladder to the close. `clock.ts`'s header promises the opposite in both
  // cases: "absent or ambiguous attribution leaves the label alone".
  //
  // Both repros are the two cases above with `ownLogin: ""` added to `facts`.
  // Verified red against the current source: the first yields
  // `toUnstale: ["stale"]`, the second `due.stepIndex === 1` — the closing
  // step. Left as todos rather than pinned, because pinning either would
  // bless it.
  it.todo("an unreadable own login never claims a label event that names no actor");
  it.todo("an unreadable own login never reads an actorless comment as its own step firing");

  it("the clock-hand exception: never un-stales a label with no matching event in the fetched history — ambiguous attribution is left alone", () => {
    const t = track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] });
    const reset = new Date(T0.getTime() + 2 * DAY);
    const f = facts({
      createdAt: T0,
      labels: ["stale"],
      // No `labeled` event at all for "stale" — the history this run fetched
      // does not reach far enough back to say who applied it.
      events: [],
      comments: [comment({ login: "alice", createdAt: reset })],
    });
    const result = evaluateTrack(
      t,
      f,
      { neverExempt: false, firstStepAfter: null },
      new Date(reset.getTime() + 1),
    );
    expect(result.toUnstale).toEqual([]);
  });
});

describe("closeBlocked", () => {
  it("is false when there was never a bot close", () => {
    expect(closeBlocked(facts())).toBe(false);
  });

  it("is true once a human reopens after a bot close", () => {
    const f = facts({
      events: [
        event({ event: "closed", isBot: true, createdAt: T0 }),
        event({ event: "reopened", isBot: false, createdAt: new Date(T0.getTime() + DAY) }),
      ],
    });
    expect(closeBlocked(f)).toBe(true);
  });

  it("is false when the reopen predates the bot close", () => {
    const f = facts({
      events: [
        event({ event: "reopened", isBot: false, createdAt: T0 }),
        event({ event: "closed", isBot: true, createdAt: new Date(T0.getTime() + DAY) }),
      ],
    });
    expect(closeBlocked(f)).toBe(false);
  });

  it("ignores a bot's own reopen", () => {
    const f = facts({
      events: [
        event({ event: "closed", isBot: true, createdAt: T0 }),
        event({ event: "reopened", isBot: true, createdAt: new Date(T0.getTime() + DAY) }),
      ],
    });
    expect(closeBlocked(f)).toBe(false);
  });

  it("is not blocked by a reopen at the exact same timestamp as the close", () => {
    // GitHub timestamps carry second precision, so a close and a reopen in
    // the same second really happen. There is no order to know — `closeBlocked`
    // refuses to guess one, and a same-instant reopen does not block. The
    // human's own words on the thread are still the guard; only the event
    // order this check cannot see is left alone.
    const f = facts({
      events: [
        event({ event: "closed", isBot: true, createdAt: T0 }),
        event({ event: "reopened", isBot: false, createdAt: T0 }),
      ],
    });
    expect(closeBlocked(f)).toBe(false);
  });
});

describe("humanCommentCount", () => {
  it("counts only non-bot comments", () => {
    const f = facts({
      comments: [comment({ isBot: false }), comment({ isBot: true }), comment({ isBot: false })],
    });
    expect(humanCommentCount(f)).toBe(2);
  });
});

describe("evaluateLifecycle", () => {
  it("returns no actions and no unstale when there are no tracks", () => {
    expect(evaluateLifecycle(policy(), facts(), T0)).toEqual({
      actions: [],
      unstale: [],
      permanentlyExempt: null,
    });
  });

  it("fires a due step for a single track", () => {
    const p = policy({
      tracks: [track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] })],
    });
    const result = evaluateLifecycle(p, facts({ createdAt: T0 }), new Date(T0.getTime() + DAY));
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.track.name).toBe("stale");
  });

  it("withholds every new action once exempt.labels matches, but still un-stales", () => {
    const p = policy({
      tracks: [track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] })],
      exempt: { ...EXEMPT, labels: ["pinned"] },
    });
    const staleApplication = new Date(T0.getTime() + DAY);
    const reset = new Date(staleApplication.getTime() + DAY);
    const f = facts({
      createdAt: T0,
      labels: ["stale", "pinned"],
      events: [
        event({ event: "labeled", label: "stale", login: OWN_LOGIN, createdAt: staleApplication }),
      ],
      comments: [comment({ login: "alice", createdAt: reset })],
    });
    const result = evaluateLifecycle(p, f, new Date(reset.getTime() + 1));
    expect(result.actions).toEqual([]);
    expect(result.permanentlyExempt).toBe("pinned");
    expect(result.unstale).toEqual(["stale"]);
  });

  it("withholds a due step when the thread's milestone is exempt", () => {
    const p = policy({
      tracks: [track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] })],
    });
    const f = facts({ createdAt: T0, milestone: "v1" });
    const result = evaluateLifecycle(p, f, new Date(T0.getTime() + DAY));
    expect(result.actions).toEqual([]);
  });

  it("withholds a due step when an assignee is exempt", () => {
    const p = policy({
      tracks: [track({ name: "stale", steps: [step({ after: DAY, label: "stale" })] })],
    });
    const f = facts({ createdAt: T0, assignees: ["carol"] });
    const result = evaluateLifecycle(p, f, new Date(T0.getTime() + DAY));
    expect(result.actions).toEqual([]);
  });

  it("withholds a due step when a taxonomy label other than the track's own when-label is present", () => {
    const p = policy({
      tracks: [
        track({
          name: "needs-info-reminder",
          when: "needs-info",
          steps: [step({ after: DAY, close: true })],
        }),
      ],
      exempt: { ...EXEMPT, taxonomy: true },
    });
    const applied = T0;
    const f = facts({
      createdAt: T0,
      labels: ["needs-info", "bug"],
      taxonomyNames: new Set(["bug"]),
      events: [event({ event: "labeled", label: "needs-info", isBot: false, createdAt: applied })],
    });
    const result = evaluateLifecycle(p, f, new Date(applied.getTime() + DAY));
    expect(result.actions).toEqual([]);
  });

  it("blocks a due close step once the reopened-after-close guard trips, but not an unrelated track's due reminder", () => {
    // Both steps are parse-legal shapes: `close` is the track's last step,
    // never its first (an inactivity track's first step closing is refused
    // by the warrant parser — see `warrant.ts`'s "first step closes" check).
    // `resets: "author"` keeps the guard's own reopen event (below, by a
    // maintainer who is not the thread's author) from also counting as
    // qualifying activity that would reset `close-track`'s own anchor —
    // this test is about the guard blocking `close`, not about a reopen
    // restarting the inactivity clock.
    const closeTrack = track({
      name: "close-track",
      resets: "author",
      steps: [step({ after: DAY, say: { kind: "built-in" } }), step({ after: DAY, close: true })],
    });
    const reminderTrack = track({
      name: "reminder-track",
      steps: [step({ after: DAY, say: { kind: "built-in" } })],
    });
    const p = policy({ tracks: [closeTrack, reminderTrack] });

    const firedAt = new Date(T0.getTime() + DAY);
    const fp0 = fingerprintFor(closeTrack, 0, T0);
    const f = facts({
      createdAt: T0,
      // `close-track`'s first step already fired, so its close step is next
      // in line; `reminder-track`'s own (unrelated) step is independently
      // due by the same clock.
      comments: [
        comment({
          body: `text\n\n${MARKER.render(fp0)}`,
          login: OWN_LOGIN,
          isBot: true,
          createdAt: firedAt,
        }),
      ],
      events: [
        event({ event: "closed", isBot: true, createdAt: firedAt }),
        event({
          event: "reopened",
          isBot: false,
          login: "carol",
          createdAt: new Date(firedAt.getTime() + DAY),
        }),
      ],
    });
    const result = evaluateLifecycle(p, f, new Date(firedAt.getTime() + 10 * DAY));
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.track.name).toBe("reminder-track");
  });

  it("blocks a due close step once the human comment guard is met", () => {
    // Parse-legal shape: `close` is the track's second (last) step, not its
    // first.
    const closeTrack = track({
      name: "stale",
      steps: [step({ after: DAY, say: { kind: "built-in" } }), step({ after: DAY, close: true })],
    });
    const p = policy({
      tracks: [closeTrack],
      exempt: { ...EXEMPT, comments: 2 },
    });
    const firedAt = new Date(T0.getTime() + DAY);
    const fp0 = fingerprintFor(closeTrack, 0, T0);
    const f = facts({
      createdAt: T0,
      comments: [
        comment({
          body: `text\n\n${MARKER.render(fp0)}`,
          login: OWN_LOGIN,
          isBot: true,
          createdAt: firedAt,
        }),
        comment({ createdAt: T0 }),
        comment({ createdAt: T0 }),
      ],
    });
    const result = evaluateLifecycle(p, f, new Date(firedAt.getTime() + DAY));
    expect(result.actions).toEqual([]);
  });
});
