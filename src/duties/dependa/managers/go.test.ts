/**
 * Tests for the Go manager — dependency discovery from go.mod.
 *
 * Deterministic: same go.mod content produces the same Dependency list.
 * Tests cover require directive parsing (single-line and block form),
 * indirect detection, go.sum lockfile resolution, and applyUpdate.
 */
import { describe, expect, it } from "vitest";

import { createGoManager } from "./go.js";

const manager = createGoManager();

// ── parse: basic discovery ───────────────────────────────────────────────

describe("go parse", () => {
  it("discovers single-line require directives", () => {
    const content = `
module github.com/owner/repo

go 1.21

require github.com/foo/bar v1.2.3
`;

    const result = manager.parse("go.mod", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("github.com/foo/bar");
    expect(result.dependencies[0]?.constraint).toBe("1.2.3");
    expect(result.dependencies[0]?.currentVersion).toBe("1.2.3");
    expect(result.dependencies[0]?.ecosystem).toBe("go");
  });

  it("discovers require block form", () => {
    const content = `
module github.com/owner/repo

go 1.21

require (
    github.com/foo/bar v1.2.3
    golang.org/x/text v0.13.0
)
`;

    const result = manager.parse("go.mod", content, null);
    expect(result.dependencies).toHaveLength(2);
  });

  it("marks indirect dependencies as dev", () => {
    const content = `
require (
    github.com/foo/bar v1.2.3 // indirect
    github.com/baz/qux v2.0.0
)
`;

    const result = manager.parse("go.mod", content, null);
    const indirect = result.dependencies.find((d) => d.name === "github.com/foo/bar");
    const direct = result.dependencies.find((d) => d.name === "github.com/baz/qux");
    expect(indirect?.dev).toBe(true);
    expect(direct?.dev).toBe(false);
  });

  it("strips v prefix and +incompatible from versions", () => {
    const content = `
require github.com/foo/bar v2.5.0+incompatible
`;

    const result = manager.parse("go.mod", content, null);
    expect(result.dependencies[0]?.constraint).toBe("2.5.0");
    expect(result.dependencies[0]?.currentVersion).toBe("2.5.0");
  });

  it("resolves from go.sum lockfile", () => {
    const content = `
require github.com/foo/bar v1.2.3
`;

    const goSum = `github.com/foo/bar v1.2.3 h1:abcdef123456
github.com/foo/bar v1.2.3/go.mod h1:fedcba654321
`;

    const result = manager.parse("go.mod", content, goSum);
    expect(result.dependencies[0]?.currentVersion).toBe("1.2.3");
  });

  it("resolves locked version that differs from go.mod", () => {
    const content = `
require github.com/foo/bar v1.2.0
`;

    const goSum = `github.com/foo/bar v1.2.3 h1:abcdef123456
`;

    const result = manager.parse("go.mod", content, goSum);
    // go.mod says v1.2.0, but go.sum has v1.2.3 as the resolved version
    expect(result.dependencies[0]?.currentVersion).toBe("1.2.3");
    // Constraint is what go.mod says
    expect(result.dependencies[0]?.constraint).toBe("1.2.0");
  });

  it("marks partial when go.sum is present but cannot be parsed", () => {
    const content = `require github.com/foo/bar v1.2.3\n`;
    const result = manager.parse("go.mod", content, "invalid go.sum content");
    expect(result.partial).toBe(true);
  });

  it("skips comments", () => {
    const content = `
// This is a comment
require github.com/foo/bar v1.2.3
`;

    const result = manager.parse("go.mod", content, null);
    expect(result.dependencies).toHaveLength(1);
  });
});

// ── applyUpdate ──────────────────────────────────────────────────────────

describe("go applyUpdate", () => {
  const baseProposal = {
    releases: [] as const,
    securityAdvisory: null,
    risk: {
      facts: {
        updateType: "patch" as const,
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
    evidence: [] as const,
    edits: [] as const,
    groupName: null,
  };

  it("updates a single-line require directive", () => {
    const content = `require github.com/foo/bar v1.2.3\n`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "go",
        name: "github.com/foo/bar",
        constraint: "1.2.3",
        currentVersion: "1.2.3",
        manifestPath: "go.mod",
        dev: false,
        manager: "go",
      },
      currentVersion: "1.2.3",
      targetVersion: "1.2.4",
      updateType: "patch",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("v1.2.4");
    expect(result).not.toContain("v1.2.3");
  });

  it("updates within a require block", () => {
    const content = `
require (
    github.com/foo/bar v1.2.3
    golang.org/x/text v0.13.0
)
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "go",
        name: "github.com/foo/bar",
        constraint: "1.2.3",
        currentVersion: "1.2.3",
        manifestPath: "go.mod",
        dev: false,
        manager: "go",
      },
      currentVersion: "1.2.3",
      targetVersion: "1.3.0",
      updateType: "minor",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("github.com/foo/bar v1.3.0");
    expect(result).toContain("golang.org/x/text v0.13.0"); // untouched
  });

  it("preserves // indirect comment", () => {
    const content = `require github.com/foo/bar v1.2.3 // indirect\n`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "go",
        name: "github.com/foo/bar",
        constraint: "1.2.3",
        currentVersion: "1.2.3",
        manifestPath: "go.mod",
        dev: true,
        manager: "go",
      },
      currentVersion: "1.2.3",
      targetVersion: "1.2.4",
      updateType: "patch",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("// indirect");
    expect(result).toContain("v1.2.4");
  });

  it("returns null when the module is not found", () => {
    const content = `require github.com/foo/bar v1.2.3\n`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "go",
        name: "github.com/other/mod",
        constraint: "1.0.0",
        currentVersion: "1.0.0",
        manifestPath: "go.mod",
        dev: false,
        manager: "go",
      },
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      updateType: "minor",
    });

    expect(result).toBeNull();
  });
});
