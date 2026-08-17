/**
 * The translate driver: what one fixture means, and what a run over it must
 * show.
 *
 * Translate's effect is a body edit — the thread's body is re-read and
 * PATCHed through the tracker API, so the effect is recorded by the stub
 * routes exactly like triage's and respond's: `newTracker()` hands the runner
 * a mutable record, the routes write into it as the run calls the API, and
 * the runner compares the record against the fixture's expected effects.
 *
 * The fixture's `.expected.json` reads:
 *
 * - `languages`             — the `languages:` the warrant declares, which is
 *   what the run translates into (absent languages fall back to the duty's
 *   own `en, vi, zh` default).
 * - `draft-text`            — the translation the model answers with, replacing
 *   the driver's default Vietnamese draft; the run must accept it (score it
 *   admissible) and publish it.
 * - `already-translated`    — true when the thread's body already carries this
 *   duty's marker for this exact text and language set; the run must stop at
 *   the fingerprint check without a draft or a write.
 * - `warrant`               — the warrant text to run under; absent uses the
 *   implicit one (which grants translate nothing).
 * - `expected.translated`   — the language codes the run must report as
 *   translated, in configured order.
 * - `expected.source-language` — the code the run must report as the thread's
 *   own language.
 * - `expected.effects.edited`  — true when the run wrote the body; a fixture
 *   omitting `effects` asserts a clean stop that wrote nothing.
 *
 * A clean stop — already translated, or a warrant that never granted
 * `edit-body` — is a finding, not a skipped run: the fixture declares the
 * stop as the expected outcome and the runner asserts it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Answer, Route } from "../harness.ts";
import { saying } from "../harness.ts";

/** The one thread the stub serves. */
export interface TranslateThread {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface TranslateEffect {
  edited: boolean;
}

/** What the run did to the thread, as the stub routes saw it. */
export interface TranslateTracker {
  readonly effect: TranslateEffect;
}

export interface TranslateScenario {
  readonly name: string;
  readonly thread: TranslateThread;
  /** The warrant to run under, or null for the implicit one. */
  readonly warrant: string | null;
  /** The draft answer for the translation stage. */
  readonly draft: string;
  /** True when the thread already carries this run's marker. */
  readonly alreadyTranslated: boolean;
  /** Inputs that differ from the driver defaults. */
  readonly inputs?: Record<string, string>;
  /** The assertions this fixture declares. */
  readonly expected: TranslateAssertions;
}

/** The fixture's `.expected.json`: configuration at the top. */
export interface TranslateFixture {
  readonly description?: string;
  readonly warrant?: string;
  /** The thread to serve, when a fixture is not the default one. */
  readonly thread?: Pick<TranslateThread, "title" | "body">;
  /** The translation the model answers with, replacing the default draft. */
  readonly "draft-text"?: string;
  /** True when the thread already carries this run's marker. */
  readonly "already-translated"?: boolean;
  readonly expected?: TranslateAssertions;
}

/** The assertions one translate fixture declares — compared against the run. */
export interface TranslateAssertions {
  /** The language codes the run must report under `translated`. */
  readonly translated?: readonly string[];
  /** The code the run must report as the thread's own language. */
  readonly "source-language"?: string;
  readonly effects?: Pick<TranslateEffect, "edited">;
}

const REPORT =
  "The dark mode toggle does not persist after a page reload, and it should. " +
  "I checked the settings and it resets every time I open the page.";

/** The thread every fixture runs on, unless its `.expected.json` says otherwise. */
export const DEFAULT_TRANSLATE_THREAD: TranslateThread = {
  number: 42,
  title: "Dark mode resets on reload",
  body: REPORT,
};

/** A draft, in the shape the prompt asks for — a plain translation, not JSON. */
export function draftOf(over: Record<string, unknown> = {}): string {
  const text =
    "Chế độ tối không được lưu sau khi tải lại trang, và điều đó là không " +
    "đúng. Tôi đã kiểm tra cài đặt và nó được đặt lại mỗi lần tôi mở trang.";
  return typeof over.text === "string" ? over.text : text;
}

/** The answer each stage scripts, from the prompt marker it saw. */
export function scriptTranslate(
  scenario: TranslateScenario,
): (ask: { readonly model: string; readonly system: string; readonly user: string }) => Answer {
  return (ask) => {
    if (ask.system.includes("You translate GitHub issue and pull request content")) {
      return saying(scenario.draft);
    }
    if (ask.system.includes("You identify which language")) {
      return saying("en");
    }
    return saying("unknown stage");
  };
}

/** The routes one translate run needs: the thread, its edits, and completion. */
export function translateRoutes(scenario: TranslateScenario, tracker: TranslateTracker): Route[] {
  const thread = scenario.thread;
  // The stub serves a mutable body: the run re-reads after its own write, and
  // the second read must see what the write produced for the publish to be
  // verified. Starts at the fixture's body; a PATCH overwrites it.
  let body = thread.body;
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
          body,
          labels: [],
          state: "open",
          user: { login: "reporter", type: "User" },
        });
        return true;
      }

      if (method === "PATCH" && issue !== null) {
        const payload = parsed(raw) as { body?: string };
        if (payload.body !== undefined) body = payload.body;
        tracker.effect.edited = true;
        send(response, 200, { number: thread.number, body });
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
export async function scenarioOf(name: string, directory: string): Promise<TranslateScenario> {
  const fixture = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as TranslateFixture;
  const assertions = fixture.expected ?? {};
  const base =
    fixture.thread === undefined
      ? DEFAULT_TRANSLATE_THREAD
      : { ...DEFAULT_TRANSLATE_THREAD, ...fixture.thread };
  return {
    name,
    thread: base,
    warrant: fixture.warrant ?? null,
    draft: draftOf(fixture["draft-text"] === undefined ? {} : { text: fixture["draft-text"] }),
    alreadyTranslated: fixture["already-translated"] === true,
    expected: assertions,
  };
}

/** A fresh tracker for one fixture run. */
export function newTracker(): TranslateTracker {
  return { effect: { edited: false } };
}
