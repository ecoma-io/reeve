import { describe, expect, it } from "vitest";

import { buildSarif } from "./sarif.js";
import type { Finding, Reconciled, Status } from "./findings.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "dedup:src/a.ts",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "Flag code that is repeated.",
    path: "src/a.ts",
    line: 12,
    severity: "warning",
    body: "The same helper is defined twice.",
    marker: "",
    ...overrides,
  };
}

function entry(status: Status, overrides: Partial<Finding> = {}): Reconciled {
  return { finding: finding(overrides), status, disposition: null };
}

function parse(text: string): {
  runs: {
    tool: { driver: { name: string; rules: { id: string; name: string }[] } };
    results: {
      ruleId: string;
      ruleIndex: number;
      level: string;
      message: { text: string };
      locations: {
        physicalLocation: {
          artifactLocation: { uri: string };
          region?: { startLine: number };
        };
      }[];
      partialFingerprints: Record<string, string>;
    }[];
    properties: { headSha: string };
  }[];
} {
  return JSON.parse(text) as ReturnType<typeof parse>;
}

describe("buildSarif", () => {
  it("renders a standing finding with the severity map, the id fingerprint, and the head SHA", () => {
    const doc = parse(buildSarif([entry("created")], "abc123"));
    const run = doc.runs[0];
    expect(run?.tool.driver.name).toBe("reeve-review");
    expect(run?.properties.headSha).toBe("abc123");
    const result = run?.results[0];
    expect(result?.ruleId).toBe("dedup");
    expect(result?.level).toBe("warning");
    expect(result?.message.text).toBe("The same helper is defined twice.");
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe("src/a.ts");
    expect(result?.locations[0]?.physicalLocation.region?.startLine).toBe(12);
    expect(result?.partialFingerprints["reeveFinding/v1"]).toBe("dedup|src/a.ts");
  });

  it("maps critical to error and info to note", () => {
    const doc = parse(
      buildSarif(
        [
          entry("created", { id: "a:x", severity: "critical" }),
          entry("created", { id: "b:x", severity: "info" }),
        ],
        "sha",
      ),
    );
    expect(doc.runs[0]?.results.map((r) => r.level)).toEqual(["error", "note"]);
  });

  it("omits a resolved finding, which is how code scanning closes its alert", () => {
    // Absence IS the resolved rung: code scanning closes an alert missing
    // from the newest upload, so the lifecycle needs no second state machine.
    const doc = parse(
      buildSarif(
        [entry("resolved", { id: "a:x" }), entry("persists", { id: "b:y", path: "src/b.ts" })],
        "sha",
      ),
    );
    expect(doc.runs[0]?.results).toHaveLength(1);
    expect(doc.runs[0]?.results[0]?.partialFingerprints["reeveFinding/v1"]).toBe("dedup|src/b.ts");
  });

  it("keeps reopened, changed and persists findings standing", () => {
    const doc = parse(
      buildSarif(
        [
          entry("reopened", { id: "a:x" }),
          entry("changed", { id: "b:x" }),
          entry("persists", { id: "c:x" }),
        ],
        "sha",
      ),
    );
    expect(doc.runs[0]?.results).toHaveLength(3);
  });

  it("renders a file-level finding without a region", () => {
    const doc = parse(buildSarif([entry("created", { line: null })], "sha"));
    expect(doc.runs[0]?.results[0]?.locations[0]?.physicalLocation.region).toBeUndefined();
  });

  it("is deterministic: results and rules sort by id whatever the input order", () => {
    const shuffled = [
      entry("created", { id: "z:z", ruleId: "z" }),
      entry("created", { id: "a:a", ruleId: "a" }),
    ];
    const forward = buildSarif(shuffled, "sha");
    const backward = buildSarif([...shuffled].reverse(), "sha");
    expect(forward).toBe(backward);
    const doc = parse(forward);
    expect(doc.runs[0]?.results.map((r) => r.ruleId)).toEqual(["a", "z"]);
    expect(doc.runs[0]?.results.map((r) => r.ruleIndex)).toEqual([0, 1]);
  });

  it("sanitizes model prose before it reaches the code-scanning UI", () => {
    // The same `sanitize` the comment pipeline uses: an HTML comment in a
    // finding body is a marker-injection attempt, and its contents are
    // defanged to dashes before the text lands anywhere a UI renders it.
    const doc = parse(
      buildSarif([entry("created", { body: "before <!-- reeve:marker --> after" })], "sha"),
    );
    expect(doc.runs[0]?.results[0]?.message.text).not.toContain("reeve:marker");
  });

  it("falls back to the rule name for an empty body, and caps a huge one", () => {
    const empty = parse(buildSarif([entry("created", { body: "  " })], "sha"));
    expect(empty.runs[0]?.results[0]?.message.text).toBe("Repeated code");
    const huge = parse(buildSarif([entry("created", { body: "x".repeat(5000) })], "sha"));
    expect(huge.runs[0]?.results[0]?.message.text).toHaveLength(1000);
  });

  it("renders an empty reconciliation as an empty results list, still a valid document", () => {
    const doc = parse(buildSarif([], "sha"));
    expect(doc.runs[0]?.results).toEqual([]);
    expect(doc.runs[0]?.tool.driver.rules).toEqual([]);
  });
});
