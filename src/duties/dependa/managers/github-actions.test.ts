/**
 * Tests for the GitHub Actions manager — dependency discovery from workflow YAML.
 *
 * The GitHub Actions manager is deterministic: same content in, same result out.
 * Tests cover workflow file detection, uses: line parsing, SHA detection,
 * and applyUpdate for both tag and SHA references.
 */
import { describe, expect, it } from "vitest";

import { createGithubActionsManager } from "./github-actions.js";
import { isWorkflowFile } from "./github-actions.js";

const manager = createGithubActionsManager();

// ── isWorkflowFile ───────────────────────────────────────────────────────

describe("isWorkflowFile", () => {
  it("matches .yml files under .github/workflows/", () => {
    expect(isWorkflowFile(".github/workflows/ci.yml")).toBe(true);
  });

  it("matches .yaml files under .github/workflows/", () => {
    expect(isWorkflowFile(".github/workflows/deploy.yaml")).toBe(true);
  });

  it("matches files in nested workflow directories", () => {
    expect(isWorkflowFile(".github/workflows/subdir/ci.yml")).toBe(true);
  });

  it("rejects files outside .github/workflows/", () => {
    expect(isWorkflowFile("ci.yml")).toBe(false);
    expect(isWorkflowFile("src/workflows/ci.yml")).toBe(false);
  });

  it("rejects non-YAML files", () => {
    expect(isWorkflowFile(".github/workflows/ci.json")).toBe(false);
  });
});

// ── parse: basic discovery ───────────────────────────────────────────────

describe("github-actions parse", () => {
  it("discovers actions/checkout@v4", () => {
    const content = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("actions/checkout");
    expect(result.dependencies[0]?.constraint).toBe("v4");
    expect(result.dependencies[0]?.currentVersion).toBe("v4");
    expect(result.dependencies[0]?.dev).toBe(false);
    expect(result.dependencies[0]?.ecosystem).toBe("github-actions");
  });

  it("discovers SHA references", () => {
    const sha = "a81bbbf8298c0fa03ea29cdc473d45769f953675";
    const content = `
jobs:
  build:
    steps:
      - uses: actions/checkout@${sha}
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("actions/checkout");
    expect(result.dependencies[0]?.constraint).toBeNull(); // SHA = no constraint
    expect(result.dependencies[0]?.currentVersion).toBe(sha);
  });

  it("handles double-quoted uses values", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: "actions/checkout@v4"
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("actions/checkout");
    expect(result.dependencies[0]?.constraint).toBe("v4");
  });

  it("handles single-quoted uses values", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: 'actions/checkout@v4'
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("actions/checkout");
    expect(result.dependencies[0]?.constraint).toBe("v4");
  });

  it("deduplicates same action@ref in the same file", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v3
      - uses: actions/checkout@v4
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    // actions/checkout@v4 appears twice but should be deduplicated
    const checkouts = result.dependencies.filter((d) => d.name === "actions/checkout");
    expect(checkouts).toHaveLength(1);
  });

  it("allows same action with different refs", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: actions/checkout@v3
      - uses: actions/checkout@v4
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(2);
  });

  it("skips local actions (./ prefix)", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: ./.github/actions/setup
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(0);
  });

  it("skips docker actions", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: docker://alpine:3.8
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(0);
  });

  it("discovers reusable workflow references with paths", () => {
    // Reusable workflows use: org/repo/.github/workflows/ci.yml@ref
    const content = `
jobs:
  build:
    uses: octo-org/example-repo/.github/workflows/ci.yml@v1
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("octo-org/example-repo/.github/workflows/ci.yml");
    expect(result.dependencies[0]?.constraint).toBe("v1");
    expect(result.dependencies[0]?.currentVersion).toBe("v1");
  });

  it("discovers reusable workflow with SHA reference", () => {
    const sha = "a81bbbf8298c0fa03ea29cdc473d45769f953675";
    const content = `
jobs:
  build:
    uses: octo-org/example-repo/.github/workflows/ci.yml@${sha}
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("octo-org/example-repo/.github/workflows/ci.yml");
    expect(result.dependencies[0]?.constraint).toBeNull(); // SHA = no constraint
    expect(result.dependencies[0]?.currentVersion).toBe(sha);
  });

  it("deduplicates regular action and reusable workflow with same owner", () => {
    // Same owner, different refs — should not deduplicate
    const content = `
jobs:
  build:
    uses: actions/checkout@v4
  test:
    uses: actions/example-repo/.github/workflows/ci.yml@v1
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    // Two different dependencies: actions/checkout and actions/example-repo/.github/workflows/ci.yml
    expect(result.dependencies).toHaveLength(2);
  });

  it("handles list marker prefix (- uses:)", () => {
    const content = `
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(2);
  });

  it("handles indented uses: lines", () => {
    const content = `
jobs:
  build:
    steps:
        -   uses: actions/checkout@v4
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(1);
  });

  it("returns empty for a workflow with no uses: lines", () => {
    const content = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "hello"
`;

    const result = manager.parse(".github/workflows/ci.yml", content, null);
    expect(result.dependencies).toHaveLength(0);
  });
});

// ── applyUpdate ──────────────────────────────────────────────────────────

describe("github-actions applyUpdate", () => {
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

  it("updates a tag reference", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: actions/checkout@v3
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: "v3",
        currentVersion: "v3",
        manifestPath: ".github/workflows/ci.yml",
        dev: false,
        manager: "github-actions",
      },
      currentVersion: "v3",
      targetVersion: "v4",
      updateType: "minor",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("actions/checkout@v4");
    expect(result).not.toContain("actions/checkout@v3");
  });

  it("updates a SHA reference", () => {
    const oldSha = "a81bbbf8298c0fa03ea29cdc473d45769f953675";
    const newSha = "b92bbbf8298c0fa03ea29cdc473d45769f953676";
    const content = `
jobs:
  build:
    steps:
      - uses: actions/checkout@${oldSha}
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: null,
        currentVersion: oldSha,
        manifestPath: ".github/workflows/ci.yml",
        dev: false,
        manager: "github-actions",
      },
      currentVersion: oldSha,
      targetVersion: newSha,
      updateType: "digest",
    });

    expect(result).not.toBeNull();
    expect(result).toContain(`actions/checkout@${newSha}`);
  });

  it("only replaces within uses: lines (not comments)", () => {
    const content = `
jobs:
  build:
    steps:
      # Pin actions/checkout@v3 for stability
      - uses: actions/checkout@v3
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: "v3",
        currentVersion: "v3",
        manifestPath: ".github/workflows/ci.yml",
        dev: false,
        manager: "github-actions",
      },
      currentVersion: "v3",
      targetVersion: "v4",
      updateType: "minor",
    });

    expect(result).not.toBeNull();
    // The comment should still say v3, the uses: line should say v4
    expect(result).toContain("# Pin actions/checkout@v3 for stability");
    expect(result).toContain("uses: actions/checkout@v4");
  });

  it("returns null when the old reference is not found", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: actions/setup-node@v3
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "github-actions",
        name: "actions/checkout",
        constraint: "v3",
        currentVersion: "v3",
        manifestPath: ".github/workflows/ci.yml",
        dev: false,
        manager: "github-actions",
      },
      currentVersion: "v3",
      targetVersion: "v4",
      updateType: "minor",
    });

    expect(result).toBeNull();
  });

  it("updates a reusable workflow tag reference", () => {
    const content = `
jobs:
  build:
    uses: octo-org/example-repo/.github/workflows/ci.yml@v1
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "github-actions",
        name: "octo-org/example-repo/.github/workflows/ci.yml",
        constraint: "v1",
        currentVersion: "v1",
        manifestPath: ".github/workflows/ci.yml",
        dev: false,
        manager: "github-actions",
      },
      currentVersion: "v1",
      targetVersion: "v2",
      updateType: "minor",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("octo-org/example-repo/.github/workflows/ci.yml@v2");
    expect(result).not.toContain("@v1");
  });
});
