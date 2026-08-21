/**
 * Tests for the npm manager — dependency discovery from package.json.
 *
 * The npm manager is deterministic: same content in, same result out.
 * These tests cover parsing of dependencies, devDependencies, optionalDependencies,
 * peerDependencies, constraint resolution (including aliases and workspace protocols),
 * lockfile resolution, and applyUpdate.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../semver.js";

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

  it("updates npm alias constraints correctly", () => {
    const content =
      JSON.stringify(
        {
          dependencies: { mylodash: "npm:lodash@^4.17.21" },
        },
        null,
        2,
      ) + "\n";

    const result = manager.applyUpdate(content, {
      dependency: {
        ecosystem: "npm",
        name: "lodash", // resolved name, not the alias key
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
    const parsed = JSON.parse(result!) as Record<string, unknown>;
    const deps = parsed.dependencies as Record<string, string> | undefined;
    // The alias key should be preserved, version updated within the alias
    expect(deps?.mylodash).toBe("npm:lodash@^4.17.22");
  });

  it("updates dependency in all sections where it appears", () => {
    // When a package appears in both dependencies and peerDependencies,
    // both sections must be updated — not just the first one found.
    const content =
      JSON.stringify(
        {
          dependencies: { lodash: "^4.17.21" },
          peerDependencies: { lodash: "^4.17.21" },
        },
        null,
        2,
      ) + "\n";

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
    const parsed = JSON.parse(result!) as Record<string, unknown>;
    const deps = parsed.dependencies as Record<string, string> | undefined;
    const peers = parsed.peerDependencies as Record<string, string> | undefined;
    expect(deps?.lodash).toBe("^4.17.22");
    expect(peers?.lodash).toBe("^4.17.22");
  });
});

// ── applyUpdate: indentation preservation ──────────────────────────────────

describe("npm applyUpdate — indentation preservation", () => {
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

  it("preserves 2-space indentation", () => {
    const content =
      JSON.stringify({ name: "test", dependencies: { lodash: "^4.17.21" } }, null, 2) + "\n";
    const result = manager.applyUpdate(content, {
      ...baseProposal,
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
    });
    expect(result).not.toBeNull();
    // Should use 2-space indent, not tabs or 4-space
    expect(result).toContain('  "lodash"');
  });

  it("preserves 4-space indentation", () => {
    const content =
      JSON.stringify({ name: "test", dependencies: { lodash: "^4.17.21" } }, null, 4) + "\n";
    const result = manager.applyUpdate(content, {
      ...baseProposal,
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
    });
    expect(result).not.toBeNull();
    // Should use 4-space indent
    expect(result).toContain('    "lodash"');
  });

  it("preserves tab indentation", () => {
    const content =
      JSON.stringify({ name: "test", dependencies: { lodash: "^4.17.21" } }, null, "\t") + "\n";
    const result = manager.applyUpdate(content, {
      ...baseProposal,
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
    });
    expect(result).not.toBeNull();
    // Should use tab indent
    expect(result).toContain('\t"lodash"');
  });

  it("preserves trailing newline", () => {
    const content =
      JSON.stringify({ name: "test", dependencies: { lodash: "^4.17.21" } }, null, 2) + "\n";
    const result = manager.applyUpdate(content, {
      ...baseProposal,
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
    });
    expect(result).not.toBeNull();
    expect(result!.endsWith("\n")).toBe(true);
  });

  it("does not add trailing newline when original lacks one", () => {
    const content = JSON.stringify({ name: "test", dependencies: { lodash: "^4.17.21" } }, null, 2);
    const result = manager.applyUpdate(content, {
      ...baseProposal,
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
    });
    expect(result).not.toBeNull();
    expect(result!.endsWith("\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lockfile resolution — the half of `parse` that turns a constraint into the
// version actually installed.
//
// `parseLockfile` (npm.ts:186) dispatches on the lockfile's own shape and
// hands off to one of two readers. The pnpm reader (`parsePnpmLockYaml`,
// npm.ts:261) had no coverage at all, and it is the one that decides what
// `currentVersion` a proposal is measured FROM — a wrong answer there proposes
// an update from a version the repository is not on.
//
// Everything below drives the real `manager.parse`, so a case is about what a
// maintainer's lockfile produces rather than about a private function's shape.
// ---------------------------------------------------------------------------

/** The resolved `currentVersion` for one dependency, given a lockfile. */
function resolved(
  lockfile: string | null,
  dependencies: Record<string, string> = { lodash: "^4.17.21" },
): { version: string; partial: boolean } {
  const result = manager.parse("package.json", JSON.stringify({ dependencies }), lockfile);
  return {
    version: result.dependencies[0]?.currentVersion ?? "",
    partial: result.partial,
  };
}

describe("npm parse: package-lock.json", () => {
  it("reads the installed version out of a v2/v3 packages map", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root" },
        "node_modules/lodash": { version: "4.17.21" },
      },
    });

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("skips the root entry, whose empty key is the project itself", () => {
    const lockfile = JSON.stringify({
      packages: { "": { version: "1.0.0" }, "node_modules/lodash": { version: "4.17.21" } },
    });

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("strips the node_modules prefix so the name matches the manifest's", () => {
    const lockfile = JSON.stringify({
      packages: { "node_modules/@types/node": { version: "20.1.0" } },
    });

    expect(resolved(lockfile, { "@types/node": "^20" }).version).toBe("20.1.0");
  });

  it("reads a v1 dependencies map, which has no node_modules prefix", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { lodash: { version: "4.17.20" } },
    });

    expect(resolved(lockfile).version).toBe("4.17.20");
  });

  it("ignores an entry whose version is not a string", () => {
    const lockfile = JSON.stringify({
      packages: {
        "node_modules/lodash": { version: 4 },
        "node_modules/other": { version: "1.0.0" },
      },
    });

    expect(resolved(lockfile).version).toBe("");
  });

  it("reports partial for a lockfile that is JSON but names no versions at all", () => {
    // A lockfile the manager could not read is a fact about the read, and
    // `partial` is how a run says so rather than reporting a confident empty.
    expect(resolved(JSON.stringify({ lockfileVersion: 3 })).partial).toBe(true);
  });

  it("reports partial for a lockfile that is not valid JSON despite starting with a brace", () => {
    expect(resolved("{ not json at all").partial).toBe(true);
  });
});

describe("npm parse: pnpm-lock.yaml", () => {
  it("reads a version out of a slash-prefixed packages entry", () => {
    const lockfile = [
      "lockfileVersion: '6.0'",
      "packages:",
      "  /lodash@4.17.21:",
      "    resolution: {integrity: sha512-abc}",
    ].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("keeps a scoped package's own slash out of the version", () => {
    const lockfile = ["lockfileVersion: '6.0'", "packages:", "  /@types/node@20.1.0:"].join("\n");

    expect(resolved(lockfile, { "@types/node": "^20" }).version).toBe("20.1.0");
  });

  it("strips a trailing parenthetical from a version with no `@` inside it", () => {
    const lockfile = ["lockfileVersion: '6.0'", "packages:", "  /lodash@4.17.21(patched):"].join(
      "\n",
    );

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  // REGRESSION — pnpm 6+ peer-resolved entries resolved to an EMPTY version.
  //
  // pnpm writes a package resolved against a peer as
  // `/lodash@4.17.21(react@18.0.0):`. `parsePnpmLockYaml`'s key pattern is
  // `/^ {2}\\/(.+)@(.+):$/` and both groups are greedy, so the split landed on
  // the LAST `@` — inside the parenthetical. The name came out as
  // `lodash@4.17.21(react` and the version as `18.0.0)`, and the
  // `cleanVersion` strip on the next line could not help because the
  // parenthesis was no longer trailing. The manifest's `lodash` then matched
  // nothing and `currentVersion` resolved to `""`.
  //
  // What that cost is pinned in `semver.test.ts`: `classify("")` returns null,
  // so `main.ts:328` logs at `core.info` and skips the candidate. Every
  // peer-resolved dependency in a pnpm repository was dropped from dependency
  // maintenance entirely and silently, security updates included.
  //
  // The fix strips the parenthetical BEFORE the split rather than after, which
  // is what the code's own comment always said it meant to do.
  it("resolves a pnpm peer-suffixed entry to the version before the parenthesis", () => {
    const lockfile = [
      "lockfileVersion: '6.0'",
      "packages:",
      "  /lodash@4.17.21(react@18.0.0):",
    ].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("resolves a peer-suffixed entry carrying several peers", () => {
    const lockfile = [
      "lockfileVersion: '6.0'",
      "packages:",
      "  /lodash@4.17.21(react@18.0.0)(react-dom@18.0.0):",
    ].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("resolves a scoped package that is also peer-resolved", () => {
    const lockfile = [
      "lockfileVersion: '6.0'",
      "packages:",
      "  /@testing-library/react@14.0.0(react@18.0.0):",
    ].join("\n");

    expect(resolved(lockfile, { "@testing-library/react": "^14" }).version).toBe("14.0.0");
  });

  it("reports a peer-resolved dependency as a real read rather than a partial one", () => {
    // `partial` is how a run says "a lockfile was there and I could not read
    // it". A peer-resolved entry is readable, and reporting otherwise made
    // every pnpm run look degraded.
    const lockfile = [
      "lockfileVersion: '6.0'",
      "packages:",
      "  /lodash@4.17.21(react@18.0.0):",
    ].join("\n");

    expect(resolved(lockfile).partial).toBe(false);
  });

  it("leaves a version with a legitimate `@` in its own text alone", () => {
    // The strip must only remove a TRAILING parenthetical before the colon,
    // never reach into the id.
    const lockfile = ["lockfileVersion: '6.0'", "packages:", "  /lodash@4.17.21:"].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("reads a version out of an importers entry", () => {
    const lockfile = ["lockfileVersion: '6.0'", "importers:", "  .:", "    lodash: 4.17.21"].join(
      "\n",
    );

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("recognises a lockfile that opens with a comment rather than a version key", () => {
    const lockfile = ["# yarn lockfile v1", "packages:", "  /lodash@4.17.21:"].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("recognises a lockfile identified only by its specifiers block", () => {
    const lockfile = ["importers:", "  .:", "    specifiers:", "      lodash: ^4.17.21"].join("\n");

    // The specifiers block names constraints, not resolved versions, so this
    // resolves nothing — but it is recognised as a lockfile rather than
    // reported unreadable.
    expect(resolved(lockfile).partial).toBe(true);
  });

  it("stops reading at the next top-level key after the packages block", () => {
    const lockfile = [
      "lockfileVersion: '6.0'",
      "packages:",
      "  /lodash@4.17.21:",
      "settings:",
      "  /lodash@9.9.9:",
    ].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("ignores a packages entry naming no version", () => {
    const lockfile = ["lockfileVersion: '6.0'", "packages:", "  /lodash@:"].join("\n");

    expect(resolved(lockfile).partial).toBe(true);
  });

  it("reports partial for a pnpm lockfile that resolved nothing", () => {
    expect(resolved("lockfileVersion: '6.0'\npackages:\n").partial).toBe(true);
  });

  it("reports partial for content that is neither JSON nor a recognised lockfile", () => {
    expect(resolved("just some prose\nand another line").partial).toBe(true);
  });

  it("reads a v5 packages key, where the version follows a slash rather than an @", () => {
    const lockfile = ["lockfileVersion: 5.4", "packages:", "  /lodash/4.17.21:"].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("reads a v5 scoped packages key without splitting inside the scope", () => {
    const lockfile = ["lockfileVersion: 5.4", "packages:", "  /@types/node/20.1.0:"].join("\n");

    expect(resolved(lockfile, { "@types/node": "^20" }).version).toBe("20.1.0");
  });
});

// ---------------------------------------------------------------------------
// REGRESSION — pnpm lockfileVersion 9.0 (pnpm 9/10) resolved NOTHING.
//
// v9 changed both shapes the old line-oriented parser matched on. `packages`
// keys dropped their leading slash (`'lodash@4.17.21':` instead of
// `/lodash@4.17.21:`), so the `/^ {2}\/…/` pattern matched no key at all. And
// importers entries became `{specifier, version}` objects, whose `version:`
// sub-line the importers scan then matched AS a package — a package named
// `version`. Every real dependency came out with `currentVersion: ""`, and
// `classify("")` returns null, so every npm dependency in a pnpm 9/10
// repository — this one included — was silently dropped from maintenance.
//
// The fix parses the lockfile with the `yaml` library and reads shapes by
// structure rather than by line: these cases pin each v9 shape, and the last
// pins the `version`-as-a-package confusion closed.
// ---------------------------------------------------------------------------

describe("npm parse: pnpm-lock.yaml v9", () => {
  it("reads a version out of a bare name@version packages key", () => {
    const lockfile = ["lockfileVersion: '9.0'", "packages:", "  'lodash@4.17.21':"].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("keeps a scoped package's leading @ out of the split", () => {
    const lockfile = ["lockfileVersion: '9.0'", "packages:", "  '@types/node@20.1.0':"].join("\n");

    expect(resolved(lockfile, { "@types/node": "^20" }).version).toBe("20.1.0");
  });

  it("reads a version out of an importers {specifier, version} entry", () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      lodash:",
      "        specifier: ^4.17.0",
      "        version: 4.17.21",
    ].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("strips the peer suffixes a v9 importers resolution carries", () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    devDependencies:",
      "      '@commitlint/cli':",
      "        specifier: ^21.2.1",
      "        version: 21.2.1(@types/node@26.2.0)(typescript@5.9.3)",
    ].join("\n");

    expect(resolved(lockfile, { "@commitlint/cli": "^21" }).version).toBe("21.2.1");
  });

  it("never mistakes the specifier for the resolution", () => {
    // The specifier is the manifest's constraint echoed back. Reading it as
    // the installed version would measure every update from a range.
    const lockfile = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      lodash:",
      "        specifier: ^4.17.0",
      "        version: 4.17.21",
    ].join("\n");

    expect(resolved(lockfile).version).not.toBe("^4.17.0");
  });

  it("prefers the importer's resolution over a packages key naming another version", () => {
    // `packages` holds every version any consumer installed; the importer
    // names the one THIS manifest resolved to. When they disagree, the
    // importer is the answer — the packages key belongs to someone else's
    // dependency tree.
    const lockfile = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      lodash:",
      "        specifier: ^4.17.0",
      "        version: 4.17.21",
      "packages:",
      "  'lodash@3.10.1':",
      "  'lodash@4.17.21':",
    ].join("\n");

    expect(resolved(lockfile).version).toBe("4.17.21");
  });

  it("skips a workspace link rather than reporting it as a version", () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      my-local:",
      "        specifier: workspace:*",
      "        version: link:../my-local",
    ].join("\n");

    expect(resolved(lockfile, { "my-local": "workspace:*" }).version).toBe("");
  });

  it("does not resolve a dependency named `version` from an importers sub-line", () => {
    // The old importers scan matched `version: 4.17.21` sub-lines as a
    // package named `version` — so a manifest that really depends on the npm
    // package `version` would have resolved to some OTHER dependency's
    // number.
    const lockfile = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      lodash:",
      "        specifier: ^4.17.0",
      "        version: 4.17.21",
    ].join("\n");

    expect(resolved(lockfile, { version: "^1.0.0" }).version).toBe("");
  });

  it("resolves a full v9 lockfile shaped like this repository's own", () => {
    // The dogfood witness: settings, importers with peer-suffixed
    // resolutions, packages, and snapshots — the sections a real pnpm 9/10
    // lockfile carries, in the order pnpm writes them.
    const lockfile = [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      '@actions/core':",
      "        specifier: ^3.0.1",
      "        version: 3.0.1",
      "    devDependencies:",
      "      typescript:",
      "        specifier: ^5.9.3",
      "        version: 5.9.3",
      "",
      "packages:",
      "",
      "  '@actions/core@3.0.1':",
      "    resolution: {integrity: sha512-abc}",
      "",
      "  typescript@5.9.3:",
      "    resolution: {integrity: sha512-def}",
      "",
      "snapshots:",
      "",
      "  '@actions/core@3.0.1': {}",
    ].join("\n");

    expect(resolved(lockfile, { "@actions/core": "^3.0.1" }).version).toBe("3.0.1");
    expect(resolved(lockfile, { typescript: "^5.9.3" }).version).toBe("5.9.3");
    expect(resolved(lockfile).partial).toBe(false);
  });
});

describe("a peer-resolved dependency flows all the way to a classification", () => {
  // The other end of the regression. Pinning the parse alone would leave the
  // fix looking correct while the dependency was still dropped downstream, so
  // this walks the same lockfile through to the decision that was being lost:
  // `classify(currentVersion, target)`, which returned null for every
  // peer-resolved package and skipped it at `main.ts:328`.
  const PEER_LOCKFILE = [
    "lockfileVersion: '6.0'",
    "packages:",
    "  /lodash@4.17.21(react@18.0.0):",
  ].join("\n");

  it("yields a current version a patch update can be measured from", () => {
    const { version } = resolved(PEER_LOCKFILE);

    expect(version).toBe("4.17.21");
    expect(classify(version, "4.17.22", false)).toBe("patch");
  });

  it("yields a current version a security update can be measured from", () => {
    // The case the defect cost most: `classify` returns null before it reaches
    // the `isSecurity` override, so a peer-resolved package with an advisory
    // against it was skipped as silently as any other.
    const { version } = resolved(PEER_LOCKFILE);

    expect(classify(version, "4.17.22", true)).toBe("security");
  });

  it("yields a current version a major update can be measured from", () => {
    const { version } = resolved(PEER_LOCKFILE);

    expect(classify(version, "5.0.0", false)).toBe("major");
  });

  it("skips a candidate identical to the resolved version rather than proposing a no-op", () => {
    const { version } = resolved(PEER_LOCKFILE);

    expect(classify(version, "4.17.21", false)).toBeNull();
  });
});

describe("npm parse: without a lockfile", () => {
  it("resolves no current version and does not report a partial read", () => {
    // No lockfile is not a failed read: a repository may simply not commit
    // one, and reporting `partial` would make every such run look degraded.
    const result = resolved(null);

    expect(result.version).toBe("");
    expect(result.partial).toBe(false);
  });
});

// ── parse: packageManager and engines ──────────────────────────────────────

describe("npm parse: packageManager", () => {
  it("discovers the pinned package manager", () => {
    const content = JSON.stringify({ packageManager: "pnpm@11.20.0" }, null, 2);

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("pnpm");
    expect(result.dependencies[0]?.ecosystem).toBe("npm");
    expect(result.dependencies[0]?.constraint).toBe("11.20.0");
    expect(result.dependencies[0]?.currentVersion).toBe("11.20.0");
    expect(result.dependencies[0]?.dev).toBe(true);
  });

  it("strips the corepack integrity hash", () => {
    const content = JSON.stringify({ packageManager: "pnpm@11.20.0+sha512.abcdef" }, null, 2);

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies[0]?.currentVersion).toBe("11.20.0");
  });

  it("skips a packageManager without an exact version", () => {
    const content = JSON.stringify({ packageManager: "pnpm" }, null, 2);

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(0);
  });
});

describe("npm parse: engines", () => {
  it("discovers node under the node-version ecosystem", () => {
    const content = JSON.stringify({ engines: { node: ">=24" } }, null, 2);

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("node");
    expect(result.dependencies[0]?.ecosystem).toBe("node-version");
    expect(result.dependencies[0]?.constraint).toBe(">=24");
    expect(result.dependencies[0]?.currentVersion).toBe("");
  });

  it("discovers pnpm under the npm ecosystem", () => {
    const content = JSON.stringify({ engines: { pnpm: ">=11" } }, null, 2);

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies[0]?.name).toBe("pnpm");
    expect(result.dependencies[0]?.ecosystem).toBe("npm");
    expect(result.dependencies[0]?.constraint).toBe(">=11");
  });

  it("skips empty and non-string entries", () => {
    const content = JSON.stringify({ engines: { node: "", weird: 42 } }, null, 2);

    const result = manager.parse("package.json", content, null);
    expect(result.dependencies).toHaveLength(0);
  });
});

describe("npm applyUpdate: packageManager", () => {
  const pmProposal = (currentVersion: string, targetVersion: string) => ({
    dependency: {
      ecosystem: "npm" as const,
      name: "pnpm",
      constraint: currentVersion,
      currentVersion,
      manifestPath: "package.json",
      dev: true,
      manager: "npm",
    },
    currentVersion,
    targetVersion,
    updateType: "minor" as const,
    releases: [],
    securityAdvisory: null,
    risk: {
      facts: {
        updateType: "minor" as const,
        majorDistance: 0,
        minorDistance: 1,
        patchDistance: 0,
        daysBetweenReleases: null,
        currentVersionStale: null,
        isSecurity: false,
        hasChangelog: false,
        isDev: true,
      },
      interpretation: null,
    },
    evidence: [],
    edits: [],
    groupName: null,
  });

  it("rewrites the packageManager pin", () => {
    const content = JSON.stringify({ packageManager: "pnpm@11.20.0" }, null, 2) + "\n";

    const result = manager.applyUpdate(content, pmProposal("11.20.0", "11.22.0"));
    expect(result).not.toBeNull();
    expect(result).toContain('"packageManager": "pnpm@11.22.0"');
  });

  it("drops the stale corepack hash rather than carrying it over", () => {
    const content = JSON.stringify({ packageManager: "pnpm@11.20.0+sha512.abcdef" }, null, 2);

    const result = manager.applyUpdate(content, pmProposal("11.20.0", "11.22.0"));
    expect(result).toContain('"packageManager": "pnpm@11.22.0"');
    expect(result).not.toContain("sha512");
  });

  it("leaves a different package manager alone", () => {
    const content = JSON.stringify({ packageManager: "yarn@4.0.0" }, null, 2);

    expect(manager.applyUpdate(content, pmProposal("11.20.0", "11.22.0"))).toBeNull();
  });

  it("updates packageManager and a dependency section together", () => {
    const content =
      JSON.stringify(
        { devDependencies: { pnpm: "11.20.0" }, packageManager: "pnpm@11.20.0" },
        null,
        2,
      ) + "\n";

    const result = manager.applyUpdate(content, pmProposal("11.20.0", "11.22.0"));
    expect(result).toContain('"pnpm": "11.22.0"');
    expect(result).toContain('"packageManager": "pnpm@11.22.0"');
  });
});
