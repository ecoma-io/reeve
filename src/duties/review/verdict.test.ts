import { describe, expect, it } from "vitest";

import { parseVerdict, parseFinding } from "./verdict.js";
import type { ShownFile } from "./pr.js";

function file(overrides: Partial<ShownFile> = {}): ShownFile {
  return {
    path: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +12,2 @@\n+const a = 1;\n+const b = 2;",
    lines: new Map([
      [12, "const a = 1;"],
      [13, "const b = 2;"],
    ]),
    ...overrides,
  };
}

const FILES = [file()];

function finding(raw: Record<string, unknown>) {
  return raw;
}

describe("parseVerdict", () => {
  it("reads a well-formed answer", () => {
    const answer = JSON.stringify({
      findings: [finding({ rule: "dedup", path: "src/a.ts", line: 12, body: "Repeated." })],
      confidence: 0.8,
    });
    expect(parseVerdict(answer, FILES)).toEqual({
      findings: [
        {
          rule: "dedup",
          severity: "warning",
          path: "src/a.ts",
          line: 12,
          body: "Repeated.",
          snippet: "Repeated.",
        },
      ],
      confidence: 0.8,
    });
  });

  it("returns null on malformed JSON", () => {
    expect(parseVerdict("not json", FILES)).toBeNull();
  });

  it("returns null on JSON that is not a mapping", () => {
    expect(parseVerdict("[1, 2]", FILES)).toBeNull();
  });

  it("returns null on an out-of-range confidence", () => {
    expect(parseVerdict(JSON.stringify({ findings: [], confidence: 7 }), FILES)).toBeNull();
  });

  it("accepts an empty findings list", () => {
    expect(parseVerdict(JSON.stringify({ findings: [], confidence: 0 }), FILES)).toEqual({
      findings: [],
      confidence: 0,
    });
  });

  it("returns null when a single finding overreaches — malformed whole answer", () => {
    const answer = JSON.stringify({
      findings: [{ rule: "dedup", path: "missing.ts", line: 1, body: "Nope." }],
      confidence: 0.5,
    });
    expect(parseVerdict(answer, FILES)).toBeNull();
  });

  it("unwraps an answer wrapped uselessly in one fence", () => {
    const inner = JSON.stringify({ findings: [], confidence: 0 });
    expect(parseVerdict(`\`\`\`json\n${inner}\n\`\`\``, FILES)).toEqual({
      findings: [],
      confidence: 0,
    });
  });
});

describe("parseFinding", () => {
  it("rejects an unproven line number — the anti-invention guard", () => {
    expect(
      parseFinding({ rule: "dedup", path: "src/a.ts", line: 999, body: "No." }, FILES),
    ).toBeNull();
  });

  it("rejects a file the diff never showed", () => {
    expect(
      parseFinding({ rule: "dedup", path: "not/shown.ts", line: 12, body: "No." }, FILES),
    ).toBeNull();
  });

  it("rejects a blank body, a bad severity, and a missing rule", () => {
    expect(
      parseFinding({ rule: "dedup", path: "src/a.ts", line: 12, body: " " }, FILES),
    ).toBeNull();
    expect(
      parseFinding(
        { rule: "dedup", path: "src/a.ts", line: 12, body: "x", severity: "urgent" },
        FILES,
      ),
    ).toBeNull();
    expect(parseFinding({ path: "src/a.ts", line: 12, body: "x" }, FILES)).toBeNull();
  });

  it("truncates a snippet to 120 characters", () => {
    const out = parseFinding(
      { rule: "dedup", path: "src/a.ts", line: 12, body: "x", snippet: "z".repeat(200) },
      FILES,
    );
    expect(out?.snippet).toHaveLength(120);
  });
});
