import { describe, expect, it } from "vitest";

import { summarize, type Run } from "./summary.js";

function run(overrides: Partial<Run> = {}): Run {
  return {
    number: 7,
    dryRun: false,
    headSha: "abc",
    note: null,
    previousSha: "",
    shown: [{ path: "a.ts" }],
    skipped: [],
    findings: [],
    confidence: 0.8,
    posted: null,
    permitted: ["comment" as const],
    spent: [],
    modelNames: new Map(),
    language: "en",
    warrant: ".github/reeve.yml",
    implicit: false,
    ungranted: null,
    malformedAnswers: 0,
    readRules: null,
    ...overrides,
  };
}

describe("summarize", () => {
  it("says nothing was posted when the run produced no verdict", () => {
    const text = summarize(run({ note: "This pull request is a draft." }));
    expect(text).toContain("### Verdict");
    expect(text).toContain("This pull request is a draft.");
  });

  it("explains the granted-nothing case before any verdict", () => {
    const text = summarize(run({ ungranted: "no grant here" }));
    expect(text).toContain("No model was asked anything");
    expect(text).toContain("no grant here");
  });

  it("renders the verdict table with the confidence", () => {
    const text = summarize(run());
    expect(text).toContain("Findings");
    expect(text).toContain("0.80");
    expect(text).toContain("nothing to post");
  });

  it("renders the capabilities the warrant granted", () => {
    const text = summarize(run({ permitted: ["comment" as const] }));
    expect(text).toContain("Granted");
    expect(text).toContain("comment");
  });

  it("renders the head the previous run reviewed, when the diff has moved since", () => {
    const text = summarize(run({ headSha: "def", previousSha: "abc" }));
    expect(text).toContain("Previously");
    expect(text).toContain("`abc`");
  });

  it("renders the findings table when findings exist", () => {
    const text = summarize(
      run({
        findings: [
          {
            finding: {
              id: "i",
              ruleId: "dedup",
              ruleName: "Repeated code",
              ruleBody: "",
              path: "a.ts",
              line: 12,
              severity: "warning",
              body: "Repeated.",
              marker: "",
            },
            status: "created",
          },
        ],
      }),
    );
    expect(text).toContain("### Findings");
    expect(text).toContain("a.ts");
    expect(text).toContain("Repeated.");
  });

  it("renders the verification count row and the Verified column", () => {
    const text = summarize(
      run({
        findings: [
          {
            finding: {
              id: "i",
              ruleId: "dedup",
              ruleName: "Repeated code",
              ruleBody: "",
              path: "a.ts",
              line: 12,
              severity: "warning",
              body: "Repeated.",
              marker: "",
              verification: "verified" as const,
              evidence: [],
            },
            status: "created",
          },
          {
            finding: {
              id: "u",
              ruleId: "dedup",
              ruleName: "Repeated code",
              ruleBody: "",
              path: "b.ts",
              line: 2,
              severity: "warning",
              body: "Claimed.",
              marker: "",
              verification: "unverified" as const,
              evidence: [],
            },
            status: "persists",
          },
          {
            finding: {
              id: "d",
              ruleId: "preflight",
              ruleName: "Blocked text",
              ruleBody: "",
              path: "c.ts",
              line: 3,
              severity: "warning",
              body: "Blocked.",
              marker: "preflight:blocked",
            },
            status: "created",
          },
        ],
      }),
    );
    expect(text).toContain("1 verified · 1 not verified");
    expect(text).toContain("| State | Location | Severity | Finding | Verified |");
    expect(text).toMatch(/c\.ts.*\| — /);
  });

  it("renders the coverage table with skipped reasons", () => {
    const text = summarize(run({ skipped: [{ path: "big.ts", reason: "capped" }] }));
    expect(text).toContain("### Coverage");
    expect(text).toContain("capped");
  });
});
