/**
 * The remediation driver: what one fixture means, and what a run over it must
 * show.
 *
 * Remediation makes exactly one GitHub read — the pull request's comments,
 * carrying review's own marker envelope — and nothing else. It never writes:
 * there is no comment route, no contents route, no pulls-create route on the
 * stub, so any mutation the run attempted would 404 loudly and fail it. The
 * no-create proof is structural, the same way `ProposalsApi` proves triage's
 * propose can never merge.
 *
 * A run derives one proposal per actionable finding and reports it on the
 * outputs and the job summary. The fixture scripts the envelope itself — the
 * driver encodes it with review's *real* `encodeEnvelope` (eval tooling may
 * import review; the shipped remediation bundle never does), so the fixture
 * reads as a genuine review comment and the strict decode has real bytes to
 * accept.
 *
 * The fixture's `.expected.json` reads:
 *
 * - `warrant`      — the warrant text to run under.
 * - `pr`           — the pull request's title and body.
 * - `findings`     — the actionable findings review's envelope carries.
 * - `expected`     — the outputs the run must report: `proposed` and the
 *   `proposals` count.
 *
 * The one trailing expectation is `never`: the stub routes expose no write,
 * so a run that attempted one would have failed on a 404 — and the tracker's
 * `written` flag stays false, which the runner asserts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Eval tooling — not shipped remediation code — builds the envelope the way
// review's own encoder does (`Buffer` + JSON). It cannot import review's
// shipped modules, whose `.js` relative imports the eval runner does not
// resolve; `marker.ts` is self-contained, so the marker grammar stays the
// real one. The envelope half is re-implemented here in three lines, exactly
// the byte-for-byte transcription `encodeEnvelope` produces.
import { fingerprint, markerFor } from "../../src/core/marker.ts";
import type { Previous } from "../../src/duties/review/findings.ts";

import type { Route } from "../harness.ts";

/** `review`'s own `encodeEnvelope`: base64 of the JSON record. */
function encodeEnvelope(previous: Previous): string {
  return Buffer.from(JSON.stringify(previous), "utf8").toString("base64");
}

/** One actionable finding, in review's own payload shape. */
export interface RemediationFinding {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly ruleBody: string;
  readonly path: string;
  readonly line: number | null;
  readonly severity: "info" | "warning" | "critical";
  readonly body: string;
  readonly marker: string;
  readonly wasResolved: boolean;
}

/** The pull request the run reads comments from. */
export interface RemediationPr {
  readonly title: string;
  readonly body: string;
}

/** What a remediation run did to the pull request — deliberately nothing. */
export interface RemediationEffect {
  readonly written: boolean;
}

export interface RemediationSample {
  readonly name: string;
  readonly warrant: string;
  readonly pr: RemediationPr;
  readonly findings: readonly RemediationFinding[];
  /** The review marker payload's render-fingerprint half — real, but meaningless to this duty. */
  readonly renderFingerprint: string;
  readonly expected: RemediationAssertions;
}

/** A fixture: configuration plus the expected outputs. */
export interface RemediationFixture {
  readonly description?: string;
  readonly warrant: string;
  readonly pr?: RemediationPr;
  readonly findings: readonly RemediationFinding[];
  readonly expected?: RemediationAssertions;
}

/** The assertions one remediation fixture declares. */
export interface RemediationAssertions {
  readonly proposed?: string;
  readonly proposals?: string;
}

/** The review marker, whose payload this duty reads. */
const REVIEW_MARKER = markerFor("review");

/**
 * Builds the comment body a review run would have posted: the marker with a
 * render fingerprint that matches nothing, and the base64 envelope review's
 * own encoder writes.
 */
export function reviewCommentBody(
  findings: readonly RemediationFinding[],
  renderFingerprint: string,
): string {
  const previous: Previous = {
    findings: findings.map((finding) => ({ ...finding })),
    reviewedShas: [],
  };
  const payload = `${renderFingerprint} ${encodeEnvelope(previous)}`;
  return [REVIEW_MARKER.render(payload), "The review body."].join("\n\n");
}

/** The routes one remediation run needs: only reads, never a write. */
export function remediationRoutes(sample: RemediationSample, tracker: RemediationEffect): Route[] {
  const pr = sample.pr;
  const commentBody = reviewCommentBody(sample.findings, sample.renderFingerprint);
  return [
    (_raw, request, response) => {
      const method = request.method ?? "?";
      const url = (request.url ?? "/").split("?")[0] ?? "/";

      // The pull request being worked. Open, not a draft, not merged.
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

      // The comment trio — but only the read half. Remediation reads review's
      // owned comment; it has no comment-create or update route to reach.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url) !== null) {
        send(response, 200, [
          {
            id: 1,
            body: commentBody,
            user: { login: "reeve[bot]", type: "Bot" },
          },
        ]);
        return true;
      }

      void tracker;
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

/** Reads the fixture's `.expected.json` into a runnable sample. */
export async function scenarioOf(name: string, directory: string): Promise<RemediationSample> {
  const fixture = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as RemediationFixture;
  return {
    name,
    warrant: fixture.warrant,
    pr: fixture.pr ?? {
      title: "Fix the crash",
      body: "This pull request fixes the crash on save.",
    },
    findings: fixture.findings,
    renderFingerprint: fingerprint("remediation-fixture", ["review"]).slice(0, 16),
    expected: fixture.expected ?? {},
  };
}

/** A fresh tracker for one fixture run. */
export function newTracker(): RemediationEffect {
  return { written: false };
}
