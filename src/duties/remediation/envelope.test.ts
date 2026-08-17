/**
 * The envelope codec, pinned against `review`'s own encoder.
 *
 * Remediation's shipped code never imports `review` — the shape is
 * re-declared in `envelope.ts` for the same structural-directionality reason
 * the duty is a separate directory at all. This test is the seam that keeps
 * the re-declared shape honest: it encodes with `review`'s *real*
 * `encodeEnvelope` (test tooling may import it; the shipped bundle never
 * touches review), and asserts remediation's decode reads exactly what review
 * wrote.
 */
import { describe, expect, it } from "vitest";

// Test-only import of review's shipped encoder — the unit that pins drift.
// Remediation's shipped code does not, and must not, import this module.
import { encodeEnvelope as reviewEncodeEnvelope } from "../review/publish.js";
import type { Previous } from "../review/findings.js";

import { decodeEnvelope } from "./envelope.js";

/** A previous record in review's own shape, with the strict field set. */
function previous(over: Partial<Previous["findings"][number]> = {}): Previous {
  return {
    findings: [
      {
        id: "blocked:src/app.ts:13",
        ruleId: "blocked",
        ruleName: "No debugger",
        ruleBody: "Debugger statements must not land.",
        path: "src/app.ts",
        line: 13,
        severity: "warning",
        body: "debugger; statement on line 13.",
        marker: "",
        wasResolved: false,
        ...over,
      },
    ],
    reviewedShas: [],
  };
}

/** A full marker payload: `<fingerprint> <reviewEnvelope>`. */
function payloadOf(reviewed: Previous): string {
  const fingerprint = "a".repeat(16);
  return `${fingerprint} ${reviewEncodeEnvelope(reviewed)}`;
}

describe("decodeEnvelope", () => {
  it("round-trips a payload review's own encoder wrote", () => {
    const envelope = decodeEnvelope(payloadOf(previous()));
    expect(envelope).not.toBeNull();
    expect(envelope?.findings).toHaveLength(1);
    expect(envelope?.previous).toHaveLength(1);
    const standing = envelope?.findings[0];
    expect(standing).toMatchObject({
      id: "blocked:src/app.ts:13",
      ruleId: "blocked",
      path: "src/app.ts",
      line: 13,
      body: "debugger; statement on line 13.",
    });
  });

  it("splits the standing findings from the resolved memory", () => {
    const reviewed = previous({
      id: "b:src/a.ts:1",
      ruleId: "b",
      path: "src/a.ts",
      line: 1,
      wasResolved: true,
    });
    const envelope = decodeEnvelope(payloadOf(reviewed));
    // Resolved findings are memory, not this run's actionable input.
    expect(envelope?.findings).toHaveLength(0);
    expect(envelope?.previous).toHaveLength(1);
    expect(envelope?.previous[0]?.wasResolved).toBe(true);
  });

  it("returns null for a payload with no envelope half", () => {
    expect(decodeEnvelope("a".repeat(16))).toBeNull();
    expect(decodeEnvelope(null)).toBeNull();
    expect(decodeEnvelope("")).toBeNull();
  });

  it("returns null for tampered base64", () => {
    const reviewed = previous();
    const encoded = reviewEncodeEnvelope(reviewed);
    const tampered = `${encoded.slice(0, 4)}XXXX${encoded.slice(8)}`;
    expect(decodeEnvelope(`a`.repeat(16) + " " + tampered)).toBeNull();
  });

  it("returns null when the decoded payload is not a Previous-shaped object", () => {
    // Not JSON at all.
    expect(
      decodeEnvelope(`${"a".repeat(16)} ${Buffer.from("not json{", "utf8").toString("base64")}`),
    ).toBeNull();
    // JSON that is the wrong shape — a missing findings array.
    const wrong = Buffer.from(JSON.stringify({ findings: "nope" }), "utf8").toString("base64");
    expect(decodeEnvelope(`${"a".repeat(16)} ${wrong}`)).toBeNull();
    // A finding missing the wasResolved boolean review always writes is
    // filtered out the way review's own decoder filters it — the survivor
    // is an empty standing set, never a memory claim.
    const incomplete = Buffer.from(
      JSON.stringify({
        findings: [
          {
            id: "x",
            ruleId: "x",
            ruleName: "",
            ruleBody: "",
            path: "p",
            line: 1,
            severity: "info",
            body: "b",
            marker: "",
          },
        ],
        reviewedShas: [],
      }),
      "utf8",
    ).toString("base64");
    const envelope = decodeEnvelope(`${"a".repeat(16)} ${incomplete}`);
    expect(envelope).not.toBeNull();
    expect(envelope?.findings).toHaveLength(0);
    expect(envelope?.previous).toHaveLength(0);
  });
});

describe("the review marker read", () => {
  it("names the review marker remediation reads envelopes from", async () => {
    const { reviewMarker } = await import("./envelope.js");
    expect(reviewMarker.render(`${"a".repeat(16)} x`)).toContain("<!-- reeve:review source=");
  });
});
