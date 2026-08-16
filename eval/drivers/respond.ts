/**
 * The respond driver: what one fixture means, and what a run over it must show.
 *
 * Respond posts its reply through the tracker API, so the effect is recorded by
 * the stub routes exactly like triage's: `newTracker()` hands the runner a
 * mutable record, the routes write into it, and the runner compares it against
 * the fixture's expected effects.
 *
 * The fixture's `.expected.json` carries configuration at the top and the
 * assertions a run must satisfy under `expected`, matching the harmonise and
 * triage drivers:
 *
 * - `effects.commented`  — true when the run posted the reply comment.
 * - `screened-out`       — the reason a clean early stop gave (spam/off-topic),
 *   or "" when the run reached a verdict.
 * - `patch`              — the reply text the draft answered with, when there
 *   was one; absent for the fixtures that stopped before drafting.
 * - `warrant`            — the warrant text to run under; absent uses the
 *   implicit one (which grants respond nothing).
 * - `screen-models`      — the spam screen's roster, to keep that call off
 *   unless the fixture expects a spam/off-topic stop.
 * - `already-answered`   — a foreign body on the thread; the walk stops at the
 *   first human reply or this duty's own marker. False (the default) serves no
 *   replies, so the run drafts fresh.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Answer, Route } from "../harness.ts";
import { saying } from "../harness.ts";

export interface RespondThread {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** A comment body already on the thread (a human's reply), or null. */
  readonly replied?: string;
}

export interface RespondEffect {
  commented: boolean;
}

/** The reply text a drafting fixture answers with. */
const REPLY_TEXT =
  "Thanks for the report — dark mode is saved for the session only, not to local " +
  "storage. We will fix it so the choice persists across reloads.";

export interface RespondScenario {
  readonly name: string;
  readonly thread: RespondThread;
  /** The warrant to run under, or null for the implicit one. */
  readonly warrant: string | null;
  /** The spam screen's one-word answer, when that roster is configured. */
  readonly screen: string;
  /** The language-detection answer. */
  readonly detect: string;
  /** The draft's JSON answer. */
  readonly reply: string;
  /**
   * True when the fixture serves a human reply on the thread — the run must
   * therefore stop there, which the runner asserts against the summary note.
   */
  readonly alreadyAnswered: boolean;
  /** Inputs that differ from the driver defaults. */
  readonly inputs?: Record<string, string>;
  /** The assertions this fixture declares. */
  readonly expected: RespondAssertions;
}

/** The fixture's `.expected.json`: configuration at the top. */
export interface RespondFixture {
  readonly description?: string;
  readonly "already-answered"?: boolean;
  readonly warrant?: string;
  readonly "screen-models"?: boolean;
  /** Fields to override in the default draft JSON. */
  readonly "draft-over"?: Record<string, unknown>;
  /** The thread to serve, when a fixture is not the default report. */
  readonly thread?: Pick<RespondThread, "title" | "body">;
  readonly expected?: RespondAssertions;
}

/** The assertions one respond fixture declares — compared against the run. */
export interface RespondAssertions {
  /** What the summary verdict page must say the run stopped for. */
  readonly "stopped-for"?: string;
  readonly effects?: Pick<RespondEffect, "commented">;
  /** The reply text expected, or null for a run that stopped without drafting. */
  readonly patch?: string | null;
}

export interface RespondTracker {
  readonly effect: RespondEffect;
}

const RESPOND_REPORT =
  "The dark mode toggle does not persist after a page reload, and it should. " +
  "I checked the settings and it resets every time I open the page.";

/** The thread every respond fixture runs on. */
export const DEFAULT_RESPOND_THREAD: RespondThread = {
  number: 42,
  title: "Dark mode resets on reload",
  body: RESPOND_REPORT,
};

/** A draft, in the shape the prompt asks for. */
export function replyOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ text: REPLY_TEXT, confidence: 0.9, ...over });
}

/** The answer each stage scripts, from the prompt marker it saw. */
export function scriptRespond(
  scenario: RespondScenario,
): (ask: { readonly model: string; readonly system: string; readonly user: string }) => Answer {
  return (ask) => {
    if (ask.system.includes("You are writing the first reply to a new issue")) {
      return saying(scenario.reply);
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

/** The routes one respond run needs: the thread, its replies, and completion. */
export function respondRoutes(scenario: RespondScenario, tracker: RespondTracker): Route[] {
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
          labels: [],
          state: "open",
          user: { login: "reporter", type: "User" },
        });
        return true;
      }

      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null) {
        const replies = thread.replied === undefined ? [] : [{ id: 1, body: thread.replied }];
        send(response, 200, replies);
        return true;
      }

      if (
        method === "POST" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null
      ) {
        tracker.effect.commented = true;
        send(response, 201, { id: 2 });
        return true;
      }

      void scenario;
      return false;
    },
  ];
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
export async function scenarioOf(name: string, directory: string): Promise<RespondScenario> {
  const fixture = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as RespondFixture;
  const assertions = fixture.expected ?? {};
  const base =
    fixture.thread === undefined
      ? DEFAULT_RESPOND_THREAD
      : { ...DEFAULT_RESPOND_THREAD, ...fixture.thread };
  return {
    name,
    thread: {
      ...base,
      ...(fixture["already-answered"] === true ? { replied: "I use light mode." } : {}),
    },
    warrant: fixture.warrant ?? null,
    screen:
      fixture["screen-models"] === true &&
      (assertions["stopped-for"] === "spam" || assertions["stopped-for"] === "off-topic")
        ? assertions["stopped-for"]
        : "keep",
    detect: "en",
    reply: replyOf(fixture["draft-over"] ?? {}),
    alreadyAnswered: fixture["already-answered"] === true,
    ...(fixture["screen-models"] === true ? { inputs: { "screen-models": "stub-screen" } } : {}),
    expected: assertions,
  };
}

/** A fresh tracker for one fixture run. */
export function newTracker(): RespondTracker {
  return { effect: { commented: false } };
}
