/**
 * The triage driver: what one fixture means, and what a run over it must show.
 *
 * Triage applies its effects through the tracker API — labels, comments,
 * assignments, closes — not through files the runner can read back. So a run's
 * effect is recorded by the stub routes themselves: `newTracker()` hands the
 * runner a mutable record, the routes write into it as the run calls the API,
 * and the runner compares the record against the fixture's expected effects.
 *
 * The fixture's `.expected.json` reads:
 *
 * - `effects.applied`    — the labels the API was told to put on the thread.
 * - `effects.commented`  — true when the run posted its triaged comment.
 * - `effects.assigned`   — the owner handles the run assigned.
 * - `effects.closed`     — true when the run closed the thread as a duplicate.
 * - `screened-out`       — the machine-readable reason the run stopped cleanly
 *   (empty/template/too-short/spam/off-topic), or "" when it reached a verdict.
 * - `duplicate-of`       — the target a matching verdict named, or null.
 * - `applied-names`      — the labels that survived enforcement (equals the
 *   `applied` effect unless the fixture wants a refused run, where they differ).
 * - `warrant`            — the warrant text to run under; absent uses the
 *   implicit warrant (the repository's own label descriptions, labelling only).
 * - `screen-models`      — the spam screen's roster, to keep that model call off
 *   unless a fixture's `screened-out` names `spam` or `off-topic`.
 *
 * A fixture omitting `effects` expects no API writes: warrant-denied, screened
 * out, under-floor and already-labelled all leave the tracker untouched.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Answer, Route } from "../harness.ts";
import { saying } from "../harness.ts";

/** The one thread the stub serves. */
export interface Thread {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** Labels already on the thread when the run starts. */
  readonly onboard: readonly string[];
}

/** What the run did to the thread, as the stub routes saw it. */
export interface TrackerEffect {
  readonly applied: string[];
  commented: boolean;
  readonly assigned: string[];
  closed: boolean;
}

/** A mutable record the stub routes write into as the run calls the API. */
export interface Tracker {
  readonly effect: TrackerEffect;
}

/** The labels the repository has, and what the implicit warrant turns them into. */
export interface RepositoryLabel {
  readonly name: string;
  readonly description: string;
  /** A bare handle (`ana`) when the run may assign this label's owner. */
  readonly owner?: string;
}

export interface TriageScenario {
  readonly name: string;
  readonly thread: Thread;
  readonly repositoryLabels: readonly RepositoryLabel[];
  /** Name → description, for a description that differs from the taxonomy's. */
  readonly labelDescriptions: Record<string, string>;
  /** The warrant to run under, or null for the implicit one. */
  readonly warrant: string | null;
  /** The verdict JSON the triage stage answers with. */
  readonly verdict: string;
  /** The spam screen's one-word answer, when that roster is configured. */
  readonly screen: string;
  /** The language-detection answer, when detection reaches a model. */
  readonly detect: string;
  /** Inputs that differ from the driver defaults (e.g. a confidence floor). */
  readonly inputs?: Record<string, string>;
  /** The assertions this fixture declares — compared against the run. */
  readonly expected: FixtureAssertions;
}

/** The fixture's `.expected.json`: configuration at the top, assertions under `expected`. */
export interface FixtureExpected {
  readonly description?: string;
  readonly warrant?: string;
  /** Whether to wire the spam screen (`screen-models`), to cost that call. */
  readonly "screen-models"?: boolean;
  /** Fields to override in the default verdict JSON. */
  readonly "verdict-over"?: Record<string, unknown>;
  /** The thread to serve, when a fixture is not the default report. */
  readonly thread?: Pick<Thread, "title" | "body">;
  /**
   * The language code detection must answer when it reaches the model — a
   * thread in a language the profile data does not cover (e.g. one outside the
   * bundled sixty) is handed to the model, and this scripts its answer.
   * Defaults to `en`.
   */
  readonly detect?: string;
  readonly expected?: FixtureAssertions;
}

/** The assertions one triage fixture declares — compared against the run. */
export interface FixtureAssertions {
  readonly "screened-out"?: string;
  readonly "duplicate-of"?: number | null;
  readonly "applied-names"?: readonly string[];
  /**
   * The language the thread must have been identified as — the label of the
   * language the run's `language` output carries. Declaring one makes a run
   * that identified the thread as anything else `failed`, never `skipped`.
   */
  readonly language?: string;
  readonly effects?: Pick<TrackerEffect, "applied" | "commented" | "assigned" | "closed">;
}

const REPORT =
  "The dark mode toggle does not persist after a page reload; it should be " +
  "written to local storage.";

/** The thread every fixture runs on, unless its `.expected.json` says otherwise. */
export const DEFAULT_THREAD: Thread = {
  number: 42,
  title: "Dark mode resets on reload",
  body: REPORT,
  onboard: [],
};

/** A verdict, in the shape the prompt asks for. */
export function verdictOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    labels: ["bug"],
    confidence: 0.9,
    duplicate_of: null,
    rationale: "It regressed.",
    ...over,
  });
}

/** Reads the fixture's `.expected.json` into a runnable scenario. */
export async function scenarioOf(name: string, directory: string): Promise<TriageScenario> {
  const doc = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as FixtureExpected;
  const over = doc["verdict-over"];
  const screened = doc.expected?.["screened-out"];
  return {
    name,
    thread: doc.thread === undefined ? DEFAULT_THREAD : { ...DEFAULT_THREAD, ...doc.thread },
    repositoryLabels: [
      { name: "bug", description: "Something that used to work and does not.", owner: "ana" },
      { name: "docs", description: "The documentation is wrong or missing." },
      { name: "question", description: "Asks for help or guidance." },
      { name: "duplicate", description: "Repeats an existing thread." },
    ],
    labelDescriptions: {},
    warrant: doc.warrant ?? null,
    verdict: verdictOf(over ?? {}),
    screen:
      doc["screen-models"] === true && (screened === "spam" || screened === "off-topic")
        ? screened
        : "keep",
    detect: doc.detect ?? "en",
    inputs: {
      ...(doc["screen-models"] === true ? { "screen-models": "stub-screen" } : {}),
    },
    expected: doc.expected ?? {},
  };
}

/** The answer each stage scripts, from the prompt marker it saw. */
export function scriptTriage(
  scenario: TriageScenario,
): (ask: { readonly model: string; readonly system: string; readonly user: string }) => Answer {
  return (ask) => {
    if (ask.system.includes("You are triaging an issue on a GitHub repository")) {
      return saying(scenario.verdict);
    }
    // The cheap screen's prompt wraps `maintainer's` and `attention` across
    // two literal lines, so the marker survives the wrap instead of ending
    // before it: the fragment is the half the phrase cannot vary in.
    if (ask.system.includes("worth a maintainer's")) {
      return saying(scenario.screen);
    }
    if (ask.system.includes("You identify which language")) {
      return saying(scenario.detect);
    }
    return saying("unknown stage");
  };
}

/** The routes one triage run needs: the tracker, and nothing else but completion. */
export function triageRoutes(scenario: TriageScenario, tracker: Tracker): Route[] {
  const thread = scenario.thread;
  return [
    (raw, request, response) => {
      void raw;
      const method = request.method ?? "?";
      const url = (request.url ?? "/").split("?")[0] ?? "/";
      const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(url);

      if (method === "GET" && issue !== null) {
        send(response, 200, {
          number: thread.number,
          title: thread.title,
          body: thread.body,
          // As GitHub sends them: objects with a name, which is the shape a run
          // has to read a name out of before any guardrail can compare one.
          labels: thread.onboard.map((name) => ({ name })),
          state: "open",
          user: { login: "reporter", type: "User" },
        });
        return true;
      }

      // The repository's own labels — read by every explicit-warrant run to
      // check the taxonomy against what the repository actually has.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/labels$/.exec(url) !== null) {
        const labels = scenario.repositoryLabels.map((label) => ({
          name: label.name,
          description: scenario.labelDescriptions[label.name] ?? label.description,
        }));
        send(response, 200, [...labels, ...thread.onboard.map((name) => ({ name }))]);
        return true;
      }

      if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/.exec(url) !== null) {
        const payload = parsed(raw) as { labels?: string[] };
        tracker.effect.applied.push(...(payload.labels ?? []));
        const names = payload.labels ?? [];
        send(
          response,
          200,
          names.map((name) => ({ name })),
        );
        return true;
      }

      if (
        method === "POST" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null
      ) {
        tracker.effect.commented = true;
        send(response, 201, { id: 1 });
        return true;
      }

      if (
        method === "POST" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/assignees$/.exec(url) !== null
      ) {
        const payload = parsed(raw) as { assignees?: string[] };
        tracker.effect.assigned.push(...(payload.assignees ?? []));
        send(response, 201, { number: thread.number });
        return true;
      }

      if (method === "PATCH" && issue !== null) {
        const payload = parsed(raw) as { state?: string; state_reason?: string };
        tracker.effect.closed =
          payload.state === "closed" && payload.state_reason === "not_planned";
        send(response, 200, { number: thread.number });
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

/** A fresh tracker for one fixture run. */
export function newTracker(): Tracker {
  return { effect: { applied: [], commented: false, assigned: [], closed: false } };
}
