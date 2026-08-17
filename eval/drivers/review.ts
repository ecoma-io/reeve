/**
 * The review driver: what one fixture means, and what a run over it must
 * show.
 *
 * Review is the one duty whose whole surface the stub can stand in for —
 * every read (the pull request, its file list, its comments) and every write
 * (the one review comment) goes through the GitHub API, so nothing is
 * hardcoded out of reach the way dependa's datasources are. Two stages reach
 * a model (detect and review), and English pull request titles resolve by
 * profile without one, so the review fixture scripts only the review answer
 * and the detect answer it is never asked.
 *
 * A run posts exactly one comment under the review marker. The three
 * fixtures trace the three stops:
 *
 * - `open-pr` — the rules file's `blocked:` list fires on the diff before
 *   any model is asked (the preflight), the model adds its own finding, and
 *   the run posts both. `debugger;` lands on a line the patch proves, so the
 *   model's claim is admitted.
 * - `clean-pr` — the diff is shown, the model answers a readable empty
 *   verdict, and the empty chrome is posted: "No issues to report" is a real
 *   answer about a diff that was actually reviewed.
 * - `denied` — the warrant's `duties:` block never names review; the run is
 *   refused before the pull request is read, and nothing is posted.
 * - `id-pr` — the pull request is Indonesian, so detection reaches the model
 *   (Latin script, no bundled profile) and must answer `id`; the assertion
 *   reads the summary's `| Language | id |` row. A misidentifying answer
 *   breaks this fixture as `failed`, never a clean stop.
 * - `update-pr` — the stub serves a previous review comment under this duty's
 *   own marker; the run reconciles the moved finding and replaces the comment
 *   in place, exercising the PATCH path instead of a second POST.
 *
 * The fixture's `.expected.json` reads:
 *
 * - `warrant`      — the warrant text to run under.
 * - `pr`           — the pull request's title and body.
 * - `files`        — the pull request's file list, exactly as the API sends
 *   each entry (`filename`, `status`, `additions`, `deletions`, `patch`).
 * - `rules`        — the repository rules file, written into the scratch
 *   checkout the run reads it from.
 * - `verdict`      — the review-stage model answer, the JSON the prompt asks
 *   for. The driver wraps an object, so the fixture writes fields, not text.
 * - `expected`     — the outputs the run must report: `commented` and the
 *   `findings` count.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Answer, Route } from "../harness.ts";
import { saying } from "../harness.ts";

/** One file the pull request touches, as the stub serves it. */
export interface ReviewFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

/** The pull request the run is asked to review. */
export interface ReviewPr {
  readonly title: string;
  readonly body: string;
}

export interface ReviewEffect {
  commented: boolean;
  /**
   * Which write the run used for its one comment — `post` when no previous
   * marker existed, `patch` when it replaced one in place. `null` when the run
   * wrote nothing. Lets a fixture pin that a rerun exercised the update path
   * and not a second post.
   */
  wrote: "post" | "patch" | null;
}

/** What the run did to the pull request, as the stub routes saw it. */
export interface ReviewTracker {
  readonly effect: ReviewEffect;
}

export interface ReviewScenario {
  readonly name: string;
  /** The warrant to run under. */
  readonly warrant: string;
  readonly pr: ReviewPr;
  /** The pull request's file list. */
  readonly files: readonly ReviewFile[];
  /** The rules file the run reads from the checkout. */
  readonly rules: string | null;
  /** The review-stage model answer. */
  readonly verdict: string;
  /** The language-detection answer, when detection reaches a model. */
  readonly detect: string;
  /** A review comment a previous run left, or null on the first review. */
  readonly previous: { readonly body: string } | null;
  /** The assertions this fixture declares. */
  readonly expected: ReviewAssertions;
}

/** The fixture's `.expected.json`: configuration at the top. */
export interface ReviewFixture {
  readonly description?: string;
  readonly warrant: string;
  readonly pr?: Pick<ReviewPr, "title" | "body">;
  readonly files: readonly ReviewFile[];
  /** The rules file to write into the checkout, or absent for the default rules. */
  readonly rules?: string;
  /** Fields the review-stage verdict JSON spreads over an empty verdict. */
  readonly "verdict-over"?: Record<string, unknown>;
  /** The language detection must answer when it reaches a model. */
  readonly detect?: string;
  /**
   * A review comment a previous run left — present forces the update-in-place
   * path (the PATCH, not a second POST). The body must carry this duty's own
   * marker (`<!-- reeve:review source=… -->`) written by a bot author, exactly
   * as a real run leaves it.
   */
  readonly previous?: {
    readonly body: string;
  };
  readonly expected?: ReviewAssertions;
}

/** The assertions one review fixture declares — compared against the run. */
export interface ReviewAssertions {
  readonly commented?: string;
  readonly findings?: string;
  readonly "head-sha"?: string;
  /**
   * The language code the run must have identified the pull request as, when
   * detection reaches the model. Review carries no `language` output — the
   * summary's `### Verdict` table renders the row `| Language | <code> |` —
   * so this assertion reads that row (see `reviewLine` in the runner).
   */
  readonly language?: string;
  /**
   * The write the run must have used for its one comment: `post` on a first
   * review, `patch` when it replaced its own previous comment in place. A
   * fixture that declares it pins which half of the comment trio ran.
   */
  readonly wrote?: "post" | "patch";
}

/** A verdict, in the shape the review prompt asks for. */
export function verdictOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ findings: [], confidence: 0.9, ...over });
}

/** The answer each stage scripts, from the prompt marker it saw. */
export function scriptReview(
  scenario: ReviewScenario,
): (ask: { readonly model: string; readonly system: string; readonly user: string }) => Answer {
  return (ask) => {
    if (ask.system.includes("You are reviewing a pull request on a GitHub repository.")) {
      return saying(scenario.verdict);
    }
    if (ask.system.includes("You identify which language")) {
      return saying(scenario.detect);
    }
    return saying("en");
  };
}

/** The routes one review run needs: the pull request, its files, the comment trio, and completion. */
export function reviewRoutes(scenario: ReviewScenario, tracker: ReviewTracker): Route[] {
  const pr = scenario.pr;
  return [
    (raw, request, response) => {
      const method = request.method ?? "?";
      const url = (request.url ?? "/").split("?")[0] ?? "/";

      // The pull request being reviewed. Never a draft or a merge, so the run
      // walks past both clean stops to the review itself.
      const pull = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(url);
      if (method === "GET" && pull !== null) {
        send(response, 200, {
          number: 42,
          title: pr.title,
          body: pr.body,
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "abc123" },
          base: { sha: "base1" },
          user: { login: "author", type: "User" },
          labels: [],
        });
        return true;
      }

      // The file list — one short page, which stops the listing walk.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.exec(url) !== null) {
        send(
          response,
          200,
          scenario.files.map((file) => ({ ...file })),
        );
        return true;
      }

      // The comment trio: list (the previous-run memory search reads it),
      // create (the run posts its review), update (a rerun replaces in place).
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null) {
        const existing =
          scenario.previous === null
            ? []
            : [
                {
                  id: 7,
                  body: scenario.previous.body,
                  user: { login: "reeve[bot]", type: "Bot" },
                },
              ];
        send(response, 200, existing);
        return true;
      }
      if (
        method === "POST" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null
      ) {
        tracker.effect.commented = true;
        tracker.effect.wrote = "post";
        send(response, 201, { id: 1 });
        return true;
      }
      if (
        method === "PATCH" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.exec(url) !== null
      ) {
        tracker.effect.commented = true;
        tracker.effect.wrote = "patch";
        send(response, 200, { id: 7 });
        return true;
      }

      void raw;
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
export async function scenarioOf(name: string, directory: string): Promise<ReviewScenario> {
  const fixture = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as ReviewFixture;
  return {
    name,
    warrant: fixture.warrant,
    pr: fixture.pr ?? {
      title: "Fix the crash",
      body: "This pull request fixes the crash on save. I have tested it locally and it resolves the issue.",
    },
    files: fixture.files,
    rules: fixture.rules ?? null,
    verdict: verdictOf(fixture["verdict-over"] ?? {}),
    detect: fixture.detect ?? "en",
    previous: fixture.previous ?? null,
    expected: fixture.expected ?? {},
  };
}

/** A fresh tracker for one fixture run. */
export function newTracker(): ReviewTracker {
  return { effect: { commented: false, wrote: null } };
}
