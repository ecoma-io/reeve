import { describe, expect, it } from "vitest";

import { verifyFindings, type VerifyRequest } from "./verify.js";
import type { Finding } from "./findings.js";
import { emptyArchitecture } from "./architecture.js";
import type { Rules } from "./rules.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "dedup:src/app.ts:1",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "src/app.ts",
    line: 1,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    ...overrides,
  };
}

function rules(overrides: Partial<Rules> = {}): Rules {
  return {
    version: 1,
    rules: [
      { id: "dedup", name: "Repeated code", marker: "duplication", body: "", severity: "warning" },
    ],
    ignoreFiles: [],
    ignorePaths: [],
    generatedExtensions: [".min.js"],
    blocked: [],
    raw: "version: 1\nrules:\n  - id: dedup\n",
    architecture: emptyArchitecture(),
    packRefs: [],
    warnings: [],
    ...overrides,
  };
}

function request(overrides: Partial<VerifyRequest> = {}): VerifyRequest {
  return {
    findings: [finding()],
    shown: [
      {
        path: "src/app.ts",
        lines: new Map<number, string>([[1, 'export const VERSION = "1.0.0";']]),
      },
    ],
    rules: rules(),
    headSha: "abc123",
    ...overrides,
  };
}

describe("verifyFindings", () => {
  it("verifies a finding whose claimed snippet matches the diff-proven line", () => {
    const [out] = verifyFindings(
      request({
        findings: [finding({ snippet: 'export const VERSION = "1.0.0";' })],
      }),
    );
    expect(out).toBeDefined();
    expect(out!.verification).toBe("verified");
    expect(out!.evidence.some((entry) => entry.kind === "diff")).toBe(true);
    // The VerifiedFinding IS a Finding — the engine never drops or reshapes.
    expect(out!.id).toBe("dedup:src/app.ts:1");
  });

  it("leaves a snippet mismatch unverified despite rules evidence", () => {
    const [out] = verifyFindings(
      request({
        findings: [finding({ snippet: "export function save(): void {" })],
      }),
    );
    expect(out).toBeDefined();
    expect(out!.verification).toBe("unverified");
    // The cited rule exists — rules evidence alone never upgrades to verified.
    expect(out!.evidence.some((entry) => entry.kind === "rules")).toBe(true);
  });

  it("leaves a finding with no line unverified", () => {
    const [out] = verifyFindings(
      request({
        findings: [finding({ line: null, snippet: "anything" })],
      }),
    );
    expect(out).toBeDefined();
    expect(out!.verification).toBe("unverified");
    expect(out!.evidence.every((entry) => entry.kind === "rules")).toBe(true);
  });

  it("adds no rules evidence when the cited rule is not in the snapshot", () => {
    const [out] = verifyFindings(
      request({
        findings: [finding({ ruleId: "ghost", snippet: 'export const VERSION = "1.0.0";' })],
      }),
    );
    expect(out).toBeDefined();
    expect(out!.verification).toBe("verified"); // the diff evidence stands alone
    expect(out!.evidence.filter((entry) => entry.kind === "rules")).toHaveLength(0);
  });

  it("never drops the finding itself when a limit would be exceeded — truncates evidence only", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      finding({
        id: `f${String(i)}`,
        path: "src/app.ts",
        line: 1,
        snippet: 'export const VERSION = "1.0.0";',
      }),
    );
    const out = verifyFindings(request({ findings: many }));
    expect(out).toHaveLength(60);
    expect(out.every((entry) => entry.verification === "verified")).toBe(true);
    // Every finding keeps its diff evidence, and the per-run cap is respected.
    const totalItems = out.reduce((sum, entry) => sum + entry.evidence.length, 0);
    expect(totalItems).toBeLessThanOrEqual(128);
  });

  it("caps evidence per finding, keeping the highest-weight items", () => {
    // 12 rules-only findings, each contributing one rules evidence item — more
    // than the per-finding room of 8 — so each finding keeps 8.
    const many = Array.from({ length: 12 }, (_, i) =>
      finding({
        id: `r${String(i)}`,
        ruleId: "dedup",
        path: "src/app.ts",
        line: null,
      }),
    );
    const out = verifyFindings(request({ findings: many }));
    expect(out).toHaveLength(12);
    for (const entry of out) {
      expect(entry.evidence.length).toBeLessThanOrEqual(8);
    }
  });

  it("passes deterministic-marker findings through when they reach the engine", () => {
    const [out] = verifyFindings(
      request({
        findings: [
          finding({ marker: "preflight:blocked", snippet: 'export const VERSION = "1.0.0";' }),
        ],
      }),
    );
    expect(out).toBeDefined();
    expect(out!.id).toBe("dedup:src/app.ts:1");
    expect(out!.marker).toBe("preflight:blocked");
  });
});
