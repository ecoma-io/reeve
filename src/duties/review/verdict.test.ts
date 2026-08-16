import { describe, expect, it } from "vitest";

import { parseVerdict, parseFinding, review, NOTHING } from "./verdict.js";
import type { ShownFile } from "./pr.js";
import { createWeather, type Provider } from "../../core/provider.js";

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

function providerOf(content: string | null): Provider {
  return {
    complete: () =>
      Promise.resolve(
        content === null
          ? { ok: false, model: "m", kind: "capacity", reason: "down" }
          : {
              ok: true,
              model: "m",
              content,
              finishReason: "stop",
              cost: { input: 1, output: 1, total: 2 },
            },
      ),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    provider: providerOf(JSON.stringify({ findings: [], confidence: 0.9 })),
    models: ["m"],
    prTitle: "T",
    prBody: "",
    headSha: "abc",
    files: FILES,
    rules: [
      { id: "dedup", name: "Repeated code", marker: "", body: "", severity: "warning" as const },
    ],
    language: null,
    weather: createWeather(),
    ...overrides,
  };
}

describe("review", () => {
  it("returns NOTHING without asking when the diff has no files to show", async () => {
    const out = await review({ ...request(), files: [] });
    expect(out).toEqual({ verdict: NOTHING, failures: [], unreadable: null, model: null });
  });

  it("returns NOTHING and the failures when every model fails on capacity", async () => {
    const out = await review({ ...request(), provider: providerOf(null) });
    expect(out.verdict).toBe(NOTHING);
    expect(out.failures.length).toBeGreaterThan(0);
    expect(out.model).toBeNull();
  });

  it("reports a truncated answer as a protocol failure", async () => {
    const provider: Provider = {
      complete: () =>
        Promise.resolve({
          ok: true,
          model: "m",
          content: '{"findings": ',
          finishReason: "length",
          cost: { input: 1, output: 1, total: 2 },
        }),
    };
    const out = await review({ ...request(), provider });
    expect(out.failures[0]?.kind).toBe("protocol");
  });

  it("returns the parsed verdict and the model that wrote it", async () => {
    const out = await review(request());
    expect(out.model).toBe("m");
    expect(out.unreadable).toBeNull();
    expect(out.verdict.findings).toEqual([]);
  });

  it("marks an answer that did not parse as unreadable", async () => {
    const out = await review({ ...request(), provider: providerOf("not json") });
    expect(out.unreadable).toBe("not json");
    expect(out.verdict).toBe(NOTHING);
  });
});
