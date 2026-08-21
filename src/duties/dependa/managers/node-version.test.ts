/**
 * Tests for the node-version manager — the Node runtime pin in
 * `.node-version` and `.nvmrc`.
 *
 * Deterministic: same content in, same result out. Tests cover discovery of
 * full pins, major-only pins, nvm's `v` prefix and aliases, and applyUpdate's
 * refusal to rewrite anything that is not a full `x.y.z` pin.
 */
import { describe, expect, it } from "vitest";

import type { UpdateProposal } from "../model.js";
import { createNodeVersionManager } from "./node-version.js";

const manager = createNodeVersionManager();

function proposal(currentVersion: string, targetVersion: string): UpdateProposal {
  return {
    dependency: {
      ecosystem: "node-version",
      name: "node",
      constraint: currentVersion,
      currentVersion,
      manifestPath: ".node-version",
      dev: false,
      manager: "node-version",
    },
    currentVersion,
    targetVersion,
    updateType: "minor",
    releases: [],
    securityAdvisory: null,
    risk: {
      facts: {
        updateType: "minor",
        majorDistance: 0,
        minorDistance: 1,
        patchDistance: 0,
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
  };
}

// ── parse ────────────────────────────────────────────────────────────────

describe("node-version parse", () => {
  it("discovers a full pin", () => {
    const result = manager.parse(".node-version", "24.1.0\n", null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("node");
    expect(result.dependencies[0]?.ecosystem).toBe("node-version");
    expect(result.dependencies[0]?.constraint).toBe("24.1.0");
    expect(result.dependencies[0]?.currentVersion).toBe("24.1.0");
  });

  it("discovers a major-only pin with no resolved version", () => {
    const result = manager.parse(".node-version", "24\n", null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBe("24");
    expect(result.dependencies[0]?.currentVersion).toBe("");
  });

  it("strips nvm's v prefix", () => {
    const result = manager.parse(".nvmrc", "v24.1.0\n", null);
    expect(result.dependencies[0]?.constraint).toBe("24.1.0");
    expect(result.dependencies[0]?.currentVersion).toBe("24.1.0");
  });

  it("discovers an nvm alias without a resolved version", () => {
    const result = manager.parse(".nvmrc", "lts/*\n", null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBe("lts/*");
    expect(result.dependencies[0]?.currentVersion).toBe("");
  });

  it("skips comments and blank lines", () => {
    const result = manager.parse(".nvmrc", "# pinned for CI\n\n24.1.0\n", null);
    expect(result.dependencies[0]?.constraint).toBe("24.1.0");
  });

  it("discovers nothing from an empty file", () => {
    const result = manager.parse(".node-version", "\n", null);
    expect(result.dependencies).toHaveLength(0);
  });
});

// ── applyUpdate ──────────────────────────────────────────────────────────

describe("node-version applyUpdate", () => {
  it("rewrites a full pin preserving the trailing newline", () => {
    const updated = manager.applyUpdate("24.1.0\n", proposal("24.1.0", "24.2.0"));
    expect(updated).toBe("24.2.0\n");
  });

  it("preserves the v prefix", () => {
    const updated = manager.applyUpdate("v24.1.0\n", proposal("24.1.0", "24.2.0"));
    expect(updated).toBe("v24.2.0\n");
  });

  it("preserves comment lines", () => {
    const updated = manager.applyUpdate("# pinned\n24.1.0\n", proposal("24.1.0", "24.2.0"));
    expect(updated).toBe("# pinned\n24.2.0\n");
  });

  it("refuses to rewrite a major-only pin", () => {
    expect(manager.applyUpdate("24\n", proposal("24", "25"))).toBeNull();
  });

  it("refuses to rewrite an nvm alias", () => {
    expect(manager.applyUpdate("lts/*\n", proposal("lts/*", "24.2.0"))).toBeNull();
  });

  it("refuses when the current version does not match the file", () => {
    expect(manager.applyUpdate("24.1.0\n", proposal("22.0.0", "24.2.0"))).toBeNull();
  });
});
