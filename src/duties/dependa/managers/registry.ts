/**
 * The manager registry: which managers are available and how to activate them.
 *
 * A manager is selected by matching against the repository's file tree —
 * the same recursive tree walk `atlas.ts` already uses. If a repository
 * has a `package.json` at the root, the npm manager activates. If it has
 * a `Cargo.toml`, the cargo manager activates. Multiple managers can
 * activate for the same repository (a polyglot project has both).
 *
 * Registration is static, not dynamic. The set of managers is a compile-time
 * decision, not a plugin system. Adding a manager is a code change reviewed
 * in a PR, the same way adding a duty is.
 */
import type { Manager, ManagerId, ManagerResult } from "./types.js";

/** One manager that should be activated, and the manifests it should read. */
export interface ManagerActivation {
  readonly manager: Manager;
  /** The repository-relative paths to manifest files this manager should parse. */
  readonly manifests: readonly string[];
}

export class ManagerRegistry {
  private readonly managers: ReadonlyMap<ManagerId, Manager>;

  constructor(managers: readonly Manager[]) {
    const map = new Map<ManagerId, Manager>();
    for (const m of managers) {
      if (map.has(m.id)) {
        throw new Error(`dependa: manager \`${m.id}\` registered more than once.`);
      }
      map.set(m.id, m);
    }
    this.managers = map;
  }

  /**
   * Given a set of filenames from the repository tree, returns every manager
   * that should activate and the manifest files it should read.
   */
  select(fileTree: readonly string[]): readonly ManagerActivation[] {
    const activations: ManagerActivation[] = [];
    for (const manager of this.managers.values()) {
      const manifests = fileTree.filter(
        (path) =>
          manager.manifestFilenames.some((name) => path.endsWith(`/${name}`) || path === name) ||
          (manager.matchManifest?.(path) ?? false),
      );
      if (manifests.length > 0) {
        activations.push({ manager, manifests });
      }
    }
    return activations;
  }

  get(id: ManagerId): Manager | undefined {
    return this.managers.get(id);
  }

  /** All registered managers. */
  all(): readonly Manager[] {
    return Array.from(this.managers.values());
  }
}

/**
 * Discover dependencies from a set of activated managers.
 *
 * Reads each manifest (and its lockfile, when available) through the
 * Contents API, then parses it with the manager's `parse()` method.
 * Returns all dependencies found, across all manifests.
 */
export async function discoverAll(
  activations: readonly ManagerActivation[],
  readFile: (path: string) => Promise<string | null>,
): Promise<readonly ManagerResult[]> {
  const results: ManagerResult[] = [];

  for (const { manager, manifests } of activations) {
    for (const manifestPath of manifests) {
      const manifestContent = await readFile(manifestPath);
      if (manifestContent === null) continue;

      // Try to read a lockfile alongside the manifest
      const lockfileContent = await readLockfile(manager, manifestPath, readFile);

      const result = manager.parse(manifestPath, manifestContent, lockfileContent);
      results.push(result);
    }
  }

  return results;
}

/**
 * Try to read a lockfile for a given manifest.
 *
 * Returns null when no lockfile is found or it cannot be read.
 * This is not an error — some ecosystems (GitHub Actions, Docker) have
 * no lockfile concept.
 */
async function readLockfile(
  manager: Manager,
  manifestPath: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<string | null> {
  // Lockfiles typically live alongside the manifest
  const dir = manifestPath.includes("/")
    ? manifestPath.slice(0, manifestPath.lastIndexOf("/"))
    : "";

  // Each manager defines its own lockfile names — check common ones
  const lockfileNames = getLockfileNames(manager.id);
  for (const name of lockfileNames) {
    const path = dir.length > 0 ? `${dir}/${name}` : name;
    const content = await readFile(path);
    if (content !== null) return content;
  }

  return null;
}

/** Well-known lockfile names per ecosystem. */
function getLockfileNames(managerId: ManagerId): readonly string[] {
  switch (managerId) {
    case "npm":
      return ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];
    case "cargo":
      return ["Cargo.lock"];
    case "go":
      return ["go.sum"];
    case "github-actions":
    case "docker":
    case "node-version":
      return [];
  }
}
