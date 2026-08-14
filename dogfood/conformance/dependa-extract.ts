/**
 * Dependa shadow extractor — derives what dependa would find from the
 * repository's dependency manifests and dependa's own managers.
 *
 * This extractor reuses dependa's actual manager implementations to discover
 * dependencies, ensuring the discovery layer matches exactly what the action
 * would produce at runtime. It does NOT call datasources (no network), so
 * version resolution is not performed — only discovery and classification
 * of the current dependency state.
 *
 * Known limitations:
 * - **No version resolution**: `targetVersion` is always null because no
 *   datasource queries are made. This means the version-selection, update-
 *   classification, and security comparison levels are only exercised by
 *   unit tests with fabricated data.
 * - **No security data**: Without advisory database access, `security` is
 *   always false.
 * - **No grouping**: Without proposals, `group` is always null.
 * - **Filesystem vs Contents API**: The extractor reads from the local
 *   filesystem rather than the GitHub Contents API, so it may discover
 *   dependencies in gitignored directories that the real action would not.
 * - **Lockfile search**: Only looks in the manifest's directory for lockfiles.
 *   In pnpm workspaces, the root lockfile may not be found from sub-packages.
 *
 * The extractor is designed for offline CI use: it reads files from the
 * checkout, not through the Contents API, and it produces the same
 * Dependency[] array that dependa's pipeline would start from.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { DependaFinding } from "./types.js";
import type { Dependency } from "../../src/duties/dependa/model.js";
import { createNpmManager } from "../../src/duties/dependa/managers/npm.js";
import { createGithubActionsManager } from "../../src/duties/dependa/managers/github-actions.js";
import { createCargoManager } from "../../src/duties/dependa/managers/cargo.js";
import { createGoManager } from "../../src/duties/dependa/managers/go.js";
import { createDockerManager } from "../../src/duties/dependa/managers/docker.js";
import type { Manager } from "../../src/duties/dependa/managers/types.js";

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** Root directory of the repository checkout. */
  repoRoot: string;
  /** Which ecosystems to scan. Empty = all. */
  ecosystems?: readonly string[];
}

/**
 * Extract dependa shadow findings from a repository checkout.
 *
 * Uses dependa's actual managers for discovery, then converts the results
 * into DependaFinding objects for comparison.
 */
export function extractDependaShadow(options: ExtractOptions): DependaFinding[] {
  const { repoRoot } = options;
  const ecosystems = options.ecosystems ?? [];

  const managers = createManagers();
  const findings: DependaFinding[] = [];

  for (const manager of managers) {
    // Filter by requested ecosystems
    if (ecosystems.length > 0 && !ecosystems.includes(manager.ecosystem)) {
      continue;
    }

    const discovered = discoverWithManager(manager, repoRoot);
    for (const dep of discovered) {
      findings.push(dependencyToFinding(dep));
    }
  }

  return findings;
}

// ─── Manager creation ──────────────────────────────────────────────────────

function createManagers(): Manager[] {
  return [
    createNpmManager(),
    createGithubActionsManager(),
    createCargoManager(),
    createGoManager(),
    createDockerManager(),
  ];
}

// ─── Discovery ─────────────────────────────────────────────────────────────

/**
 * Discover dependencies using a manager against a local checkout.
 *
 * This mimics dependa's discoverAll() but reads from the filesystem
 * instead of the Contents API.
 */
function discoverWithManager(manager: Manager, repoRoot: string): Dependency[] {
  const allDeps: Dependency[] = [];

  // Find manifest files
  const manifestPaths = findManifests(manager, repoRoot);

  for (const manifestPath of manifestPaths) {
    const fullPath = path.join(repoRoot, manifestPath);
    const manifestContent = readFile(fullPath);
    if (manifestContent === null) continue;

    // Find lockfile
    const lockfileContent = findLockfile(manager, manifestPath, repoRoot);

    const result = manager.parse(manifestPath, manifestContent, lockfileContent);
    allDeps.push(...result.dependencies);
  }

  return allDeps;
}

/**
 * Find manifest files for a manager in the repository.
 */
function findManifests(manager: Manager, repoRoot: string): string[] {
  const manifests: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip node_modules, .git, etc.
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = path.relative(repoRoot, fullPath);

        // Check if this file matches the manager's manifest filenames
        if (manager.manifestFilenames.some((fn) => entry.name === fn)) {
          manifests.push(relPath);
        }

        // Check custom matchManifest for variable-named files
        if (manager.matchManifest?.(relPath)) {
          manifests.push(relPath);
        }
      }
    }
  }

  walk(repoRoot);
  return manifests;
}

/**
 * Try to find a lockfile for a given manifest.
 */
function findLockfile(manager: Manager, manifestPath: string, repoRoot: string): string | null {
  // For npm: look for pnpm-lock.yaml, package-lock.json, yarn.lock
  if (manager.id === "npm") {
    const dir = path.dirname(path.join(repoRoot, manifestPath));
    for (const lockfileName of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
      const lockPath = path.join(dir, lockfileName);
      if (fs.existsSync(lockPath)) {
        return readFile(lockPath);
      }
    }
  }

  // For cargo: look for Cargo.lock
  if (manager.id === "cargo") {
    const dir = path.dirname(path.join(repoRoot, manifestPath));
    const lockPath = path.join(dir, "Cargo.lock");
    if (fs.existsSync(lockPath)) {
      return readFile(lockPath);
    }
  }

  // For go: look for go.sum
  if (manager.id === "go") {
    const dir = path.dirname(path.join(repoRoot, manifestPath));
    const sumPath = path.join(dir, "go.sum");
    if (fs.existsSync(sumPath)) {
      return readFile(sumPath);
    }
  }

  return null;
}

// ─── Conversion ─────────────────────────────────────────────────────────────

function dependencyToFinding(dep: Dependency): DependaFinding {
  return {
    ecosystem: dep.ecosystem,
    name: dep.name,
    constraint: dep.constraint,
    currentVersion: dep.currentVersion || null,
    targetVersion: null, // Not resolved in shadow mode
    updateType: null, // Not classified without datasource
    group: null, // Not grouped without proposals
    files: [dep.manifestPath],
    security: false, // Not assessed without advisory query
    manager: dep.manager,
    discovered: true,
    policyAction: null, // Not evaluated without proposals
    riskLevel: null, // Not assessed without model call
  };
}

// ─── File helpers ──────────────────────────────────────────────────────────

function readFile(fullPath: string): string | null {
  try {
    return fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}
