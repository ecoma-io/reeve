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
// `parseLockfile` (npm.ts:183) dispatches on the lockfile's own shape and
// hands off to one of two readers. The pnpm reader (`parsePnpmLockYaml`,
// npm.ts:255) had no coverage at all, and it is the one that decides what
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

  // ADJUDICATE — DEFECT, pinned to current behaviour rather than fixed here.
  //
  // pnpm 6+ writes a peer-resolved package as `/lodash@4.17.21(react@18.0.0):`.
  // `parsePnpmLockYaml`'s key pattern is `/^ {2}\/(.+)@(.+):$/` (npm.ts:282),
  // and both groups are greedy, so the split lands on the LAST `@` — inside
  // the parenthetical. The name becomes `lodash@4.17.21(react` and the version
  // `18.0.0)`, and the `cleanVersion` strip on the next line cannot help
  // because the parenthesis is no longer trailing. The manifest's `lodash`
  // then matches nothing and `currentVersion` comes back EMPTY.
  //
  // The code's own comment at npm.ts:287 says it means to strip parenthetical
  // indicators, so the intent is declared and unmet — this is a defect, not a
  // documented limitation. Effect: a pnpm repository gets no `currentVersion`
  // for any peer-resolved dependency, so those dependencies are measured from
  // nothing. The one-line fix is to strip the parenthetical before the split
  // rather than after:
  //
  //   /^ {2}\/(.+)@(.+):$/.exec(trimmedLine.replace(/\([^)]*\)(?=:$)/, ""))
  //
  // Not applied here because this round is test-first and the downstream
  // treatment of an empty `currentVersion` is another owner's contract.
  // Reported to root for a ruling; this case is what proves the fix when it
  // lands, and it is written against the source as it stands today.
  it("does NOT resolve a pnpm peer-suffixed entry, leaving the version empty", () => {
    const lockfile = [
      "lockfileVersion: '6.0'",
      "packages:",
      "  /lodash@4.17.21(react@18.0.0):",
    ].join("\n");

    expect(resolved(lockfile).version).toBe("");
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
