/**
 * The duplicate driver: what one fixture means, and what a run over it must
 * show.
 *
 * Duplicate posts its proposal as a comment through the tracker API, so the
 * effect is recorded by the stub routes exactly like triage's and respond's:
 * `newTracker()` hands the runner a mutable record, the routes write into it
 * as the run calls the API, and the runner compares the record against the
 * fixture's expected effects.
 *
 * The fixture's `.expected.json` reads:
 *
 * - `corpus`                — the open threads served by the corpus listing,
 *   beside the thread being checked. At least one must share enough vocabulary
 *   with the fixture thread for BM25 to surface it.
 * - `warrant`               — the warrant text to run under; absent uses the
 *   implicit one (which grants duplicate nothing).
 * - `verdict-over`          — fields to override in the default verdict JSON.
 * - `expected.duplicate-of` — the thread number the run must report, or "".
 * - `expected.score`        — the confidence the run must report (the verdict
 *   passes through, so a quoted-two decimal `"0.90"`).
 * - `expected.effects.commented` — true when the run posted its proposal.
 *
 * A run that never names a duplicate — warrant-denied, no matching candidate —
 * is a finding when the fixture declares it: the run reached the answer the
 * fixture expects and wrote nothing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Answer, Route } from "../harness.ts";
import { saying } from "../harness.ts";

/** One open thread the corpus offers the run. */
export interface CorpusThread {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/** The one thread the run is asked to classify as a duplicate. */
export interface DuplicateThread {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface DuplicateEffect {
  commented: boolean;
}

/** What the run did to the thread, as the stub routes saw it. */
export interface DuplicateTracker {
  readonly effect: DuplicateEffect;
}

export interface DuplicateScenario {
  readonly name: string;
  readonly thread: DuplicateThread;
  /** The open threads the corpus serves, newest created first. */
  readonly corpus: readonly CorpusThread[];
  /** The warrant to run under, or null for the implicit one. */
  readonly warrant: string | null;
  /** The verdict JSON the judge answers with. */
  readonly verdict: string;
  /** The language-detection answer, when detection reaches a model. */
  readonly detect: string;
  /** The assertions this fixture declares. */
  readonly expected: DuplicateAssertions;
}

/** The fixture's `.expected.json`: configuration at the top. */
export interface DuplicateFixture {
  readonly description?: string;
  readonly warrant?: string;
  /** The thread to serve, when a fixture is not the default one. */
  readonly thread?: Pick<DuplicateThread, "title" | "body">;
  /** The open threads the corpus serves, newest created first. */
  readonly corpus?: readonly Pick<CorpusThread, "number" | "title" | "body">[];
  /** Fields to override in the default verdict JSON. */
  readonly "verdict-over"?: Record<string, unknown>;
  /** The language detection must answer when it reaches a model. */
  readonly detect?: string;
  readonly expected?: DuplicateAssertions;
}

/** The assertions one duplicate fixture declares — compared against the run. */
export interface DuplicateAssertions {
  /** The thread number the run reports under `duplicate-of`, or "" for none. */
  readonly "duplicate-of"?: string;
  /** The confidence the run reports under `score` (the verdict's own). */
  readonly score?: string;
  readonly effects?: Pick<DuplicateEffect, "commented">;
}

const THREAD_TITLE = "Dark mode resets on reload";
const THREAD_BODY =
  "The dark mode toggle does not persist after a page reload, and it should. " +
  "I checked the settings and it resets every time I open the page.";

/** The thread every fixture runs on, unless its `.expected.json` says otherwise. */
export const DEFAULT_DUPLICATE_THREAD: DuplicateThread = {
  number: 42,
  title: THREAD_TITLE,
  body: THREAD_BODY,
};

/**
 * The corpus fixture shares nearly all of the thread's vocabulary, so BM25
 * ranks it first and the judge is asked about it. Served newest first, with
 * the thread's own number absent — the corpus listing would drop it.
 */
const DEFAULT_CORPUS: readonly CorpusThread[] = [
  {
    number: 7,
    title: "Dark mode always resets on page reload",
    body:
      "After a page reload the dark mode setting does not persist. " +
      "It resets each time I open the page, even though I saved it.",
  },
];

/** A verdict, in the shape the prompt asks for. */
export function verdictOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    duplicate_of: 7,
    confidence: 0.9,
    rationale: "Reports the same reset-on-reload behaviour against the same page.",
    ...over,
  });
}

/** The answer each stage scripts, from the prompt marker it saw. */
export function scriptDuplicate(
  scenario: DuplicateScenario,
): (ask: { readonly model: string; readonly system: string; readonly user: string }) => Answer {
  return (ask) => {
    if (ask.system.includes("You are checking whether a new GitHub issue repeats")) {
      return saying(scenario.verdict);
    }
    if (ask.system.includes("You identify which language")) {
      return saying(scenario.detect);
    }
    return saying("unknown stage");
  };
}

/** The routes one duplicate run needs: the thread, the corpus, and completion. */
export function duplicateRoutes(scenario: DuplicateScenario, tracker: DuplicateTracker): Route[] {
  const thread = scenario.thread;
  const corpus = scenario.corpus;
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

      // The corpus listing: every open issue, newest created first. Serves
      // the fixture's corpus with the thread's own number dropped, the same
      // way `listCorpus`'s `exclude` drops it. The listing is
      // `/repos/{owner}/{repo}/issues` (with query params); the issue route
      // above already owns `/issues/{number}`.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues$/.exec(url) !== null) {
        const rows = corpus
          .filter((entry) => entry.number !== thread.number)
          .map((entry) => ({
            number: entry.number,
            title: entry.title,
            body: entry.body,
            state: "open",
            user: { login: "reporter", type: "User" },
            created_at: "2026-08-01T00:00:00Z",
          }));
        send(response, 200, rows);
        return true;
      }

      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null) {
        send(response, 200, []);
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
export async function scenarioOf(name: string, directory: string): Promise<DuplicateScenario> {
  const fixture = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as DuplicateFixture;
  const assertions = fixture.expected ?? {};
  const base =
    fixture.thread === undefined
      ? DEFAULT_DUPLICATE_THREAD
      : { ...DEFAULT_DUPLICATE_THREAD, ...fixture.thread };
  return {
    name,
    thread: base,
    corpus: fixture.corpus ?? DEFAULT_CORPUS,
    warrant: fixture.warrant ?? null,
    verdict: verdictOf(fixture["verdict-over"] ?? {}),
    detect: fixture.detect ?? "en",
    expected: assertions,
  };
}

/** A fresh tracker for one fixture run. */
export function newTracker(): DuplicateTracker {
  return { effect: { commented: false } };
}
