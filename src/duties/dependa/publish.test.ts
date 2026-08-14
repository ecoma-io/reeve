/**
 * Tests for the dependa publish module.
 *
 * The publish module builds PR titles, PR bodies, and sanitises branch
 * segments. These tests verify the rendering functions and the branch
 * segment sanitiser. (The actual API calls are integration-level and
 * require a mock GitHub API.)
 */
import { describe, expect, it } from "vitest";

import type { ProposalGroup, UpdateProposal } from "./model.js";

import { buildPrBody, buildPrTitle, sanitizeBranchSegment } from "./publish.js";

// ── helpers ──────────────────────────────────────────────────────────────

function proposal(overrides: Partial<UpdateProposal> = {}): UpdateProposal {
  return {
    dependency: {
      ecosystem: "npm",
      name: "lodash",
      constraint: "^4.0.0",
      currentVersion: "4.17.21",
      manifestPath: "package.json",
      dev: false,
      manager: "npm",
    },
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

function group(overrides: Partial<ProposalGroup> = {}): ProposalGroup {
  return {
    id: "npm",
    ecosystem: "npm",
    proposals: [proposal()],
    security: false,
    ...overrides,
  };
}

// ── sanitizeBranchSegment ───────────────────────────────────────────────

describe("sanitizeBranchSegment", () => {
  it("passes through safe characters", () => {
    expect(sanitizeBranchSegment("npm")).toBe("npm");
    expect(sanitizeBranchSegment("by-ecosystem")).toBe("by-ecosystem");
  });

  it("replaces slashes and at-signs with dashes", () => {
    // @ is replaced with -, / becomes -, leading dash gets "branch" prefix
    expect(sanitizeBranchSegment("@types/node")).toBe("branch-types-node");
  });

  it("replaces unsafe characters with dashes", () => {
    expect(sanitizeBranchSegment("name with spaces")).toBe("name-with-spaces");
  });

  it("prefixes with 'branch' when result starts with dash", () => {
    expect(sanitizeBranchSegment("-leading-dash")).toBe("branch-leading-dash");
  });
});

// ── buildPrTitle ─────────────────────────────────────────────────────────

describe("buildPrTitle", () => {
  it("builds title for single proposal", () => {
    const g = group();
    const title = buildPrTitle(g);
    expect(title).toBe("dependa: update lodash 4.17.21 → 4.17.22");
  });

  it("builds title for multiple proposals", () => {
    const g = group({
      proposals: [
        proposal({
          dependency: {
            ecosystem: "npm",
            name: "lodash",
            constraint: "^4.0.0",
            currentVersion: "4.17.21",
            manifestPath: "package.json",
            dev: false,
            manager: "npm",
          },
        }),
        proposal({
          dependency: {
            ecosystem: "npm",
            name: "express",
            constraint: "^4.0.0",
            currentVersion: "4.18.0",
            manifestPath: "package.json",
            dev: false,
            manager: "npm",
          },
          targetVersion: "4.19.0",
        }),
      ],
    });

    const title = buildPrTitle(g);
    expect(title).toBe("dependa: update 2 dependencies (npm)");
  });

  it("uses security prefix for security groups", () => {
    const g = group({
      security: true,
      proposals: [proposal({ updateType: "security" })],
    });

    const title = buildPrTitle(g);
    expect(title).toContain("🛡️ security");
  });
});

// ── buildPrBody ──────────────────────────────────────────────────────────

describe("buildPrBody", () => {
  it("includes a Markdown table with dependency info", () => {
    const body = buildPrBody(group());
    expect(body).toContain("## dependa update");
    expect(body).toContain("| Dependency | From | To | Type |");
    expect(body).toContain("lodash");
    expect(body).toContain("4.17.21");
    expect(body).toContain("4.17.22");
  });

  it("includes marker for idempotency", () => {
    const body = buildPrBody(group());
    expect(body).toContain("reeve:dependa");
  });

  it("marks dev dependencies", () => {
    const g = group({
      proposals: [
        proposal({
          dependency: {
            ecosystem: "npm",
            name: "jest",
            constraint: "^29.0.0",
            currentVersion: "29.0.0",
            manifestPath: "package.json",
            dev: true,
            manager: "npm",
          },
        }),
      ],
    });
    const body = buildPrBody(g);
    expect(body).toContain("*(dev)*");
  });

  it("includes security advisory info", () => {
    const g = group({
      proposals: [
        proposal({
          updateType: "security",
          securityAdvisory: {
            id: "CVE-2024-0001",
            severity: "high",
            summary: "RCE",
            patchedVersions: ">=4.18.0",
          },
        }),
      ],
    });
    const body = buildPrBody(g);
    expect(body).toContain("CVE-2024-0001");
    expect(body).toContain("high");
  });

  it("includes evidence section when evidence exists", () => {
    const g = group({
      proposals: [
        proposal({
          evidence: [
            {
              kind: "changelog",
              source: "https://example.com/changelog",
              content: "Bug fixes and improvements",
              deterministic: true,
            },
          ],
        }),
      ],
    });
    const body = buildPrBody(g);
    expect(body).toContain("### Evidence");
  });

  it("does not include evidence section when no evidence", () => {
    const body = buildPrBody(group());
    // No ### Evidence header when there's no evidence
    expect(body).not.toContain("### Evidence");
  });
});
