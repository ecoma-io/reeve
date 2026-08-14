/**
 * Tests for the dependa policy engine.
 *
 * The policy engine is deterministic — no model, no network. These tests
 * verify policy resolution, proposal evaluation, ignore rules, grouping,
 * and auto-approve logic.
 */
import { describe, expect, it } from "vitest";

import type { DependaPolicy, Dependency, UpdateProposal, IgnoreRule } from "./model.js";
import { DEFAULT_DEPENDA_POLICY } from "./model.js";

import { evaluate, group, resolvePolicy } from "./policy.js";

// ── helpers ──────────────────────────────────────────────────────────────

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    ecosystem: "npm",
    name: "lodash",
    constraint: "^4.0.0",
    currentVersion: "4.17.21",
    manifestPath: "package.json",
    dev: false,
    manager: "npm",
    ...overrides,
  };
}

function proposal(overrides: Partial<UpdateProposal> = {}): UpdateProposal {
  return {
    dependency: dep(),
    currentVersion: "4.17.21",
    targetVersion: "4.17.22",
    updateType: "patch",
    releases: [],
    securityAdvisory: null,
    risk: {
      facts: {
        updateType: "patch",
        majorDistance: 0,
        minorDistance: 0,
        patchDistance: 1,
        daysBetweenReleases: null,
        currentVersionStale: null,
        isSecurity: false,
        hasChangelog: false,
        isDev: false,
      },
      interpretation: null,
    },
    evidence: [],
    edits: [],
    groupName: null,
    ...overrides,
  };
}

function policy(overrides: Partial<DependaPolicy> = {}): DependaPolicy {
  return { ...DEFAULT_DEPENDA_POLICY, ...overrides };
}

// ── resolvePolicy ────────────────────────────────────────────────────────

describe("resolvePolicy", () => {
  it("returns defaults when no warrant policy and no workflow ecosystems", () => {
    const result = resolvePolicy(null, []);
    expect(result).toEqual(DEFAULT_DEPENDA_POLICY);
  });

  it("uses warrant policy when provided", () => {
    const warrantPolicy = policy({ allowedTypes: ["patch"] });
    const result = resolvePolicy(warrantPolicy, []);
    expect(result.allowedTypes).toEqual(["patch"]);
  });

  it("applies workflow ecosystems when warrant has none", () => {
    const result = resolvePolicy(null, ["npm", "cargo"]);
    expect(result.ecosystems).toEqual(["npm", "cargo"]);
  });

  it("intersects workflow ecosystems with warrant ecosystems", () => {
    const warrantPolicy = policy({ ecosystems: ["npm", "go"] });
    const result = resolvePolicy(warrantPolicy, ["npm", "cargo"]);
    expect(result.ecosystems).toEqual(["npm"]);
  });

  it("returns empty intersection when no overlap", () => {
    const warrantPolicy = policy({ ecosystems: ["npm"] });
    const result = resolvePolicy(warrantPolicy, ["cargo"]);
    expect(result.ecosystems).toEqual([]);
  });
});

// ── evaluate ─────────────────────────────────────────────────────────────

describe("evaluate", () => {
  it("allows patch updates by default", () => {
    const verdict = evaluate(proposal({ updateType: "patch" }), DEFAULT_DEPENDA_POLICY);
    expect(verdict.action).toBe("allow");
  });

  it("allows minor updates by default (autoApprove: minor)", () => {
    const verdict = evaluate(proposal({ updateType: "minor" }), DEFAULT_DEPENDA_POLICY);
    expect(verdict.action).toBe("allow");
  });

  it("refuses major updates by default (major not in allowedTypes)", () => {
    const verdict = evaluate(proposal({ updateType: "major" }), DEFAULT_DEPENDA_POLICY);
    expect(verdict.action).toBe("refuse");
  });

  it("refuses major updates when not in allowedTypes", () => {
    const p = policy({ allowedTypes: ["patch", "minor"] });
    const verdict = evaluate(proposal({ updateType: "major" }), p);
    expect(verdict.action).toBe("refuse");
  });

  it("allows security updates", () => {
    const verdict = evaluate(proposal({ updateType: "security" }), DEFAULT_DEPENDA_POLICY);
    expect(verdict.action).toBe("allow");
  });

  it("allows pin updates", () => {
    const verdict = evaluate(proposal({ updateType: "pin" }), DEFAULT_DEPENDA_POLICY);
    expect(verdict.action).toBe("allow");
  });

  it("allows digest updates", () => {
    const verdict = evaluate(proposal({ updateType: "digest" }), DEFAULT_DEPENDA_POLICY);
    expect(verdict.action).toBe("allow");
  });

  it("allows rollback updates", () => {
    const verdict = evaluate(proposal({ updateType: "rollback" }), DEFAULT_DEPENDA_POLICY);
    expect(verdict.action).toBe("allow");
  });

  it("propose everything when autoApprove is none", () => {
    const p = policy({ autoApprove: "none", allowedTypes: ["patch", "minor", "major"] });
    expect(evaluate(proposal({ updateType: "patch" }), p).action).toBe("propose");
    expect(evaluate(proposal({ updateType: "minor" }), p).action).toBe("propose");
    expect(evaluate(proposal({ updateType: "major" }), p).action).toBe("propose");
  });

  it("allows patch only when autoApprove is patch", () => {
    const p = policy({ autoApprove: "patch", allowedTypes: ["patch", "minor", "major"] });
    expect(evaluate(proposal({ updateType: "patch" }), p).action).toBe("allow");
    expect(evaluate(proposal({ updateType: "minor" }), p).action).toBe("propose");
    expect(evaluate(proposal({ updateType: "major" }), p).action).toBe("propose");
  });

  it("allows patch and minor when autoApprove is minor", () => {
    const p = policy({ autoApprove: "minor", allowedTypes: ["patch", "minor", "major"] });
    expect(evaluate(proposal({ updateType: "patch" }), p).action).toBe("allow");
    expect(evaluate(proposal({ updateType: "minor" }), p).action).toBe("allow");
    expect(evaluate(proposal({ updateType: "major" }), p).action).toBe("propose");
  });

  it("allows patch, minor, major when autoApprove is major", () => {
    const p = policy({ autoApprove: "major", allowedTypes: ["patch", "minor", "major"] });
    expect(evaluate(proposal({ updateType: "patch" }), p).action).toBe("allow");
    expect(evaluate(proposal({ updateType: "minor" }), p).action).toBe("allow");
    expect(evaluate(proposal({ updateType: "major" }), p).action).toBe("allow");
  });

  // Security/pin/digest/rollback always bypass autoApprove
  it("security is always allowed regardless of autoApprove", () => {
    const p = policy({ autoApprove: "none" });
    expect(evaluate(proposal({ updateType: "security" }), p).action).toBe("allow");
  });

  it("pin is always allowed regardless of autoApprove", () => {
    const p = policy({ autoApprove: "none" });
    expect(evaluate(proposal({ updateType: "pin" }), p).action).toBe("allow");
  });
});

// ── evaluate: ignore rules ───────────────────────────────────────────────

describe("evaluate: ignore rules", () => {
  it("refuses proposals matched by an exact name ignore rule", () => {
    const ignoreRule: IgnoreRule = { name: "lodash", ecosystem: null, types: [] };
    const p = policy({ ignore: [ignoreRule] });
    const verdict = evaluate(proposal(), p);
    expect(verdict.action).toBe("refuse");
    expect(verdict.ignored).toBe(true);
  });

  it("does not refuse when name does not match", () => {
    const ignoreRule: IgnoreRule = { name: "underscore", ecosystem: null, types: [] };
    const p = policy({ ignore: [ignoreRule] });
    const verdict = evaluate(proposal(), p);
    expect(verdict.action).not.toBe("refuse");
  });

  it("matches glob patterns in ignore name", () => {
    const ignoreRule: IgnoreRule = { name: "@types/*", ecosystem: null, types: [] };
    const p = policy({ ignore: [ignoreRule] });
    const verdict = evaluate(proposal({ dependency: dep({ name: "@types/node" }) }), p);
    expect(verdict.action).toBe("refuse");
    expect(verdict.ignored).toBe(true);
  });

  it("ignores by ecosystem when specified", () => {
    const ignoreRule: IgnoreRule = { name: "lodash", ecosystem: "npm", types: [] };
    const p = policy({ ignore: [ignoreRule] });
    // Matches: same name, same ecosystem
    expect(
      evaluate(proposal({ dependency: dep({ name: "lodash", ecosystem: "npm" }) }), p).action,
    ).toBe("refuse");
    // Does not match: same name, different ecosystem
    expect(
      evaluate(proposal({ dependency: dep({ name: "lodash", ecosystem: "cargo" }) }), p).action,
    ).not.toBe("refuse");
  });

  it("ignores by update type when specified", () => {
    const ignoreRule: IgnoreRule = { name: "lodash", ecosystem: null, types: ["major"] };
    const p = policy({ ignore: [ignoreRule] });
    // Major is ignored
    expect(evaluate(proposal({ updateType: "major" }), p).action).toBe("refuse");
    // Patch is not ignored
    expect(evaluate(proposal({ updateType: "patch" }), p).action).not.toBe("refuse");
  });

  it("empty types means ignore all update types", () => {
    const ignoreRule: IgnoreRule = { name: "lodash", ecosystem: null, types: [] };
    const p = policy({ ignore: [ignoreRule] });
    expect(evaluate(proposal({ updateType: "patch" }), p).action).toBe("refuse");
    expect(evaluate(proposal({ updateType: "major" }), p).action).toBe("refuse");
    expect(evaluate(proposal({ updateType: "security" }), p).action).toBe("refuse");
  });
});

// ── group ────────────────────────────────────────────────────────────────

describe("group", () => {
  it("returns empty for no proposals", () => {
    expect(group([], DEFAULT_DEPENDA_POLICY)).toEqual([]);
  });

  it("groups by-ecosystem by default", () => {
    const p1 = proposal({ dependency: dep({ ecosystem: "npm", name: "lodash" }) });
    const p2 = proposal({ dependency: dep({ ecosystem: "npm", name: "express" }) });
    const p3 = proposal({ dependency: dep({ ecosystem: "cargo", name: "serde" }) });

    const groups = group([p1, p2, p3], DEFAULT_DEPENDA_POLICY);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.id === "npm")?.proposals).toHaveLength(2);
    expect(groups.find((g) => g.id === "cargo")?.proposals).toHaveLength(1);
  });

  it("groups by-package when grouping is by-package", () => {
    const p1 = proposal({ dependency: dep({ ecosystem: "npm", name: "lodash" }) });
    const p2 = proposal({ dependency: dep({ ecosystem: "npm", name: "express" }) });

    const p = policy({ grouping: "by-package" });
    const groups = group([p1, p2], p);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.proposals).toHaveLength(1);
    expect(groups[1]?.proposals).toHaveLength(1);
  });

  it("groups into single group when grouping is single", () => {
    const p1 = proposal({ dependency: dep({ ecosystem: "npm", name: "lodash" }) });
    const p2 = proposal({ dependency: dep({ ecosystem: "cargo", name: "serde" }) });

    const p = policy({ grouping: "single" });
    const groups = group([p1, p2], p);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("all");
    expect(groups[0]?.proposals).toHaveLength(2);
  });

  it("separates security proposals when securitySeparate is true", () => {
    const p1 = proposal({ updateType: "patch", dependency: dep({ name: "lodash" }) });
    const p2 = proposal({ updateType: "security", dependency: dep({ name: "openssl" }) });

    const p = policy({ securitySeparate: true });
    const groups = group([p1, p2], p);
    expect(groups).toHaveLength(2);
    const secGroup = groups.find((g) => g.security);
    expect(secGroup).toBeDefined();
    expect(secGroup?.id).toBe("security");
    expect(secGroup?.proposals).toHaveLength(1);
  });

  it("does not separate security when securitySeparate is false", () => {
    const p1 = proposal({
      updateType: "patch",
      dependency: dep({ ecosystem: "npm", name: "lodash" }),
    });
    const p2 = proposal({
      updateType: "security",
      dependency: dep({ ecosystem: "npm", name: "openssl" }),
    });

    const p = policy({ securitySeparate: false });
    const groups = group([p1, p2], p);
    // Both in the npm ecosystem group
    expect(groups).toHaveLength(1);
    expect(groups[0]?.proposals).toHaveLength(2);
  });

  it("filters refused proposals before grouping", () => {
    const p1 = proposal({ updateType: "patch", dependency: dep({ name: "lodash" }) });
    const p2 = proposal({ updateType: "major", dependency: dep({ name: "express" }) });

    // Policy only allows patch/minor — major is refused
    const p = policy({ allowedTypes: ["patch", "minor"] });
    const groups = group([p1, p2], p);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.proposals).toHaveLength(1);
  });

  it("sorts proposals within groups by name", () => {
    const p1 = proposal({ dependency: dep({ name: "zod" }) });
    const p2 = proposal({ dependency: dep({ name: "axios" }) });

    const groups = group([p1, p2], DEFAULT_DEPENDA_POLICY);
    expect(groups[0]?.proposals[0]?.dependency.name).toBe("axios");
    expect(groups[0]?.proposals[1]?.dependency.name).toBe("zod");
  });

  it("returns empty when all proposals are refused", () => {
    const p1 = proposal({ updateType: "major" });
    const onlyMajor = policy({ allowedTypes: ["patch", "minor"] });
    const groups = group([p1], onlyMajor);
    expect(groups).toEqual([]);
  });
});

// ── ignore glob ReDoS protection ────────────────────────────────────────────

describe("ignore glob — ReDoS protection", () => {
  it("rejects patterns longer than 256 characters", () => {
    const longPattern = "a".repeat(300);
    const p = policy({ ignore: [{ name: longPattern, ecosystem: null, types: [] }] });
    const prop = proposal({ dependency: dep({ name: "anything" }) });
    const verdict = evaluate(prop, p);
    // Overly long pattern should not match (rejected by matchesGlob)
    expect(verdict.action).not.toBe("refuse");
  });

  it("handles consecutive wildcards without catastrophic backtracking", () => {
    // Patterns like "***" or "*.*.*.*" should not cause ReDoS
    const patterns = ["***", "*.*.*.*.*", "*?*?*", "**"];
    const p = policy({
      allowedTypes: ["patch", "minor", "major"],
      ignore: patterns.map((pat) => ({ name: pat, ecosystem: null, types: [] })),
    });

    // This should complete quickly (no ReDoS)
    const prop = proposal({ dependency: dep({ name: "some-package" }) });
    const start = Date.now();
    const verdict = evaluate(prop, p);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Must not hang
    expect(verdict.action).toBeDefined();
  });

  it("collapses consecutive wildcards to a single match", () => {
    // "***" should match the same as "*"
    const p = policy({
      allowedTypes: ["patch", "minor", "major"],
      ignore: [{ name: "lodash***", ecosystem: null, types: [] }],
    });
    const prop = proposal({ dependency: dep({ name: "lodash" }) });
    const verdict = evaluate(prop, p);
    expect(verdict.action).toBe("refuse");
    expect(verdict.ignored).toBe(true);
  });

  it("still matches exact names without wildcards", () => {
    const p = policy({
      allowedTypes: ["patch", "minor", "major"],
      ignore: [{ name: "lodash", ecosystem: null, types: [] }],
    });
    const prop = proposal({ dependency: dep({ name: "lodash" }) });
    const verdict = evaluate(prop, p);
    expect(verdict.action).toBe("refuse");
    expect(verdict.ignored).toBe(true);
  });

  it("still matches single-star glob", () => {
    const p = policy({
      allowedTypes: ["patch", "minor", "major"],
      ignore: [{ name: "@scope/*", ecosystem: null, types: [] }],
    });
    const prop = proposal({ dependency: dep({ name: "@scope/utils" }) });
    const verdict = evaluate(prop, p);
    expect(verdict.action).toBe("refuse");
    expect(verdict.ignored).toBe(true);
  });

  it("does not match unrelated names with glob", () => {
    const p = policy({
      allowedTypes: ["patch", "minor", "major"],
      ignore: [{ name: "@scope/*", ecosystem: null, types: [] }],
    });
    const prop = proposal({ dependency: dep({ name: "lodash" }) });
    const verdict = evaluate(prop, p);
    expect(verdict.action).not.toBe("refuse");
  });
});
