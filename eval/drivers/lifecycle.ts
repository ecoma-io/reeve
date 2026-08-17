/**
 * The lifecycle driver: what one fixture means, and what a run over it must
 * show.
 *
 * Lifecycle is the one duty that never calls a model — every decision is a
 * function of label state and comment/event timestamps against the warrant's
 * own durations. So unlike triage/respond/translate/duplicate there is no
 * completion script; the stub only answers the GitHub API the duty reads.
 *
 * The clock is deterministic because the fixture drives the timestamps: the
 * thread's `created_at`, its timeline events and its comments are all computed
 * by the driver relative to the run's own `now` (`now - created-ago`), so an
 * inactivity track whose `after` falls inside that window is always due on
 * every run. The durations are relative, never fixed instants — the fixtures
 * stay byte-stable across runs, weeks, and timezones.
 *
 * The effect is recorded by the stub routes exactly like triage's: labels,
 * comment and close all land on the thread the stub serves, and the runner
 * compares the record against the fixture's expected effects.
 *
 * The fixture's `.expected.json` reads:
 *
 * - `warrant`               — the warrant text to run under (required, since
 *   lifecycle has no implicit policy).
 * - `labels`                — the labels the thread carries.
 * - `repo-labels`           — the labels the repository has. Must include
 *   every label the warrant's tracks/overrides/exempt name, because the
 *   label-existence rehearsal check fails a run that names a label the
 *   repository does not have. Defaults to the thread's labels.
 * - `reactions`             — the timeline's `labeled` events, as
 *   `{label, created-ago, actor, is-bot?}` rows. What a `when:` track's
 *   clock starts counting from, and what makes a label own-applied.
 * - `comments`              — the comments the timeline serves, as
 *   `{login, is-bot?, created-ago, marker?}` rows. Activity under
 *   `resets: any`, and the firing evidence for steps that talk.
 * - `created-ago`           — how long ago the thread was created (default
 *   `30d`). The inactivity clock starts here.
 * - `expected`              — the outputs the run must report: `skipped`,
 *   `reminded`, `labeled`, `closed`, `unstaled`, `due-not-granted`, and the
 *   effects the stub recorded.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Route } from "../harness.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** One `labeled` event on the thread's timeline. */
export interface LifecycleReaction {
  readonly label: string;
  /** Milliseconds before `now` the event happened. */
  readonly createdAgo: number;
  readonly login: string;
  readonly isBot: boolean;
}

/** One comment on the thread's timeline. */
export interface LifecycleComment {
  readonly login: string;
  readonly isBot: boolean;
  /** Milliseconds before `now` the comment happened. */
  readonly createdAgo: number;
  /** A pre-existing lifetime marker the comment carries, for stepped fixtures. */
  readonly marker?: string;
}

/** The one thread the run is asked to keep alive. */
export interface LifecycleThread {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** Milliseconds before `now` the thread was created. */
  readonly createdAgo: number;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  /** The labels the repository has, for the rehearsal check. */
  readonly repoLabels: readonly string[];
}

export interface LifecycleEffect {
  labeled: boolean;
  commented: boolean;
  closed: boolean;
  unstaled: boolean;
}

/** What the run did to the thread, as the stub routes saw it. */
export interface LifecycleTracker {
  readonly effect: LifecycleEffect;
}

export interface LifecycleScenario {
  readonly name: string;
  readonly thread: LifecycleThread;
  /** The reactions the thread's timeline serves. */
  readonly reactions: readonly LifecycleReaction[];
  /** The comments the thread's timeline serves. */
  readonly comments: readonly LifecycleComment[];
  /** The warrant to run under — lifecycle has no implicit policy. */
  readonly warrant: string;
  /** The assertions this fixture declares. */
  readonly expected: LifecycleAssertions;
}

/** The fixture's `.expected.json`: configuration at the top. */
export interface LifecycleFixture {
  readonly description?: string;
  readonly warrant: string;
  /** The labels the thread carries. */
  readonly labels?: readonly string[];
  /** The labels the repository has; defaults to the thread's labels. */
  readonly "repo-labels"?: readonly string[];
  /** The thread to serve, when a fixture is not the default one. */
  readonly thread?: Pick<LifecycleThread, "title" | "body" | "state">;
  /** How long ago the thread was created, as a duration like `30d`. */
  readonly "created-ago"?: string;
  /** The `labeled` events the timeline serves. */
  readonly reactions?: readonly {
    label: string;
    "created-ago": string;
    actor: string;
    "is-bot"?: boolean;
  }[];
  /** The comments the timeline serves. */
  readonly comments?: readonly {
    login: string;
    "is-bot"?: boolean;
    "created-ago": string;
    marker?: string;
  }[];
  readonly expected?: LifecycleAssertions;
}

/** The assertions one lifecycle fixture declares — compared against the run. */
export interface LifecycleAssertions {
  readonly skipped?: string;
  readonly reminded?: string;
  readonly labeled?: string;
  readonly closed?: string;
  readonly unstaled?: string;
  readonly "due-not-granted"?: string;
  readonly effects?: Partial<LifecycleEffect>;
}

const REPORT =
  "The dark mode toggle does not persist after a page reload, and it should. " +
  "I checked the settings and it resets every time I open the page.";

/** The thread every fixture runs on, unless its `.expected.json` says otherwise. */
export const DEFAULT_LIFECYCLE_THREAD: LifecycleThread = {
  number: 42,
  title: "Dark mode resets on reload",
  body: REPORT,
  createdAgo: 30 * DAY,
  labels: [],
  state: "open",
  repoLabels: [],
};

/** A duration like `30d` or `6h`, in milliseconds — the fixture grammar. */
function agoToMs(raw: string): number {
  const match = /^(\d+)(d|h)$/.exec(raw);
  if (match === null) throw new Error(`lifecycle: \`${raw}\` is not a duration like \`30d\`.`);
  const value = Number(match[1]);
  return value * (match[2] === "d" ? DAY : HOUR);
}

/** The routes one lifecycle run needs: the thread, its comments, its events, the token's identity, and the repository's labels. */
export function lifecycleRoutes(scenario: LifecycleScenario, tracker: LifecycleTracker): Route[] {
  const thread = scenario.thread;
  const now = new Date();
  const isoAgo = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  const reactions = scenario.reactions;
  const comments = scenario.comments;
  const repoLabels = thread.repoLabels;
  let state: "open" | "closed" = thread.state;

  const events: unknown[] = reactions.map((reaction) => ({
    event: "labeled",
    label: { name: reaction.label },
    actor: { login: reaction.login, type: reaction.isBot ? "Bot" : "User" },
    created_at: isoAgo(reaction.createdAgo),
  }));
  const commentRows = comments.map((comment, index) => ({
    id: index + 1,
    body:
      comment.marker !== undefined
        ? `Reeve's step fired. ${comment.marker}`
        : comment.isBot
          ? `A lifecycle reminder.`
          : "Still relevant, thanks.",
    user: { login: comment.login, type: comment.isBot ? "Bot" : "User" },
    created_at: isoAgo(comment.createdAgo),
  }));

  return [
    (raw, request, response) => {
      void raw;
      const method = request.method ?? "?";
      const url = (request.url ?? "/").split("?")[0] ?? "/";

      // The run's own identity — the attribution gate's "who is our actor".
      if (method === "GET" && url === "/user") {
        send(response, 200, { login: "reeve[bot]", type: "Bot" });
        return true;
      }

      // The thread itself, with a mutable close state.
      const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(url);
      if (method === "GET" && issue !== null) {
        send(response, 200, {
          number: thread.number,
          title: thread.title,
          body: thread.body,
          labels: thread.labels,
          state,
          created_at: isoAgo(thread.createdAgo),
          user: { login: "reporter", type: "User" },
        });
        return true;
      }
      if (method === "PATCH" && issue !== null) {
        const payload = parsed(raw) as { state?: string };
        if (payload.state === "closed") {
          state = "closed";
          tracker.effect.closed = true;
        }
        send(response, 200, { number: thread.number, state });
        return true;
      }

      // The thread's comments and events — the clock's two inputs.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null) {
        send(response, 200, commentRows);
        return true;
      }
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/events$/.exec(url) !== null) {
        send(response, 200, events);
        return true;
      }

      // A label add or remove — the effects the run writes.
      if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/.exec(url) !== null) {
        tracker.effect.labeled = true;
        send(response, 200, []);
        return true;
      }
      if (
        method === "DELETE" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels\/[^/]+$/.exec(url) !== null
      ) {
        tracker.effect.unstaled = true;
        send(response, 200, []);
        return true;
      }

      // A comment — the reminder (or close explanation) the run posts.
      if (
        method === "POST" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null
      ) {
        tracker.effect.commented = true;
        send(response, 201, { id: 99 });
        return true;
      }

      // The repository's labels — the rehearsal check before any evaluation.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/labels$/.exec(url) !== null) {
        send(
          response,
          200,
          repoLabels.map((name) => ({ name, description: `Reeve managed label: ${name}` })),
        );
        return true;
      }

      void scenario;
      return false;
    },
  ];
}

function parsed(raw: string): unknown {
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function send(
  response: {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(text: string): unknown;
  },
  status: number,
  payload: unknown,
): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  response.end(text);
}

/** Reads the fixture's `.expected.json` into a runnable scenario. */
export async function scenarioOf(name: string, directory: string): Promise<LifecycleScenario> {
  const fixture = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as LifecycleFixture;
  const assertions = fixture.expected ?? {};
  const labels = fixture.labels ?? [];
  const repoLabels = fixture["repo-labels"] ?? labels;
  const base = {
    ...DEFAULT_LIFECYCLE_THREAD,
    ...(fixture.thread ?? {}),
    labels,
    repoLabels,
    ...(fixture["created-ago"] !== undefined
      ? { createdAgo: agoToMs(fixture["created-ago"]) }
      : {}),
  };
  return {
    name,
    thread: base,
    reactions: (fixture.reactions ?? []).map((reaction) => ({
      label: reaction.label,
      createdAgo: agoToMs(reaction["created-ago"]),
      login: reaction.actor,
      isBot: reaction["is-bot"] === true,
    })),
    comments: (fixture.comments ?? []).map((comment) =>
      comment.marker === undefined
        ? {
            login: comment.login,
            isBot: comment["is-bot"] === true,
            createdAgo: agoToMs(comment["created-ago"]),
          }
        : {
            login: comment.login,
            isBot: comment["is-bot"] === true,
            createdAgo: agoToMs(comment["created-ago"]),
            marker: comment.marker,
          },
    ),
    warrant: fixture.warrant,
    expected: assertions,
  };
}

/** A fresh tracker for one fixture run. */
export function newTracker(): LifecycleTracker {
  return { effect: { labeled: false, commented: false, closed: false, unstaled: false } };
}
