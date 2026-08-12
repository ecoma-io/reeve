import { describe, expect, it } from "vitest";

import type { Candidate, Ranked } from "./rank.js";
import { matchShortlist } from "./proposal.js";

const candidateOne: Candidate = { number: 1, title: "Login broken", body: "Login is a no-op." };
const candidateTwo: Candidate = { number: 2, title: "Export crashes", body: "Export throws." };

const ranked: readonly Ranked[] = [
  { candidate: candidateOne, score: 0.9 },
  { candidate: candidateTwo, score: 0.4 },
];

describe("matchShortlist", () => {
  // The deliverable's point: a `duplicateOf` naming a thread outside the
  // exact shortlist the judge was shown must be discarded, never
  // best-effort accepted — the same defence `verdict.ts`'s own `parseVerdict`
  // makes, re-checked here against the actual candidates this call ranked
  // rather than trusted from upstream.
  it("refuses a duplicateOf the shortlist never offered, however confident", () => {
    const result = matchShortlist({
      duplicateOf: 999,
      confidence: 1,
      rawRationale: "this is definitely a duplicate",
      ranked,
      query: "query",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "model-a",
      language: "en",
    });

    expect(result).toEqual({ ok: false });
  });

  it("refuses a shortlist with nothing on it at all", () => {
    const result = matchShortlist({
      duplicateOf: 1,
      confidence: 1,
      rawRationale: "rationale",
      ranked: [],
      query: "query",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "model-a",
      language: "en",
    });

    expect(result).toEqual({ ok: false });
  });

  it("matches, sanitises the rationale, and assembles a proposal when confidence clears the floor", () => {
    const result = matchShortlist({
      duplicateOf: 1,
      confidence: 0.8,
      rawRationale: "Same bug as #1 <!-- comment -->",
      ranked,
      query: "query text",
      confidenceFloor: 0.5,
      attribution: "detail",
      model: "Careful",
      language: "en",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligible).toBe(true);
    expect(result.lexicalScore).toBe(0.9);
    // Sanitised, not passed through raw — the exact defanged shape is pinned
    // by `core/sanitize.ts`'s own tests; this just pins that `matchShortlist`
    // actually calls it rather than trusting the verdict, and reports what it
    // produced rather than merely that it changed something.
    expect(result.rationale).toBe("Same bug as #<!---->1 <!-- ------- -->");
    expect(result.fingerprint).not.toBeNull();
    expect(result.proposal).toEqual({
      duplicateOf: 1,
      confidence: 0.8,
      lexicalScore: 0.9,
      rationale: result.rationale,
      model: "Careful",
      attribution: "detail",
      language: "en",
    });
  });

  it("reports the match but withholds the proposal and the fingerprint when confidence is under the floor", () => {
    const result = matchShortlist({
      duplicateOf: 2,
      confidence: 0.2,
      rawRationale: "maybe related",
      ranked,
      query: "query text",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "model-a",
      language: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligible).toBe(false);
    expect(result.lexicalScore).toBe(0.4);
    expect(result.proposal).toBeNull();
    expect(result.fingerprint).toBeNull();
    // The rationale still answers "why", even with nothing eligible to publish.
    expect(result.rationale).toBe("maybe related");
  });

  it("matches exactly at the confidence floor", () => {
    const result = matchShortlist({
      duplicateOf: 1,
      confidence: 0.5,
      rawRationale: "at the floor",
      ranked,
      query: "q",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "m",
      language: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligible).toBe(true);
  });

  it("gives the same candidate query and shortlist the same fingerprint across two calls", () => {
    const first = matchShortlist({
      duplicateOf: 1,
      confidence: 0.9,
      rawRationale: "r",
      ranked,
      query: "same query",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "m",
      language: null,
    });
    const second = matchShortlist({
      duplicateOf: 1,
      confidence: 0.9,
      rawRationale: "r",
      ranked,
      query: "same query",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "m",
      language: null,
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("changes the fingerprint when the shortlist itself changes, even for the same query", () => {
    const withOne = matchShortlist({
      duplicateOf: 1,
      confidence: 0.9,
      rawRationale: "r",
      ranked,
      query: "same query",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "m",
      language: null,
    });
    const withOnlyOne = matchShortlist({
      duplicateOf: 1,
      confidence: 0.9,
      rawRationale: "r",
      ranked: [ranked[0]!],
      query: "same query",
      confidenceFloor: 0.5,
      attribution: "none",
      model: "m",
      language: null,
    });

    expect(withOne.ok && withOnlyOne.ok).toBe(true);
    if (!withOne.ok || !withOnlyOne.ok) return;
    expect(withOne.fingerprint).not.toBe(withOnlyOne.fingerprint);
  });
});
