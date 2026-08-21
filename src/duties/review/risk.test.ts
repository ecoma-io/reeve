import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  assessRisk,
  describeRisk,
  defaultRiskProfile,
  parseRiskProfile,
  UnreadableRiskProfile,
  type RiskProfile,
} from "./risk.js";
import type { PrFile } from "./pr.js";
import { parseRules, type Rules } from "./rules.js";

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: "src/a.ts",
    status: "added",
    previousPath: null,
    additions: 1,
    deletions: 0,
    patch: "@@ -0,0 +1 @@\n+const a = 1;",
    ...overrides,
  };
}

function rules(): Rules {
  return parseRules("version: 1");
}

function profile(overrides: Partial<RiskProfile> = {}): RiskProfile {
  return { ...defaultRiskProfile(), ...overrides };
}

const DEFAULT = defaultRiskProfile();

describe("parseRiskProfile", () => {
  it("parses a complete profile", () => {
    const parsed = parseRiskProfile(
      [
        "version: 1",
        "thresholds:",
        "  medium: 3",
        "  high: 9",
        "weights:",
        "  changed-lines: 2",
        "  auth-change: 0",
        "paths:",
        "  sensitive:",
        "    - vendor/**",
      ].join("\n"),
    );
    expect(parsed.thresholds).toEqual({ medium: 3, high: 9 });
    expect(parsed.weights.changed_lines).toBe(2);
    expect(parsed.weights.auth_change).toBe(0);
    expect(parsed.paths.sensitive_path).toEqual(["vendor/**"]);
    expect(parsed.warnings).toEqual([]);
  });

  it("falls back to the default profile for empty or silent files", () => {
    expect(parseRiskProfile("").thresholds).toEqual(DEFAULT.thresholds);
    expect(parseRiskProfile("version: 1").weights).toEqual(DEFAULT.weights);
    expect(parseRiskProfile("version: 1").warnings).toEqual([]);
  });

  it("warns on unknown top-level keys — including a hostile capabilities key", () => {
    const parsed = parseRiskProfile("version: 1\ncapabilities:\n  - edit-file\n");
    expect(parsed.warnings).toEqual(["unknown top-level key `capabilities`; ignored"]);
  });

  it("warns on a bad version and treats it as 1", () => {
    const parsed = parseRiskProfile("version: 2");
    expect(parsed.version).toBe(1);
    expect(parsed.warnings.some((w) => w.includes("version"))).toBe(true);
  });

  it("warns when medium is not below high and uses defaults", () => {
    const parsed = parseRiskProfile("thresholds:\n  medium: 8\n  high: 2\n");
    expect(parsed.thresholds).toEqual(DEFAULT.thresholds);
    expect(parsed.warnings.some((w) => w.includes("medium < high"))).toBe(true);
  });

  it("refuses a generated-code weight with a warning", () => {
    const parsed = parseRiskProfile("weights:\n  generated-code: 5\n");
    expect(parsed.weights.generated_code).toBe(0);
    expect(parsed.warnings.some((w) => w.includes("fixed at 0"))).toBe(true);
  });

  it("warns on a bad weight value and keeps that signal's default", () => {
    const parsed = parseRiskProfile("weights:\n  auth-change: 7.5\n");
    expect(parsed.weights.auth_change).toBe(DEFAULT.weights.auth_change);
    expect(parsed.warnings.some((w) => w.includes("weights.auth-change"))).toBe(true);
  });

  it("throws UnreadableRiskProfile on invalid YAML and on non-mappings", () => {
    expect(() => parseRiskProfile(":not: [valid")).toThrow(UnreadableRiskProfile);
    expect(() => parseRiskProfile("- a\n- list")).toThrow(UnreadableRiskProfile);
  });
});

describe("assessRisk", () => {
  it("scores nothing as low with no signals", () => {
    const assessment = assessRisk([], rules(), DEFAULT);
    expect(assessment.tier).toBe("low");
    expect(assessment.score).toBe(0);
    expect(assessment.signals).toEqual([]);
  });

  it("escalates a one-line auth change to high by policy", () => {
    const assessment = assessRisk([file({ path: "src/auth/login.ts" })], rules(), DEFAULT);
    expect(assessment.tier).toBe("high");
    expect(assessment.score).toBe(6); // auth 4 + security-sensitive 2
    const auth = assessment.signals.find((s) => s.signal === "auth_change");
    expect(auth?.evidence.some((e) => e.endsWith("by policy"))).toBe(true);
  });

  it("scores a one-line auth token file at 10 and high", () => {
    const assessment = assessRisk([file({ path: "src/auth/token.ts" })], rules(), DEFAULT);
    expect(assessment.tier).toBe("high");
    expect(assessment.score).toBe(10); // auth 4 + security-sensitive 4 + sensitive-path 2
  });

  it("escalates a db migration alone to high, not medium", () => {
    const assessment = assessRisk([file({ path: "db/migrations/0002.sql" })], rules(), DEFAULT);
    expect(assessment.tier).toBe("high");
    expect(assessment.score).toBe(4);
  });

  it("prices a dependency manifest at medium", () => {
    const assessment = assessRisk([file({ path: "package-lock.json" })], rules(), DEFAULT);
    expect(assessment.tier).toBe("medium");
    expect(assessment.score).toBe(3);
  });

  it("keeps the dependency signal on a lockfile the generated defaults skip from the prompt", () => {
    // The default rules mark every lockfile generated, which excludes it from
    // the volume signals — but the dependency signal reads `allFiles`, because
    // skipping a lockfile from the prompt must not also silence the risk its
    // change prices. Both halves of that sentence are pinned here.
    const assessment = assessRisk(
      [file({ path: "pnpm-lock.yaml", additions: 8000, deletions: 8000 })],
      rules(),
      DEFAULT,
    );
    expect(assessment.signals.some((s) => s.signal === "dependency_changes")).toBe(true);
    expect(assessment.signals.some((s) => s.signal === "changed_lines")).toBe(false);
    expect(assessment.signals.find((s) => s.signal === "generated_code")?.evidence[0]).toContain(
      "generated file(s) excluded",
    );
  });

  it("keeps a massive docs-only diff low by Rule B", () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      file({ path: `docs/guide-${String(i)}.md`, additions: 100, deletions: 0 }),
    );
    const assessment = assessRisk(files, rules(), DEFAULT);
    expect(assessment.tier).toBe("low");
    expect(assessment.signals.some((s) => s.signal === "changed_lines")).toBe(true);
  });

  it("keeps a generated-only diff low and reports the exclusion", () => {
    const assessment = assessRisk([file({ path: "bundle.min.js" })], rules(), DEFAULT);
    expect(assessment.tier).toBe("low");
    expect(assessment.signals.find((s) => s.signal === "generated_code")?.evidence[0]).toContain(
      "generated file(s) excluded",
    );
  });

  it("keeps a 400-line generic source file low by Rule B", () => {
    const assessment = assessRisk(
      [file({ path: "src/huge.ts", additions: 400 })],
      rules(),
      DEFAULT,
    );
    expect(assessment.tier).toBe("low");
  });

  it("text sniff alone scores but never escalates", () => {
    const assessment = assessRisk(
      [file({ path: "docs/security.md", patch: "@@ -0,0 +1 @@\n+password = none" })],
      rules(),
      DEFAULT,
    );
    expect(assessment.signals.find((s) => s.signal === "security_sensitive")).toBeDefined();
    expect(assessment.tier).toBe("medium"); // score 4, not high
  });

  it("a weight of 0 on auth-change cannot silence the escalation", () => {
    const zeroed = profile({ weights: { ...DEFAULT.weights, auth_change: 0 } });
    const assessment = assessRisk([file({ path: "src/auth/login.ts" })], rules(), zeroed);
    expect(assessment.tier).toBe("high");
  });

  it("excludes generated volume from the line count", () => {
    const files = [
      file({ path: "src/a.ts", additions: 400 }),
      file({ path: "bundle.min.js", additions: 10000 }),
    ];
    const assessment = assessRisk(files, rules(), DEFAULT);
    expect(assessment.tier).toBe("low");
    const lines = assessment.signals.find((s) => s.signal === "changed_lines");
    expect(lines?.evidence[0]).toContain("generated excluded");
  });

  it("caps evidence at three per signal", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file({ path: `src/auth/user${String(i)}.ts` }),
    );
    const assessment = assessRisk(files, rules(), DEFAULT);
    const auth = assessment.signals.find((s) => s.signal === "auth_change");
    expect(auth?.evidence.filter((e) => e.startsWith("`")).length).toBe(3);
  });

  it("describes a policy escalation", () => {
    const assessment = assessRisk([file({ path: "src/auth/login.ts" })], rules(), DEFAULT);
    expect(describeRisk(assessment)).toContain("high");
    expect(describeRisk(assessment)).toContain("by policy");
  });

  it("is deterministic across identical inputs", () => {
    for (const seed of ["a", "b", "c"]) {
      fc.assert(
        fc.property(
          fc.array(fc.record({ path: fc.constant(seed), additions: fc.nat({ max: 400 }) })),
          (raw) => {
            const files = raw.map((entry, i) =>
              file({ path: `${seed}/f${String(i)}.ts`, additions: entry.additions }),
            );
            const first = assessRisk(files, rules(), DEFAULT);
            const second = assessRisk(files, rules(), DEFAULT);
            expect(second).toEqual(first);
          },
        ),
      );
    }
  });
});
