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
  /** How many inline review threads the run posted (the `pulls/{n}/comments` POSTs). */
  threads: number;
  /** How many owned inline threads the run updated (the `pulls/comments/{id}` PATCHes). */
  threadUpdates: number;
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
  /** Pack files to write into the checkout, keyed by `namespace/name.yml`. */
  readonly packs: Record<string, string>;
  /**
   * Checkout files planted into the workspace the run reads from — the
   * repository context engine's own source. The base branch is pinned and
   * trusted, so a fixture that exercises the engine writes these into the
   * scratch checkout itself.
   */
  readonly workspace: Record<string, string>;
  /** The risk profile the run reads from the checkout, or null for the default. */
  readonly risk: string | null;
  /** The review-stage model answer. */
  readonly verdict: string;
  /** The review-stage model answers per pass, in pass order — overrides `verdict` when present. */
  readonly passes: readonly string[];
  /** The language-detection answer, when detection reaches a model. */
  readonly detect: string;
  /** A review comment a previous run left, or null on the first review. */
  readonly previous: { readonly body: string } | null;
  /**
   * Inline review threads a previous run left, as the `pulls/{n}/comments`
   * listing serves them — the thread sync's own memory, the same way the
   * `previous` comment is the summary's. An empty list is the default.
   */
  readonly threads: readonly {
    readonly id: number;
    readonly body: string;
    readonly path: string;
    readonly line: number;
    readonly user: { readonly login: string; readonly type: string };
  }[];
  /**
   * Human replies on the thread, served after the owned comment. A reply
   * carries its `author_association` so the run's disposition reader can
   * attribute it — the thread is the durable home for a disposition.
   */
  readonly replies: readonly ReviewThreadReply[];
  /** The assertions this fixture declares. */
  readonly expected: ReviewAssertions;
}

/** One human reply the stub serves on the thread. */
export interface ReviewThreadReply {
  readonly id: number;
  readonly login: string;
  readonly type?: "User" | "Bot";
  readonly association?: string;
  readonly createdAt?: string;
  readonly body: string;
}

/** The fixture's `.expected.json`: configuration at the top. */
export interface ReviewFixture {
  readonly description?: string;
  readonly warrant: string;
  readonly pr?: Pick<ReviewPr, "title" | "body">;
  readonly files: readonly ReviewFile[];
  /** The rules file to write into the checkout, or absent for the default rules. */
  readonly rules?: string;
  /** Pack files to write into the checkout, keyed by `namespace/name.yml`. */
  readonly packs?: Record<string, string>;
  /**
   * Checkout files planted beside the rules file — the repository context
   * engine reads from `GITHUB_WORKSPACE`, so a fixture that exercises it
   * ships its own base-branch source here. Absent for fixtures that do not.
   */
  readonly workspace?: Record<string, string>;
  /** The risk profile to write into the checkout, or absent for the default profile. */
  readonly risk?: string;
  /** Fields the review-stage verdict JSON spreads over an empty verdict. */
  readonly "verdict-over"?: Record<string, unknown>;
  /** One review-stage answer per pass, in pass order — replaces `verdict-over`. */
  readonly "review-passes"?: readonly Record<string, unknown>[];
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
  /** Human replies on the thread after the owned comment — the disposition path. */
  readonly replies?: readonly ReviewThreadReply[];
  /** Inline review threads a previous run left, as the listing would serve them. */
  readonly threads?: ReviewScenario["threads"];
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
  /**
   * How many findings the run verified, read off the summary's
   * `| Verification | N verified · M not verified |` row. Pins that the
   * evidence engine ran and its verdict, not just the finding count.
   */
  readonly verified?: string;
  /**
   * A substring the review-stage prompt must carry, proving the repository
   * context engine surfaced workspace evidence the diff never showed. Pins
   * the engine independently of the finding ladder — a fixture with a path
   * or symbol only the workspace holds cannot pass on the deterministic
   * finding alone.
   */
  readonly "workspace-evidence"?: string;
  /**
   * A disposition the summary's `### Findings` table must show for the run's
   * findings — `wont-fix by @octocat`. Pins the human-disposition axis: the
   * run read a maintainer's eligible reply off the thread and rendered it
   * beside the finding.
   */
  readonly disposition?: string;
  /**
   * How many inline review threads the run must have posted, read off the
   * tracker's `pulls/{n}/comments` POST count. Undefined means the fixture
   * does not pin the thread surface.
   */
  readonly threads?: string;
  /** The risk tier the run must have assessed this diff as. */
  readonly risk?: string;
}

/** A verdict, in the shape the review prompt asks for. */
export function verdictOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ findings: [], confidence: 0.9, ...over });
}

/** The answer each stage scripts, from the prompt marker it saw. */
export function scriptReview(
  scenario: ReviewScenario,
): (ask: { readonly model: string; readonly system: string; readonly user: string }) => Answer {
  let reviewAsks = 0;
  return (ask) => {
    if (
      ask.system.includes("You are the adversarial verification pass") ||
      ask.system.includes("This is an independent second opinion") ||
      ask.system.includes("You are reviewing a pull request on a GitHub repository.")
    ) {
      const i = reviewAsks;
      reviewAsks += 1;
      if (scenario.passes.length > 0) return saying(scenario.passes[i] ?? verdictOf());
      return saying(i === 0 ? scenario.verdict : verdictOf());
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

      // The inline-thread trio: list (the thread sync reads it), create, update.
      // A run's thread sync lists every pull request's review comments; the
      // default fixture starts with none, and the `inline-threads` fixture
      // plants its owned thread here.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/.exec(url) !== null) {
        send(response, 200, scenario.threads);
        return true;
      }
      if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/.exec(url) !== null) {
        tracker.effect.threads = tracker.effect.threads + 1;
        send(response, 201, { id: 99 });
        return true;
      }
      if (
        method === "PATCH" &&
        /^\/repos\/[^/]+\/[^/]+\/pulls\/comments\/\d+$/.exec(url) !== null
      ) {
        tracker.effect.threadUpdates = tracker.effect.threadUpdates + 1;
        send(response, 200, { id: 7 });
        return true;
      }

      // The comment trio: list (the previous-run memory search reads it),
      // create (the run posts its review), update (a rerun replaces in place).
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null) {
        const owned =
          scenario.previous === null
            ? []
            : [
                {
                  id: 7,
                  body: scenario.previous.body,
                  user: { login: "reeve[bot]", type: "Bot" },
                  author_association: "NONE",
                  created_at: "2026-08-17T00:00:00Z",
                },
              ];
        const human = scenario.replies.map((reply) => ({
          id: reply.id,
          body: reply.body,
          user: { login: reply.login, type: reply.type ?? "User" },
          author_association: reply.association ?? "COLLABORATOR",
          created_at: reply.createdAt ?? "2026-08-17T01:00:00Z",
        }));
        send(response, 200, [...owned, ...human]);
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
    packs: fixture.packs ?? {},
    workspace: fixture.workspace ?? {},
    risk: fixture.risk ?? null,
    verdict: verdictOf(fixture["verdict-over"] ?? {}),
    passes: (fixture["review-passes"] ?? []).map((over) => verdictOf(over)),
    detect: fixture.detect ?? "en",
    previous: fixture.previous ?? null,
    threads: fixture.threads ?? [],
    replies: fixture.replies ?? [],
    expected: fixture.expected ?? {},
  };
}

/** A fresh tracker for one fixture run. */
export function newTracker(): ReviewTracker {
  return { effect: { commented: false, wrote: null, threads: 0, threadUpdates: 0 } };
}
