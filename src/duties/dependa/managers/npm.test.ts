/**
 * Tests for the npm manager — dependency discovery from package.json.
 *
 * The npm manager is deterministic: same content in, same result out.
 * These tests cover parsing of dependencies, devDependencies, optionalDependencies,
 * peerDependencies, constraint resolution (including aliases and workspace protocols),
 * lockfile resolution, and applyUpdate.
 */
import { describe, expect, it } from "vitest";

import { createNpmManager } from "./npm.js";

const manager = createNpmManager();

// ── parse: basic sections ────────────────────────────────────────────────

describe("npm parse", () => {
  it("discovers dependencies", () => {
    const content = JSON.stringify({
      dependencies: { lodash: "^4.17.21" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("lodash");
    expect(result.dependencies[0]?.constraint).toBe("^4.17.21");
    expect(result.dependencies[0]?.dev).toBe(false);
    expect(result.dependencies[0]?.ecosystem).toBe("npm");
    expect(result.partial).toBe(false);
  });

  it("discovers devDependencies", () => {
    const content = JSON.stringify({
      devDependencies: { jest: "^29.0.0" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.dev).toBe(true);
  });

  it("discovers optionalDependencies", () => {
    const content = JSON.stringify({
      optionalDependencies: { fsevents: "^2.0.0" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.dev).toBe(false);
  });

  it("discovers peerDependencies", () => {
    const content = JSON.stringify({
      peerDependencies: { react: ">=17.0.0" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.dev).toBe(false);
  });

  it("discovers dependencies from multiple sections", () => {
    const content = JSON.stringify({
      dependencies: { lodash: "^4.0.0" },
      devDependencies: { jest: "^29.0.0" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(2);
  });

  it("returns empty for malformed JSON", () => {
    const result = manager.parse("package.json", "not json", null);
    expect(result.dependencies).toHaveLength(0);
    expect(result.partial).toBe(true);
  });

  it("returns empty for a package.json with no dependency sections", () => {
    const content = JSON.stringify({ name: "my-app", version: "1.0.0" });
    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(0);
  });
});

// ── parse: constraint resolution ─────────────────────────────────────────

describe("npm parse: constraint resolution", () => {
  it("resolves npm aliases", () => {
    const content = JSON.stringify({
      dependencies: { mylodash: "npm:lodash@^4.17.21" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("lodash");
    expect(result.dependencies[0]?.constraint).toBe("^4.17.21");
  });

  it("skips workspace protocol", () => {
    const content = JSON.stringify({
      dependencies: { "my-lib": "workspace:*" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBeNull();
  });

  it("skips link protocol", () => {
    const content = JSON.stringify({
      dependencies: { "my-lib": "link:../my-lib" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBeNull();
  });

  it("skips file protocol", () => {
    const content = JSON.stringify({
      dependencies: { "local-pkg": "file:./local" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBeNull();
  });

  it("skips GitHub shorthand", () => {
    const content = JSON.stringify({
      dependencies: { "my-repo": "owner/repo" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBeNull();
  });
});

// ── parse: currentVersion resolution ─────────────────────────────────────

describe("npm parse: currentVersion", () => {
  it("extracts pinned version from exact constraint when no lockfile", () => {
    const content = JSON.stringify({
      dependencies: { lodash: "4.17.21" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies[0]?.currentVersion).toBe("4.17.21");
  });

  it("uses empty string for range constraint when no lockfile", () => {
    const content = JSON.stringify({
      dependencies: { lodash: "^4.17.21" },
    });

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies[0]?.currentVersion).toBe("");
  });

  it("resolves from lockfile (package-lock.json v2)", () => {
    const content = JSON.stringify({
      dependencies: { lodash: "^4.0.0" },
    });

    const lockfile = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/lodash": { version: "4.17.21" },
      },
    });

    const result = manager.parse("package.json", content, lockfile);
    expect(result.dependencies[0]?.currentVersion).toBe("4.17.21");
  });

  it("resolves from lockfile (package-lock.json v1)", () => {
    const content = JSON.stringify({
      dependencies: { lodash: "^4.0.0" },
    });

    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.21" },
      },
    });

    const result = manager.parse("package.json", content, lockfile);
    expect(result.dependencies[0]?.currentVersion).toBe("4.17.21");
  });

  it("marks partial when lockfile is present but cannot be parsed", () => {
    const content = JSON.stringify({ dependencies: { lodash: "^4.0.0" } });
    const result = manager.parse("package.json", content, "not a valid lockfile format");
    expect(result.partial).toBe(true);
  });
});

// ── applyUpdate ──────────────────────────────────────────────────────────

describe("npm applyUpdate", () => {
  it("updates a caret constraint", () => {
    const content = JSON.stringify({ dependencies: { lodash: "^4.17.21" } }, null, 2) + "\n";

    const result = manager.applyUpdate(content, {
      dependency: {
        ecosystem: "npm",
        name: "lodash",
        constraint: "^4.17.21",
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
    });

    expect(result).not.toBeNull();
    const updated = JSON.parse(result!) as Record<string, unknown>;
    const deps = updated.dependencies as Record<string, string>;
    expect(deps.lodash).toBe("^4.17.22");
  });

  it("updates a tilde constraint", () => {
    const content = JSON.stringify({ dependencies: { lodash: "~4.17.21" } }, null, 2) + "\n";

    const result = manager.applyUpdate(content, {
      dependency: {
        ecosystem: "npm",
        name: "lodash",
        constraint: "~4.17.21",
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
    });

    expect(result).not.toBeNull();
    const updated = JSON.parse(result!) as Record<string, unknown>;
    const deps = updated.dependencies as Record<string, string>;
    expect(deps.lodash).toBe("~4.17.22");
  });

  it("updates an exact version", () => {
    const content = JSON.stringify({ dependencies: { lodash: "4.17.21" } }, null, 2) + "\n";

    const result = manager.applyUpdate(content, {
      dependency: {
        ecosystem: "npm",
        name: "lodash",
        constraint: "4.17.21",
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
    });

    expect(result).not.toBeNull();
    const updated = JSON.parse(result!) as Record<string, unknown>;
    const deps = updated.dependencies as Record<string, string>;
    expect(deps.lodash).toBe("4.17.22");
  });

  it("returns null for workspace constraints", () => {
    const content = JSON.stringify({ dependencies: { "my-lib": "workspace:*" } }, null, 2) + "\n";

    const result = manager.applyUpdate(content, {
      dependency: {
        ecosystem: "npm",
        name: "my-lib",
        constraint: null,
        currentVersion: "",
        manifestPath: "package.json",
        dev: false,
        manager: "npm",
      },
      currentVersion: "",
      targetVersion: "1.0.0",
      updateType: "patch",
      releases: [],
      securityAdvisory: null,
      risk: {
        facts: {
          updateType: "patch",
          majorDistance: 0,
          minorDistance: 0,
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
    });

    expect(result).toBeNull();
  });

  it("returns null when dependency is not found in any section", () => {
    const content = JSON.stringify({ dependencies: { express: "^4.0.0" } }, null, 2) + "\n";

    const result = manager.applyUpdate(content, {
      dependency: {
        ecosystem: "npm",
        name: "nonexistent",
        constraint: "^1.0.0",
        currentVersion: "1.0.0",
        manifestPath: "package.json",
        dev: false,
        manager: "npm",
      },
      currentVersion: "1.0.0",
      targetVersion: "1.0.1",
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
    });

    expect(result).toBeNull();
  });
});
