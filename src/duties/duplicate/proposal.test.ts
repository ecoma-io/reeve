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
    const result = matchShortlist(
      999,
      1,
      "this is definitely a duplicate",
      ranked,
      "query",
      0.5,
      "none",
      "model-a",
      "en",
    );

    expect(result).toEqual({ ok: false });
  });

  it("refuses a shortlist with nothing on it at all", () => {
    const result = matchShortlist(1, 1, "rationale", [], "query", 0.5, "none", "model-a", "en");

    expect(result).toEqual({ ok: false });
  });

  it("matches, sanitises the rationale, and assembles a proposal when confidence clears the floor", () => {
    const result = matchShortlist(
      1,
      0.8,
      "Same bug as #1 <!-- comment -->",
      ranked,
      "query text",
      0.5,
      "detail",
      "Careful",
      "en",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligible).toBe(true);
    expect(result.lexicalScore).toBe(0.9);
    // Sanitised, not passed through raw — see `core/sanitize.ts`'s own tests
    // for what defanging a comment marker does; this just pins that
    // `matchShortlist` actually calls it rather than trusting the verdict.
    expect(result.rationale).not.toBe("Same bug as #1 <!-- comment -->");
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
    const result = matchShortlist(
      2,
      0.2,
      "maybe related",
      ranked,
      "query text",
      0.5,
      "none",
      "model-a",
      null,
    );

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
    const result = matchShortlist(1, 0.5, "at the floor", ranked, "q", 0.5, "none", "m", null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligible).toBe(true);
  });

  it("gives the same candidate query and shortlist the same fingerprint across two calls", () => {
    const first = matchShortlist(1, 0.9, "r", ranked, "same query", 0.5, "none", "m", null);
    const second = matchShortlist(1, 0.9, "r", ranked, "same query", 0.5, "none", "m", null);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("changes the fingerprint when the shortlist itself changes, even for the same query", () => {
    const withOne = matchShortlist(1, 0.9, "r", ranked, "same query", 0.5, "none", "m", null);
    const withOnlyOne = matchShortlist(
      1,
      0.9,
      "r",
      [ranked[0]!],
      "same query",
      0.5,
      "none",
      "m",
      null,
    );

    expect(withOne.ok && withOnlyOne.ok).toBe(true);
    if (!withOne.ok || !withOnlyOne.ok) return;
    expect(withOne.fingerprint).not.toBe(withOnlyOne.fingerprint);
  });
});
