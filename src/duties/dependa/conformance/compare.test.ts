/**
 * Tests for the conformance comparison engine.
 *
 * These tests verify that the comparison logic correctly classifies
 * discrepancies between Renovate and dependa findings.
 */

import { describe, it, expect } from "vitest";

import {
  compare,
  computeMetrics,
  generateReport,
  renderReportMarkdown,
  toJSONL,
  fromJSONL,
} from "./compare.js";
import type { RenovateFinding, DependaFinding } from "./types.js";

const CONTEXT = {
  repository: "ecoma-io/reeve",
  baseRef: "main",
  dependaVersion: "0.6.0",
  renovateVersion: "app",
};

// ─── Empty inputs ──────────────────────────────────────────────────────────

describe("compare — empty inputs", () => {
  it("returns empty dataset when both inputs are empty", () => {
    const result = compare([], [], CONTEXT);
    expect(result.comparisons).toEqual([]);
  });

  it("returns all as dependa-only when only dependa found things", () => {
    const dependa: DependaFinding[] = [
      {
        ecosystem: "npm",
        name: "lodash",
        constraint: "^4.17.0",
        currentVersion: "4.17.21",
        targetVersion: "4.18.0",
        updateType: "minor",
        group: "npm",
        files: ["package.json"],
        security: false,
        manager: "npm",
        discovered: true,
        policyAction: "allow",
        riskLevel: "low",
      },
    ];
    const result = compare([], dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).not.toBe("MATCH");
  });
});

// ─── Discovery level ───────────────────────────────────────────────────────

describe("compare — discovery level", () => {
  it("classifies Renovate-only discovery as DEPENDA_BUG by default", () => {
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "npm",
        name: "lodash",
        constraint: "^4.17.0",
        currentVersion: "4.17.21",
        targetVersion: "4.18.0",
        updateType: "minor",
        group: "npm",
        files: ["package.json"],
        security: false,
        manager: "npm",
        datasource: "npm",
        wouldPr: true,
      },
    ];
    const result = compare(renovate, [], CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    const comp = result.comparisons[0]!;
    expect(comp.level).toBe("discovery");
    expect(comp.renovateDiscovered).toBe(true);
    expect(comp.dependaDiscovered).toBe(false);
    expect(comp.classification).toBe("DEPENDA_BUG");
  });

  it("classifies lockFileMaintenance as INTENTIONAL_DIFFERENCE", () => {
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "npm",
        name: "lockFileMaintenance",
        constraint: null,
        currentVersion: null,
        targetVersion: null,
        updateType: "maintenance",
        group: null,
        files: ["pnpm-lock.yaml"],
        security: false,
        manager: "npm",
        datasource: "npm",
        wouldPr: true,
      },
    ];
    const result = compare(renovate, [], CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("INTENTIONAL_DIFFERENCE");
  });
});

// ─── Version selection level ───────────────────────────────────────────────

describe("compare — version selection", () => {
  it("classifies matching targets as MATCH", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("MATCH");
  });

  it("classifies different targets at version-selection level", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.17.22", "patch"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    const comp = result.comparisons[0]!;
    expect(comp.level).toBe("version-selection");
    expect(comp.renovateTargetVersion).toBe("4.18.0");
    expect(comp.dependaTargetVersion).toBe("4.17.22");
  });

  it("normalizes v-prefixed versions", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateActions("actions/checkout", "v4", "v7.0.1", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaActions("actions/checkout", "v4", "7.0.1", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("MATCH");
  });
});

// ─── Update classification level ───────────────────────────────────────────

describe("compare — update classification", () => {
  it("normalizes pinDigest → digest", () => {
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: null,
        currentVersion: "3d3c42e5aac5ba805825da76410c181273ba90b1",
        targetVersion: "aaf36d9c5393f06668c8532a2e1c0637e0a1b8e4",
        updateType: "pinDigest",
        group: null,
        files: [".github/workflows/ci.yml"],
        security: false,
        manager: "github-actions",
        datasource: "github-tags",
        wouldPr: true,
      },
    ];
    const dependa: DependaFinding[] = [
      {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: null,
        currentVersion: "3d3c42e5aac5ba805825da76410c181273ba90b1",
        targetVersion: "aaf36d9c5393f06668c8532a2e1c0637e0a1b8e4",
        updateType: "digest",
        group: null,
        files: [".github/workflows/ci.yml"],
        security: false,
        manager: "github-actions",
        discovered: true,
        policyAction: "allow",
        riskLevel: null,
      },
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("MATCH");
  });
});

// ─── Security level ────────────────────────────────────────────────────────

describe("compare — security", () => {
  it("classifies security mismatch at security level", () => {
    // Use the same target and updateType so comparison reaches the security level
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "npm",
        name: "express",
        constraint: "^4.0.0",
        currentVersion: "4.18.0",
        targetVersion: "4.19.0",
        updateType: "patch",
        group: null,
        files: ["package.json"],
        security: true, // Renovate flags as security
        manager: "npm",
        datasource: "npm",
        wouldPr: true,
      },
    ];

    const dependa: DependaFinding[] = [
      makeDependaNpm("express", "^4.0.0", "4.18.0", "4.19.0", "patch"),
    ];

    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    const comp = result.comparisons[0]!;
    expect(comp.level).toBe("security");
    expect(comp.renovateSecurity).toBe(true);
    expect(comp.dependaSecurity).toBe(false);
    expect(comp.classification).toBe("DEPENDA_MISSING_CAPABILITY");
  });

  it("classifies dependa-only security flag as RENOVATE_DIFFERENCE", () => {
    // When dependa flags security but Renovate does not, that's a Renovate
    // gap or a dependa false positive — not a missing capability on dependa
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "npm",
        name: "express",
        constraint: "^4.0.0",
        currentVersion: "4.18.0",
        targetVersion: "4.19.0",
        updateType: "patch",
        group: null,
        files: ["package.json"],
        security: false,
        manager: "npm",
        datasource: "npm",
        wouldPr: true,
      },
    ];
    const dependa: DependaFinding[] = [
      { ...makeDependaNpm("express", "^4.0.0", "4.18.0", "4.19.0", "patch"), security: true },
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    const comp = result.comparisons[0]!;
    expect(comp.level).toBe("security");
    expect(comp.classification).toBe("RENOVATE_DIFFERENCE");
  });
});

// ─── Grouping level ────────────────────────────────────────────────────────

describe("compare — grouping", () => {
  it("classifies group mismatch as INTENTIONAL_DIFFERENCE", () => {
    const renovate: RenovateFinding[] = [
      {
        ...makeRenovateNpm("prettier", "^3.0.0", "3.9.0", "3.9.6", "patch"),
        group: "lint and format toolchain",
      },
    ];
    const dependa: DependaFinding[] = [
      { ...makeDependaNpm("prettier", "^3.0.0", "3.9.0", "3.9.6", "patch"), group: "npm" },
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("grouping");
    expect(result.comparisons[0]!.classification).toBe("INTENTIONAL_DIFFERENCE");
  });
});

// ─── Metrics ────────────────────────────────────────────────────────────────

describe("computeMetrics", () => {
  it("computes metrics from a dataset", () => {
    const dataset = compare(
      [makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      [makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      CONTEXT,
    );
    const metrics = computeMetrics(dataset);
    expect(metrics.totalCandidates).toBe(1);
    expect(metrics.matching).toBe(1);
    expect(metrics.discoveryRecall).toBe(1);
    expect(metrics.targetVersionParity).toBe(1);
  });

  it("counts false negatives when Renovate finds things dependa missed", () => {
    const dataset = compare(
      [
        makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
        makeRenovateNpm("express", "^4.0.0", "4.18.0", "4.19.0", "minor"),
      ],
      [makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      CONTEXT,
    );
    const metrics = computeMetrics(dataset);
    expect(metrics.totalCandidates).toBe(2);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.discoveryRecall).toBe(0.5);
  });
});

// ─── Serialization ─────────────────────────────────────────────────────────

describe("JSONL serialization", () => {
  it("round-trips a dataset through JSONL", () => {
    const dataset = compare(
      [makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      [makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      CONTEXT,
    );
    const jsonl = toJSONL(dataset);
    const restored = fromJSONL(jsonl);
    expect(restored.repository).toBe(dataset.repository);
    expect(restored.comparisons).toHaveLength(dataset.comparisons.length);
    expect(restored.comparisons[0]!.name).toBe("lodash");
  });

  it("rejects empty JSONL", () => {
    expect(() => fromJSONL("")).toThrow("Empty JSONL dataset");
  });
});

// ─── Report rendering ──────────────────────────────────────────────────────

describe("renderReportMarkdown", () => {
  it("renders a report with summary and parity tables", () => {
    // Use a discrepancy so the dependency appears in the report
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.17.22", "patch"),
    ];
    const dataset = compare(renovate, dependa, CONTEXT);
    const report = generateReport(dataset);
    const md = renderReportMarkdown(report);
    expect(md).toContain("Dependa vs Renovate Conformance Report");
    expect(md).toContain("Summary");
    expect(md).toContain("Parity");
    expect(md).toContain("lodash");
    expect(md).toContain("not yet the production replacement");
  });
});

// ─── Discovery edge cases ───────────────────────────────────────────────────

describe("compare — discovery edge cases", () => {
  it("classifies GitHub Actions pinDigest as INTENTIONAL_DIFFERENCE", () => {
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: null,
        currentVersion: "abc123def456abc123def456abc123def456abcd",
        targetVersion: "def456abc123def456abc123def456abc123def0",
        updateType: "pinDigest",
        group: null,
        files: [".github/workflows/ci.yml"],
        security: false,
        manager: "github-actions",
        datasource: "github-tags",
        wouldPr: true,
      },
    ];
    const result = compare(renovate, [], CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("INTENTIONAL_DIFFERENCE");
    expect(result.comparisons[0]!.level).toBe("discovery");
  });

  it("classifies dependa-only discovery as RENOVATE_DIFFERENCE", () => {
    // When dependa finds something Renovate did not, it may be a false
    // positive or a legitimate gap in Renovate — not a dependa deficiency
    const dependa: DependaFinding[] = [
      makeDependaNpm("mystery-pkg", "^1.0.0", "1.0.0", "1.1.0", "minor"),
    ];
    const result = compare([], dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("RENOVATE_DIFFERENCE");
    expect(result.comparisons[0]!.dependaDiscovered).toBe(true);
    expect(result.comparisons[0]!.renovateDiscovered).toBe(false);
  });
});

// ─── Version selection edge cases ───────────────────────────────────────────

describe("compare — version selection edge cases", () => {
  it("classifies null vs non-null target as DEPENDA_MISSING_CAPABILITY", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      { ...makeDependaNpm("lodash", "^4.17.0", "4.17.21", "", "minor"), targetVersion: null },
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("version-selection");
    expect(result.comparisons[0]!.classification).toBe("DEPENDA_MISSING_CAPABILITY");
  });

  it("classifies digest vs version as INTENTIONAL_DIFFERENCE", () => {
    // Renovate proposes a SHA, dependa proposes a version tag
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: "v4",
        currentVersion: "v4",
        targetVersion: "aaf36d9c5393f06668c8532a2e1c0637e0a1b8e4",
        updateType: "digest",
        group: null,
        files: [".github/workflows/ci.yml"],
        security: false,
        manager: "github-actions",
        datasource: "github-tags",
        wouldPr: true,
      },
    ];
    const dependa: DependaFinding[] = [
      makeDependaActions("actions/checkout", "v4", "v4.2.0", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("version-selection");
    expect(result.comparisons[0]!.classification).toBe("INTENTIONAL_DIFFERENCE");
  });

  it("classifies same-version with V-prefix normalization as MATCH", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateActions("actions/setup-node", "v4", "V4.1.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaActions("actions/setup-node", "v4", "4.1.0", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("MATCH");
  });

  it("classifies different non-digest versions as INSUFFICIENT_EVIDENCE", () => {
    // Both are regular version strings but differ — needs investigation
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("typescript", "^5.0.0", "5.3.0", "5.5.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("typescript", "^5.0.0", "5.3.0", "5.4.0", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("version-selection");
    expect(result.comparisons[0]!.classification).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("normalizes semver build metadata", () => {
    // Per semver spec, 2.0.0-beta.1 and 2.0.0-beta.1+build.123 are equal
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("pkg", "^2.0.0", "2.0.0", "2.0.0-beta.1", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("pkg", "^2.0.0", "2.0.0", "2.0.0-beta.1+build.123", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("MATCH");
  });
});

// ─── Update classification edge cases ──────────────────────────────────────────

describe("compare — update classification edge cases", () => {
  it("classifies different non-replacement update types as INSUFFICIENT_EVIDENCE", () => {
    // Same target version, but different update type (e.g. major vs minor)
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("pkg", "^1.0.0", "1.0.0", "2.0.0", "major"),
    ];
    const dependa: DependaFinding[] = [makeDependaNpm("pkg", "^1.0.0", "1.0.0", "2.0.0", "minor")];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("update-classification");
    expect(result.comparisons[0]!.classification).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("classifies replacement update type as DEPENDA_MISSING_CAPABILITY", () => {
    const renovate: RenovateFinding[] = [
      { ...makeRenovateNpm("pkg", "^1.0.0", "1.0.0", "2.0.0", "replacement") },
    ];
    const dependa: DependaFinding[] = [makeDependaNpm("pkg", "^1.0.0", "1.0.0", "2.0.0", "minor")];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("update-classification");
    expect(result.comparisons[0]!.classification).toBe("DEPENDA_MISSING_CAPABILITY");
  });
});

// ─── Mutation level ──────────────────────────────────────────────────────────

describe("compare — mutation level", () => {
  it("classifies file difference at mutation level (Renovate extra files)", () => {
    const renovate: RenovateFinding[] = [
      {
        ...makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
        files: ["package.json", "pnpm-lock.yaml"],
      },
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("mutation");
    expect(result.comparisons[0]!.classification).toBe("INTENTIONAL_DIFFERENCE");
  });

  it("classifies file difference at mutation level (dependa extra files)", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      {
        ...makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
        files: ["package.json", "pnpm-lock.yaml"],
      },
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.level).toBe("mutation");
    expect(result.comparisons[0]!.classification).toBe("INTENTIONAL_DIFFERENCE");
    expect(result.comparisons[0]!.reason).toContain("dependa edits");
  });

  it("skips mutation level when files are identical", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.classification).toBe("MATCH");
  });
});

// ─── Multiple dependencies ──────────────────────────────────────────────────

describe("compare — multiple dependencies", () => {
  it("compares multiple dependencies independently", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
      makeRenovateNpm("express", "^4.0.0", "4.18.0", "4.19.0", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
      makeDependaNpm("express", "^4.0.0", "4.18.0", "4.20.0", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(2);
    const lodashComp = result.comparisons.find((c) => c.name === "lodash");
    const expressComp = result.comparisons.find((c) => c.name === "express");
    expect(lodashComp?.classification).toBe("MATCH");
    expect(expressComp?.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(expressComp?.level).toBe("version-selection");
  });

  it("handles cross-ecosystem dependencies", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
      makeRenovateActions("actions/checkout", "v4", "v7.0.1", "minor"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
      makeDependaActions("actions/checkout", "v4", "7.0.1", "minor"),
    ];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(2);
  });
});

// ─── Dataset context ────────────────────────────────────────────────────────

describe("compare — dataset context", () => {
  it("populates dataset metadata correctly", () => {
    const result = compare([], [], CONTEXT);
    expect(result.repository).toBe("ecoma-io/reeve");
    expect(result.baseRef).toBe("main");
    expect(result.dependaVersion).toBe("0.6.0");
    expect(result.renovateVersion).toBe("app");
    expect(result.timestamp).toBeTruthy();
  });

  it("sorts discrepancies before matches", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("aaa", "^1.0.0", "1.0.0", "1.1.0", "minor"), // MATCH
      makeRenovateNpm("bbb", "^1.0.0", "1.0.0", "1.1.0", "minor"), // will be DEPENDA_BUG (no dependa)
    ];
    const dependa: DependaFinding[] = [makeDependaNpm("aaa", "^1.0.0", "1.0.0", "1.1.0", "minor")];
    const result = compare(renovate, dependa, CONTEXT);
    expect(result.comparisons).toHaveLength(2);
    // Discrepancies (DEPENDA_BUG) should come before MATCH
    expect(result.comparisons[0]!.classification).toBe("DEPENDA_BUG");
    expect(result.comparisons[1]!.classification).toBe("MATCH");
  });
});

// ─── Metrics edge cases ─────────────────────────────────────────────────────

describe("computeMetrics — edge cases", () => {
  it("handles empty dataset", () => {
    const dataset = compare([], [], CONTEXT);
    const metrics = computeMetrics(dataset);
    expect(metrics.totalCandidates).toBe(0);
    expect(metrics.discoveryRecall).toBe(1); // No Renovate findings → perfect recall by convention
    expect(metrics.targetVersionParity).toBe(1);
  });

  it("computes false positives when dependa finds extra", () => {
    const dataset = compare(
      [makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      [
        makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
        makeDependaNpm("mystery-pkg", "^1.0.0", "1.0.0", "1.1.0", "minor"),
      ],
      CONTEXT,
    );
    const metrics = computeMetrics(dataset);
    expect(metrics.falsePositives).toBe(1);
  });

  it("computes security parity when Renovate finds security issues", () => {
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "npm",
        name: "express",
        constraint: "^4.0.0",
        currentVersion: "4.18.0",
        targetVersion: "4.19.0",
        updateType: "patch",
        group: null,
        files: ["package.json"],
        security: true,
        manager: "npm",
        datasource: "npm",
        wouldPr: true,
      },
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("express", "^4.0.0", "4.18.0", "4.19.0", "patch"),
    ];
    const dataset = compare(renovate, dependa, CONTEXT);
    const metrics = computeMetrics(dataset);
    expect(metrics.securityParity).toBe(0);
    expect(metrics.securityDiscrepancies).toBe(1);
  });
});

// ─── JSONL edge cases ───────────────────────────────────────────────────────

describe("JSONL serialization — edge cases", () => {
  it("rejects JSONL with invalid header", () => {
    const invalidJsonl = JSON.stringify({ _type: "wrong-header" });
    expect(() => fromJSONL(invalidJsonl)).toThrow("First line is not a conformance header");
  });

  it("round-trips empty comparisons", () => {
    const dataset = compare([], [], CONTEXT);
    const jsonl = toJSONL(dataset);
    const restored = fromJSONL(jsonl);
    expect(restored.comparisons).toHaveLength(0);
    expect(restored.repository).toBe(CONTEXT.repository);
  });

  it("preserves all classification types through round-trip", () => {
    // Create a dataset with a discrepancy and a match
    const dataset = compare(
      [
        makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor"),
        makeRenovateNpm("express", "^4.0.0", "4.18.0", "4.19.0", "minor"),
      ],
      [makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      CONTEXT,
    );
    const jsonl = toJSONL(dataset);
    const restored = fromJSONL(jsonl);
    expect(restored.comparisons).toHaveLength(2);
    for (let i = 0; i < dataset.comparisons.length; i++) {
      expect(restored.comparisons[i]!.classification).toBe(dataset.comparisons[i]!.classification);
    }
  });
});

// ─── Report generation ──────────────────────────────────────────────────────────

describe("generateReport — sorting", () => {
  it("sorts security discrepancies before non-security", () => {
    const renovate: RenovateFinding[] = [
      {
        ecosystem: "npm",
        name: "secure-pkg",
        constraint: "^1.0.0",
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        updateType: "patch",
        group: null,
        files: ["package.json"],
        security: true,
        manager: "npm",
        datasource: "npm",
        wouldPr: true,
      },
      makeRenovateNpm("normal-pkg", "^1.0.0", "1.0.0", "2.0.0", "major"),
    ];
    const dependa: DependaFinding[] = [
      makeDependaNpm("secure-pkg", "^1.0.0", "1.0.0", "1.1.0", "patch"),
      makeDependaNpm("normal-pkg", "^1.0.0", "1.0.0", "1.5.0", "minor"),
    ];
    const dataset = compare(renovate, dependa, CONTEXT);
    const report = generateReport(dataset);
    // Security discrepancy (secure-pkg) should come before non-security (normal-pkg)
    expect(report.highestValueDiscrepancies.length).toBeGreaterThanOrEqual(2);
    expect(report.highestValueDiscrepancies[0]!.name).toBe("secure-pkg");
    expect(report.highestValueDiscrepancies[1]!.name).toBe("normal-pkg");
  });

  it("sorts DEPENDA_BUG before INTENTIONAL_DIFFERENCE", () => {
    const renovate: RenovateFinding[] = [
      makeRenovateNpm("bug-pkg", "^1.0.0", "1.0.0", "1.1.0", "minor"),
      {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: null,
        currentVersion: "abc123def456abc123def456abc123def456abcd",
        targetVersion: "def456abc123def456abc123def456abc123def0",
        updateType: "pinDigest",
        group: null,
        files: [".github/workflows/ci.yml"],
        security: false,
        manager: "github-actions",
        datasource: "github-tags",
        wouldPr: true,
      },
    ];
    const dependa: DependaFinding[] = [];
    const dataset = compare(renovate, dependa, CONTEXT);
    const report = generateReport(dataset);
    expect(report.highestValueDiscrepancies.length).toBeGreaterThanOrEqual(2);
    // DEPENDA_BUG (bug-pkg) has priority 0, INTENTIONAL_DIFFERENCE (pinDigest) has priority 4
    expect(report.highestValueDiscrepancies[0]!.classification).toBe("DEPENDA_BUG");
    expect(report.highestValueDiscrepancies[1]!.classification).toBe("INTENTIONAL_DIFFERENCE");
  });
});

// ─── Report edge cases ──────────────────────────────────────────────────────

describe("renderReportMarkdown — edge cases", () => {
  it("renders disclaimer even with no discrepancies", () => {
    const dataset = compare(
      [makeRenovateNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      [makeDependaNpm("lodash", "^4.17.0", "4.17.21", "4.18.0", "minor")],
      CONTEXT,
    );
    const report = generateReport(dataset);
    const md = renderReportMarkdown(report);
    expect(md).toContain("not yet the production replacement");
    expect(md).toContain("Summary");
  });

  it("escapes pipe characters in reason strings", () => {
    // The reason is the seventh and last cell of the discrepancy row. A raw
    // `|` inside it opens an eighth column and shears the table from that row
    // down, so the renderer escapes it — and only a fixture that actually
    // holds a pipe can tell whether it still does. A group name is the way one
    // gets there in practice: it is a maintainer-written string that reaches
    // the reason verbatim, and `chore | deps` is an ordinary thing to call a
    // group.
    const renovate: RenovateFinding[] = [
      { ...makeRenovateNpm("pkg-a", "^1.0.0", "1.0.0", "2.0.0", "major"), group: "chore | deps" },
    ];
    const dependa: DependaFinding[] = [
      { ...makeDependaNpm("pkg-a", "^1.0.0", "1.0.0", "2.0.0", "major"), group: null },
    ];
    const dataset = compare(renovate, dependa, CONTEXT);
    const report = generateReport(dataset);
    const md = renderReportMarkdown(report);

    const lines = md.split("\n");
    const header = lines.find((line) => line.startsWith("| Ecosystem | Dependency |"));
    const row = lines.find((line) => line.startsWith("| npm | `pkg-a` |"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();

    // The pipe survives — escaped, not dropped and not passed through raw.
    expect(row).toContain("chore \\| deps");
    expect(row).not.toContain("chore | deps");

    // And the row still parses as the same number of columns as its header,
    // which is the thing the escaping exists to protect.
    const columns = (line: string): number => line.split(/(?<!\\)\|/).length;
    expect(columns(row ?? "")).toBe(columns(header ?? ""));
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRenovateNpm(
  name: string,
  constraint: string,
  currentVersion: string,
  targetVersion: string,
  updateType: string,
): RenovateFinding {
  return {
    ecosystem: "npm",
    name,
    constraint,
    currentVersion,
    targetVersion,
    updateType,
    group: null,
    files: ["package.json"],
    security: false,
    manager: "npm",
    datasource: "npm",
    wouldPr: true,
  };
}

function makeDependaNpm(
  name: string,
  constraint: string,
  currentVersion: string,
  targetVersion: string,
  updateType: string,
): DependaFinding {
  return {
    ecosystem: "npm",
    name,
    constraint,
    currentVersion,
    targetVersion,
    updateType,
    group: null,
    files: ["package.json"],
    security: false,
    manager: "npm",
    discovered: true,
    policyAction: "allow",
    riskLevel: null,
  };
}

function makeRenovateActions(
  name: string,
  constraint: string | null,
  targetVersion: string,
  updateType: string,
): RenovateFinding {
  return {
    ecosystem: "github-actions",
    name,
    constraint,
    currentVersion: constraint,
    targetVersion,
    updateType,
    group: null,
    files: [".github/workflows/ci.yml"],
    security: false,
    manager: "github-actions",
    datasource: "github-tags",
    wouldPr: true,
  };
}

function makeDependaActions(
  name: string,
  constraint: string | null,
  targetVersion: string,
  updateType: string,
): DependaFinding {
  return {
    ecosystem: "github-actions",
    name,
    constraint,
    currentVersion: constraint,
    targetVersion,
    updateType,
    group: null,
    files: [".github/workflows/ci.yml"],
    security: false,
    manager: "github-actions",
    discovered: true,
    policyAction: "allow",
    riskLevel: null,
  };
}
