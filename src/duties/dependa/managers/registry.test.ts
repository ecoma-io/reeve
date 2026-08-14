/**
 * Tests for the manager registry and discoverAll.
 *
 * The registry is where managers are registered and activated against the
 * repository file tree. These tests cover selection (which managers activate
 * for which files), duplicate registration rejection, and discoverAll with
 * mocked file reads.
 */
import { describe, expect, it } from "vitest";

import type { Manager, ManagerId } from "./types.js";

import { ManagerRegistry, discoverAll, type ManagerActivation } from "./registry.js";

// ── stub managers ────────────────────────────────────────────────────────

function stubManager(id: ManagerId, filenames: readonly string[]): Manager {
  return {
    id,
    ecosystem:
      id === "npm"
        ? "npm"
        : id === "cargo"
          ? "cargo"
          : id === "go"
            ? "go"
            : id === "docker"
              ? "docker"
              : "github-actions",
    manifestFilenames: filenames,
    parse: () => ({ manifestPath: "", dependencies: [], partial: false }),
    applyUpdate: () => null,
  };
}

function stubManagerWithMatch(id: ManagerId, matchFn: (path: string) => boolean): Manager {
  return {
    id,
    ecosystem: "github-actions",
    manifestFilenames: [],
    matchManifest: matchFn,
    parse: () => ({ manifestPath: "", dependencies: [], partial: false }),
    applyUpdate: () => null,
  };
}

// ── ManagerRegistry constructor ──────────────────────────────────────────

describe("ManagerRegistry", () => {
  it("registers managers by ID", () => {
    const registry = new ManagerRegistry([stubManager("npm", ["package.json"])]);
    expect(registry.get("npm")).toBeDefined();
  });

  it("rejects duplicate manager IDs", () => {
    expect(
      () =>
        new ManagerRegistry([
          stubManager("npm", ["package.json"]),
          stubManager("npm", ["package.json"]),
        ]),
    ).toThrow("registered more than once");
  });

  it("lists all managers", () => {
    const registry = new ManagerRegistry([
      stubManager("npm", ["package.json"]),
      stubManager("cargo", ["Cargo.toml"]),
    ]);
    expect(registry.all()).toHaveLength(2);
  });
});

// ── select ───────────────────────────────────────────────────────────────

describe("ManagerRegistry select", () => {
  it("activates managers whose manifest files are in the tree", () => {
    const registry = new ManagerRegistry([stubManager("npm", ["package.json"])]);
    const activations = registry.select(["package.json", "src/main.ts"]);

    expect(activations).toHaveLength(1);
    expect(activations[0]?.manager.id).toBe("npm");
    expect(activations[0]?.manifests).toEqual(["package.json"]);
  });

  it("does not activate managers whose files are absent", () => {
    const registry = new ManagerRegistry([stubManager("cargo", ["Cargo.toml"])]);
    const activations = registry.select(["package.json"]);

    expect(activations).toHaveLength(0);
  });

  it("activates multiple managers for a polyglot project", () => {
    const registry = new ManagerRegistry([
      stubManager("npm", ["package.json"]),
      stubManager("cargo", ["Cargo.toml"]),
    ]);
    const activations = registry.select(["package.json", "Cargo.toml", "src/main.rs"]);

    expect(activations).toHaveLength(2);
  });

  it("uses matchManifest when provided", () => {
    const registry = new ManagerRegistry([
      stubManagerWithMatch(
        "github-actions",
        (p) => p.startsWith(".github/workflows/") && p.endsWith(".yml"),
      ),
    ]);
    const activations = registry.select([".github/workflows/ci.yml", "package.json"]);

    expect(activations).toHaveLength(1);
    expect(activations[0]?.manifests).toEqual([".github/workflows/ci.yml"]);
  });

  it("matches files in subdirectories", () => {
    const registry = new ManagerRegistry([stubManager("npm", ["package.json"])]);
    const activations = registry.select(["packages/app/package.json", "package.json"]);

    expect(activations).toHaveLength(1);
    expect(activations[0]?.manifests).toEqual(["packages/app/package.json", "package.json"]);
  });
});

// ── discoverAll ──────────────────────────────────────────────────────────

describe("discoverAll", () => {
  it("discovers dependencies from all activated managers", async () => {
    const npmManager: Manager = {
      id: "npm",
      ecosystem: "npm",
      manifestFilenames: ["package.json"],
      parse: (_path, _content, _lock) => ({
        manifestPath: "package.json",
        dependencies: [
          {
            ecosystem: "npm",
            name: "lodash",
            constraint: "^4.0.0",
            currentVersion: "4.17.21",
            manifestPath: "package.json",
            dev: false,
            manager: "npm",
          },
        ],
        partial: false,
      }),
      applyUpdate: () => null,
    };

    const activations: ManagerActivation[] = [{ manager: npmManager, manifests: ["package.json"] }];

    // eslint-disable-next-line @typescript-eslint/require-await
    const readFile = async (path: string) => {
      if (path === "package.json") return JSON.stringify({ dependencies: { lodash: "^4.0.0" } });
      return null;
    };

    const results = await discoverAll(activations, readFile);
    expect(results).toHaveLength(1);
    expect(results[0]?.dependencies).toHaveLength(1);
    expect(results[0]?.dependencies[0]?.name).toBe("lodash");
  });

  it("skips manifests that cannot be read", async () => {
    const npmManager: Manager = {
      id: "npm",
      ecosystem: "npm",
      manifestFilenames: ["package.json"],
      parse: () => ({ manifestPath: "package.json", dependencies: [], partial: false }),
      applyUpdate: () => null,
    };

    const activations: ManagerActivation[] = [
      { manager: npmManager, manifests: ["package.json", "apps/web/package.json"] },
    ];

    // eslint-disable-next-line @typescript-eslint/require-await
    const readFile = async () => null; // All reads fail

    const results = await discoverAll(activations, readFile);
    expect(results).toHaveLength(0);
  });

  it("reads lockfiles alongside manifests", async () => {
    let lockfilePathSeen = false;

    const npmManager: Manager = {
      id: "npm",
      ecosystem: "npm",
      manifestFilenames: ["package.json"],
      parse: (_path, _content, lockContent) => {
        if (lockContent !== null) lockfilePathSeen = true;
        return { manifestPath: "package.json", dependencies: [], partial: false };
      },
      applyUpdate: () => null,
    };

    const activations: ManagerActivation[] = [{ manager: npmManager, manifests: ["package.json"] }];

    // eslint-disable-next-line @typescript-eslint/require-await
    const readFile = async (path: string) => {
      if (path === "package.json") return "{}";
      if (path === "pnpm-lock.yaml") return "# lockfile";
      return null;
    };

    await discoverAll(activations, readFile);
    expect(lockfilePathSeen).toBe(true);
  });

  it("reads Cargo.lock for cargo ecosystem", async () => {
    let lockfileContent: string | null = null;

    const cargoManager: Manager = {
      id: "cargo",
      ecosystem: "cargo",
      manifestFilenames: ["Cargo.toml"],
      parse: (_path, _content, lockContent) => {
        lockfileContent = lockContent;
        return { manifestPath: "Cargo.toml", dependencies: [], partial: false };
      },
      applyUpdate: () => null,
    };

    const activations: ManagerActivation[] = [{ manager: cargoManager, manifests: ["Cargo.toml"] }];

    // eslint-disable-next-line @typescript-eslint/require-await
    const readFile = async (path: string) => {
      if (path === "Cargo.toml") return '[package]\nname = "app"';
      if (path === "Cargo.lock") return "# cargo lockfile";
      return null;
    };

    await discoverAll(activations, readFile);
    expect(lockfileContent).toBe("# cargo lockfile");
  });

  it("reads go.sum for go ecosystem", async () => {
    let lockfileContent: string | null = null;

    const goManager: Manager = {
      id: "go",
      ecosystem: "go",
      manifestFilenames: ["go.mod"],
      parse: (_path, _content, lockContent) => {
        lockfileContent = lockContent;
        return { manifestPath: "go.mod", dependencies: [], partial: false };
      },
      applyUpdate: () => null,
    };

    const activations: ManagerActivation[] = [{ manager: goManager, manifests: ["go.mod"] }];

    // eslint-disable-next-line @typescript-eslint/require-await
    const readFile = async (path: string) => {
      if (path === "go.mod") return "module example.com/app\ngo 1.21";
      if (path === "go.sum") return "github.com/pkg v0.1.0 h1:abc";
      return null;
    };

    await discoverAll(activations, readFile);
    expect(lockfileContent).toBe("github.com/pkg v0.1.0 h1:abc");
  });

  it("does not attempt lockfile reads for docker and github-actions", async () => {
    const readPaths: string[] = [];

    const dockerManager: Manager = {
      id: "docker",
      ecosystem: "docker",
      manifestFilenames: ["Dockerfile"],
      parse: () => ({ manifestPath: "Dockerfile", dependencies: [], partial: false }),
      applyUpdate: () => null,
    };

    const ghManager: Manager = {
      id: "github-actions",
      ecosystem: "github-actions",
      manifestFilenames: [".github/workflows/ci.yml"],
      parse: () => ({
        manifestPath: ".github/workflows/ci.yml",
        dependencies: [],
        partial: false,
      }),
      applyUpdate: () => null,
    };

    const activations: ManagerActivation[] = [
      { manager: dockerManager, manifests: ["Dockerfile"] },
      { manager: ghManager, manifests: [".github/workflows/ci.yml"] },
    ];

    // eslint-disable-next-line @typescript-eslint/require-await
    const readFile = async (path: string) => {
      readPaths.push(path);
      if (path === "Dockerfile") return "FROM node:20";
      if (path === ".github/workflows/ci.yml") return "on: push";
      return null;
    };

    await discoverAll(activations, readFile);
    // Docker and github-actions have no lockfiles, so only manifest paths should be read
    expect(readPaths).toEqual(["Dockerfile", ".github/workflows/ci.yml"]);
  });
});
