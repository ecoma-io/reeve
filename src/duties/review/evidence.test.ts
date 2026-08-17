import { describe, expect, it } from "vitest";

import { deriveStatus, evidenceFingerprint, type Evidence } from "./evidence.js";

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    kind: "diff",
    weight: 1,
    detail: "diff-proven line 1",
    provenance: {
      ruleId: "diff-evidence",
      sourceFile: "src/app.ts",
      atLine: 1,
      ref: { sha: "abc", path: "src/app.ts" },
    },
    at: "deterministic",
    ...overrides,
  };
}

describe("deriveStatus", () => {
  it("verifies only with proven-at-line evidence (weight >= 1)", () => {
    expect(deriveStatus([evidence()])).toBe("verified");
    expect(deriveStatus([evidence({ weight: 1 })])).toBe("verified");
  });

  it("stays unverified with consistent-with-rule evidence only (weight 0.6)", () => {
    expect(
      deriveStatus([evidence({ kind: "rules", weight: 0.6, detail: "cites a repository rule" })]),
    ).toBe("unverified");
  });

  it("stays unverified with no evidence at all — the false-positive test", () => {
    // A model's 0.99 confidence is not an input here and can never upgrade
    // absence: deriveStatus takes evidence alone, so an empty list is unverified.
    expect(deriveStatus([])).toBe("unverified");
  });
});

describe("evidenceFingerprint", () => {
  it("is stable for the same evidence, in any order", () => {
    const a = evidence({ kind: "rules", weight: 0.6, detail: "cites a repository rule" });
    const b = evidence();
    expect(evidenceFingerprint([a, b])).toBe(evidenceFingerprint([b, a]));
  });

  it("differs when the detail differs", () => {
    expect(evidenceFingerprint([evidence({ detail: "diff-proven line 1" })])).not.toBe(
      evidenceFingerprint([evidence({ detail: "diff-proven line 2" })]),
    );
  });

  it("differs when the provenance differs", () => {
    expect(
      evidenceFingerprint([
        evidence({ provenance: { ...evidence().provenance, sourceFile: "a.ts" } }),
      ]),
    ).not.toBe(
      evidenceFingerprint([
        evidence({ provenance: { ...evidence().provenance, sourceFile: "b.ts" } }),
      ]),
    );
  });
});
