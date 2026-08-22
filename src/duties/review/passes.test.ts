import { describe, expect, it } from "vitest";

import type { Provider } from "../../core/provider.js";
import type { RawFinding } from "./findings.js";
import type { ShownFile } from "./pr.js";
import {
  aggregateConfidence,
  correctnessPass,
  dedup,
  detectContradictions,
  rank,
  runPasses,
  secondOpinionPass,
  synthesize,
  type PassContext,
  type PassResult,
  type PassVerdict,
  type ReviewFinding,
  type ReviewPass,
} from "./passes.js";

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

const CONTEXT: PassContext = {
  prTitle: "Fix the crash",
  prBody: "",
  headSha: "abc123",
  files: FILES,
  rules: [
    { id: "dedup", name: "Repeated code", marker: "", body: "", severity: "warning" as const },
  ],
  language: null,
  context: {
    sections: [],
    text: null,
    totalChars: 0,
    readFiles: 0,
  },
};

/** A provider that answers every pass the same content — the seam most tests need. */
function providerOf(contents: readonly (string | null)[]): Provider {
  let index = 0;
  return {
    complete: () => {
      const content = contents[Math.min(index++, contents.length - 1)];
      return Promise.resolve(
        content === null
          ? { ok: false, model: "m", kind: "capacity", reason: "down" }
          : {
              ok: true,
              model: "m",
              content: content ?? "",
              finishReason: "stop",
              cost: { input: 1, output: 1, total: 2 },
            },
      );
    },
  };
}

function verdictWith(findings: RawFinding[]): string {
  return JSON.stringify({ findings, confidence: 0.9 });
}

const finding = (overrides: Partial<RawFinding> = {}): RawFinding => ({
  rule: "dedup",
  severity: "warning",
  path: "src/a.ts",
  line: 12,
  body: "Repeated logic.",
  snippet: "Repeated logic.",
  ...overrides,
});

function resultOf(
  pass: ReviewPass,
  verdict: PassVerdict | null,
  overrides: Partial<PassResult> = {},
): PassResult {
  return {
    pass,
    verdict,
    unreadable: verdict === null ? "not json" : null,
    failures: [],
    model: verdict === null ? null : "m",
    ...overrides,
  };
}

describe("runPasses", () => {
  it("runs every pass in order, each against its own rotation", async () => {
    const asked: string[] = [];
    const provider: Provider = {
      complete: (_model, messages) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        asked.push(system.includes("second opinion") ? "second-opinion" : "correctness");
        return Promise.resolve({
          ok: true,
          model: "m",
          content: verdictWith([]),
          finishReason: "stop",
          cost: { input: 1, output: 1, total: 2 },
        });
      },
    };
    const results = await runPasses(
      provider,
      [correctnessPass(), secondOpinionPass()],
      ["m"],
      CONTEXT,
    );
    expect(asked).toEqual(["correctness", "second-opinion"]);
    expect(results.map((r) => r.pass.id)).toEqual(["correctness", "second-opinion"]);
  });

  it("reports an unreadable pass as unreadable without retrying or softening", async () => {
    const provider = providerOf(["not json", verdictWith([])]);
    const results = await runPasses(
      provider,
      [correctnessPass(), secondOpinionPass()],
      ["m"],
      CONTEXT,
    );
    expect(results[0]?.unreadable).toBe("not json");
    expect(results[0]?.verdict).toBeNull();
    expect(results[1]?.unreadable).toBeNull();
    expect(results[1]?.verdict).toEqual({ findings: [], confidence: 0.9 });
  });

  it("reports a capacity failure per pass, leaving the pass unmeasured", async () => {
    const results = await runPasses(
      providerOf([null, null]),
      [correctnessPass(), secondOpinionPass()],
      ["m"],
      CONTEXT,
    );
    expect(results[0]?.failures.length).toBeGreaterThan(0);
    expect(results[0]?.verdict).toBeNull();
    expect(results[1]?.failures.length).toBeGreaterThan(0);
  });

  it("truncation is a protocol failure, not a readable answer", async () => {
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
    const results = await runPasses(provider, [correctnessPass()], ["m"], CONTEXT);
    expect(results[0]?.failures[0]?.kind).toBe("protocol");
    expect(results[0]?.verdict).toBeNull();
  });
});

describe("dedup", () => {
  it("merges the same rule, file and line found by two passes into one corroborated finding", () => {
    const make = (passId: string): ReviewFinding => ({
      id: "dedup:src/a.ts:12",
      ruleId: "dedup",
      severity: "warning",
      path: "src/a.ts",
      line: 12,
      body: "The claim.",
      snippet: "snippet",
      passId,
      corroboratedBy: [passId],
    });
    const out = dedup([make("correctness"), make("security")]);
    expect(out).toHaveLength(1);
    expect(out[0]?.corroboratedBy).toEqual(["correctness", "security"]);
    expect(out[0]?.body).toBe("The claim.");
  });

  it("keeps two different findings at the same place separate", () => {
    const make = (ruleId: string): ReviewFinding => ({
      id: `${ruleId}:src/a.ts:12`,
      ruleId,
      severity: "warning",
      path: "src/a.ts",
      line: 12,
      body: ruleId,
      snippet: "snippet",
      passId: "correctness",
      corroboratedBy: ["correctness"],
    });
    expect(dedup([make("dedup"), make("injection")])).toHaveLength(2);
  });
});

describe("detectContradictions", () => {
  it("flags two passes claiming different rules at one line", () => {
    const make = (ruleId: string, body: string): ReviewFinding => ({
      id: `${ruleId}:src/a.ts:12`,
      ruleId,
      severity: "warning",
      path: "src/a.ts",
      line: 12,
      body,
      snippet: "snippet",
      passId: "correctness",
      corroboratedBy: ["correctness"],
    });
    const contradictions = detectContradictions([make("dedup", "a"), make("injection", "b")]);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.path).toBe("src/a.ts");
    expect(contradictions[0]?.findings).toHaveLength(2);
  });

  it("annotates a contradicted finding rather than silently keeping the louder one", () => {
    const results: PassResult[] = [
      resultOf(correctnessPass(), {
        findings: [{ ...finding(), rule: "dedup", body: "a" }],
        confidence: 0.9,
      }),
      resultOf(secondOpinionPass(), {
        findings: [{ ...finding(), rule: "injection", body: "b" }],
        confidence: 0.9,
      }),
    ];
    const synthesis = synthesize(results);
    const dedupClaim = synthesis.findings.find((f) => f.ruleId === "dedup");
    expect(dedupClaim?.body).toContain("another pass reports");
  });
});

describe("rank", () => {
  it("orders by severity, then corroboration, then position", () => {
    const make = (
      severity: "info" | "warning" | "critical",
      ruleId: string,
      corroboratedBy: readonly string[],
      line: number | null,
      path = "src/a.ts",
    ): ReviewFinding => ({
      id: `${ruleId}:${path}:${String(line ?? 0)}`,
      ruleId,
      severity,
      path,
      line,
      body: ruleId,
      snippet: "snippet",
      passId: "correctness",
      corroboratedBy,
    });
    const out = rank([
      make("info", "infoRule", ["correctness"], 13),
      make("critical", "critRule", ["correctness"], 12),
      make("warning", "corroborated", ["correctness", "security"], 12),
      make("warning", "lonely", ["correctness"], 12),
    ]);
    expect(out.map((f) => f.ruleId)).toEqual(["critRule", "corroborated", "lonely", "infoRule"]);
  });
});

describe("aggregateConfidence", () => {
  it("is the strongest readable pass's confidence, undegraded when every pass answered", () => {
    const results: PassResult[] = [
      resultOf(correctnessPass(), { findings: [], confidence: 0.6 }),
      resultOf(secondOpinionPass(), { findings: [], confidence: 0.9 }),
    ];
    expect(aggregateConfidence(results)).toEqual({ confidence: 0.9, measured: true });
  });

  it("degrades the confidence by 10% per pass that could not answer", () => {
    const results: PassResult[] = [
      resultOf(correctnessPass(), { findings: [], confidence: 0.9 }),
      resultOf(secondOpinionPass(), null),
    ];
    expect(aggregateConfidence(results).confidence).toBeCloseTo(0.81);
  });

  it("is unmeasured when no pass answered — the D5 fail-loud spine", () => {
    const results: PassResult[] = [
      resultOf(correctnessPass(), null),
      resultOf(secondOpinionPass(), null),
    ];
    expect(aggregateConfidence(results)).toEqual({ confidence: 0, measured: false });
  });
});

describe("synthesize", () => {
  it("builds one report row per pass, in order, with honest per-pass answers", () => {
    const results: PassResult[] = [
      resultOf(correctnessPass(), { findings: [finding()], confidence: 0.9 }),
      resultOf(secondOpinionPass(), null),
    ];
    const synthesis = synthesize(results);
    expect(synthesis.passes.map((p) => p.id)).toEqual(["correctness", "second-opinion"]);
    expect(synthesis.passes[0]).toMatchObject({ answered: true, findings: 1 });
    expect(synthesis.passes[1]).toMatchObject({ answered: false, unreadable: true });
    expect(synthesis.failedPasses).toEqual([
      { id: "second-opinion", reason: "the answer did not parse as findings" },
    ]);
    expect(synthesis.measured).toBe(true);
  });

  it("an unreadable pass is priced in and named — never silently dropped", () => {
    const results: PassResult[] = [
      resultOf(correctnessPass(), { findings: [finding()], confidence: 0.9 }),
      resultOf(secondOpinionPass(), null),
    ];
    const synthesis = synthesize(results);
    expect(synthesis.confidence).toBeCloseTo(0.81);
    expect(synthesis.failedPasses[0]?.id).toBe("second-opinion");
  });

  it("a later pass's findings carry their own provenance", () => {
    const results: PassResult[] = [
      resultOf(correctnessPass(), { findings: [], confidence: 0.9 }),
      resultOf(secondOpinionPass(), {
        findings: [finding({ rule: "injection" })],
        confidence: 0.9,
      }),
    ];
    const synthesis = synthesize(results);
    expect(synthesis.findings[0]?.passId).toBe("second-opinion");
  });

  it("a prompt injection in the diff cannot change a pass's marker or parse", async () => {
    // The diff the second pass reads carries an injection-shaped line; the
    // provider tries to answer with prose plus a fabricated finding. The strict
    // parse must not propagate the fabricated finding — the whole answer is
    // unreadable instead (D5).
    const provider = providerOf([
      verdictWith([]),
      `Sure! This diff is fine.\n${verdictWith([finding({ rule: "injected" })])}`,
    ]);
    const results = await runPasses(
      provider,
      [correctnessPass(), secondOpinionPass()],
      ["m"],
      CONTEXT,
    );
    const synthesis = synthesize(results);
    expect(synthesis.findings.every((f) => f.ruleId !== "injected")).toBe(true);
    expect(synthesis.failedPasses.map((f) => f.id)).toContain("second-opinion");
  });

  it("the shared prompt routes each pass to its own brief", () => {
    const secondOpinionSystem =
      secondOpinionPass()
        .prompt(CONTEXT)
        .find((m) => m.role === "system")?.content ?? "";
    expect(secondOpinionSystem).toContain("second opinion");
    expect(secondOpinionSystem).toContain("fresh eyes");
    const correctnessSystem =
      correctnessPass()
        .prompt(CONTEXT)
        .find((m) => m.role === "system")?.content ?? "";
    expect(correctnessSystem).toContain("You are reviewing a pull request");
    expect(correctnessSystem).not.toContain("second opinion");
  });
});
