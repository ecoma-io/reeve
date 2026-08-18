/**
 * The npm manager — discovers dependencies from `package.json`.
 *
 * Deterministic: the same `package.json` content produces the same `Dependency`
 * list every time. No LLM, no network, no randomness. The manager reads the
 * file content (already fetched through the Contents API) and returns structured
 * data — it never fetches anything itself.
 *
 * npm's manifest grammar is JSON with `dependencies`, `devDependencies`,
 * `optionalDependencies`, and `peerDependencies` maps whose values are version
 * constraints. The constraint grammar is npm's own — caret, tilde, range,
 * exact, and aliases. This parser handles the constraints that actually appear
 * in real manifests; exotic grammar that does not parse is not proposed for
 * update (the same boundary every other manager draws).
 *
 * Lockfile parsing (pnpm-lock.yaml, package-lock.json, yarn.lock) is handled
 * to resolve `currentVersion` from the lockfile when available. Without a
 * lockfile, `currentVersion` is the constraint itself — which may not be a
 * version at all, and downstream stages handle that case.
 */
import type { Dependency, UpdateProposal } from "../model.js";
import type { Manager, ManagerId, ManagerResult } from "./types.js";

/** The npm manager identifier. */
const ID: ManagerId = "npm";

/** Filenames the npm manager looks for. */
const MANIFEST_FILENAMES = ["package.json"] as const;

export function createNpmManager(): Manager {
  return {
    id: ID,
    ecosystem: "npm",
    manifestFilenames: MANIFEST_FILENAMES,
    parse,
    applyUpdate,
  };
}

/**
 * Parse a `package.json` and return every dependency found.
 *
 * Reads `dependencies`, `devDependencies`, `optionalDependencies`, and
 * `peerDependencies`. Each entry becomes a `Dependency` with its constraint
 * and whether it is a dev dependency.
 */
function parse(
  manifestPath: string,
  manifestContent: string,
  lockfileContent: string | null,
): ManagerResult {
  const dependencies: Dependency[] = [];
  let partial = false;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(manifestContent) as Record<string, unknown>;
  } catch {
    // Malformed package.json — nothing to discover
    return { manifestPath, dependencies: [], partial: true };
  }

  // Resolve locked versions from lockfile if available
  const lockedVersions = lockfileContent !== null ? parseLockfile(lockfileContent) : null;
  if (lockfileContent !== null && lockedVersions === null) {
    partial = true; // Lockfile present but could not be parsed
  }

  // Read each dependency section
  const sections: readonly { key: string; dev: boolean }[] = [
    { key: "dependencies", dev: false },
    { key: "devDependencies", dev: true },
    { key: "optionalDependencies", dev: false },
    { key: "peerDependencies", dev: false },
  ];

  for (const { key, dev } of sections) {
    const section = pkg[key];
    if (typeof section !== "object" || section === null) continue;

    const map = section as Record<string, string>;
    for (const [name, rawConstraint] of Object.entries(map)) {
      if (typeof rawConstraint !== "string") continue;

      // Handle npm aliases: "npm:package@version"
      const { packageName, constraint } = resolveConstraint(name, rawConstraint);

      // Try to resolve current version from lockfile
      const currentVersion =
        lockedVersions !== null
          ? (lockedVersions.get(packageName) ?? lockedVersions.get(name) ?? "")
          : extractPinnedVersion(constraint);

      dependencies.push({
        ecosystem: "npm",
        name: packageName,
        constraint,
        currentVersion,
        manifestPath,
        dev,
        manager: ID,
      });
    }
  }

  return { manifestPath, dependencies, partial };
}

/**
 * Resolve a constraint string, handling npm aliases and workspace protocols.
 *
 * npm aliases look like `"npm:package-name@^1.2.3"` — the real package name
 * and the constraint are both embedded. Workspace protocols like `"workspace:*"`
 * are not proposed for update (they are local packages).
 */
function resolveConstraint(
  name: string,
  raw: string,
): { readonly packageName: string; readonly constraint: string | null } {
  const trimmed = raw.trim();

  // Workspace protocol — local package, not proposed for update
  if (trimmed.startsWith("workspace:") || trimmed.startsWith("link:")) {
    return { packageName: name, constraint: null };
  }

  // npm alias: "npm:package-name@^1.2.3" or "npm:package-name@1.2.3"
  if (trimmed.startsWith("npm:")) {
    const alias = trimmed.slice(4);
    const atIdx = alias.lastIndexOf("@");
    if (atIdx > 0) {
      // Has a scope or a version — find the version separator
      const pkgName = alias.slice(0, atIdx);
      const version = alias.slice(atIdx + 1);
      return { packageName: pkgName, constraint: version };
    }
    // npm:package-name without version
    return { packageName: alias, constraint: null };
  }

  // file: protocol — local path, not proposed for update
  if (trimmed.startsWith("file:")) {
    return { packageName: name, constraint: null };
  }

  // GitHub shorthand: "owner/repo" or "owner/repo#branch"
  if (trimmed.includes("/")) {
    return { packageName: name, constraint: null };
  }

  return { packageName: name, constraint: trimmed || null };
}

/**
 * Extract a pinned version from a constraint when no lockfile is available.
 *
 * A constraint like `"1.2.3"` (exact) or `">=1.2.3"` is not a resolved
 * version — it is a range. Only when the constraint IS an exact version
 * string can we use it as currentVersion. Otherwise, return empty string.
 */
function extractPinnedVersion(constraint: string | null): string {
  if (constraint === null) return "";

  const trimmed = constraint.trim();

  // Exact version: no prefix operators, looks like a version
  if (/^\d/.test(trimmed) && !trimmed.includes(" ") && !trimmed.includes("||")) {
    return trimmed;
  }

  return "";
}

/**
 * Parse a pnpm-lock.yaml to extract resolved versions.
 *
 * pnpm lockfiles are YAML. This is a simplified parser that handles the
 * common structure. It does not need to understand every field — only the
 * version resolution map.
 *
 * Returns null when the lockfile cannot be parsed.
 */
function parseLockfile(content: string): Map<string, string> | null {
  // Try to detect lockfile format and parse accordingly.
  // package-lock.json is JSON; pnpm-lock.yaml and yarn.lock are YAML.

  // Quick JSON check — if it starts with '{', it's package-lock.json
  if (content.trimStart().startsWith("{")) {
    return parsePackageLockJson(content);
  }

  // pnpm-lock.yaml or yarn.lock — parse the importers section
  if (
    content.startsWith("#") ||
    content.includes("specifiers:") ||
    content.includes("lockfileVersion:")
  ) {
    return parsePnpmLockYaml(content);
  }

  return null;
}

/**
 * Parse package-lock.json format (when lockfileContent is actually JSON).
 */
function parsePackageLockJson(content: string): Map<string, string> | null {
  try {
    const lock = JSON.parse(content) as Record<string, unknown>;
    const versions = new Map<string, string>();

    // package-lock.json v2/v3: packages map
    const packages = lock.packages;
    if (typeof packages === "object" && packages !== null) {
      const packagesMap = packages as Record<string, Record<string, unknown>>;
      for (const [path, info] of Object.entries(packagesMap)) {
        // Skip the root package (empty string key)
        if (path === "") continue;
        // Strip "node_modules/" prefix
        const name = path.replace(/^node_modules\//, "");
        const version = info.version;
        if (typeof version === "string") {
          versions.set(name, version);
        }
      }
      return versions;
    }

    // package-lock.json v1: dependencies map
    const deps = lock.dependencies;
    if (typeof deps === "object" && deps !== null) {
      const depsMap = deps as Record<string, Record<string, unknown>>;
      for (const [name, info] of Object.entries(depsMap)) {
        const version = info.version;
        if (typeof version === "string") {
          versions.set(name, version);
        }
      }
      return versions;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse pnpm-lock.yaml format.
 *
 * This is a simplified YAML parser for the specific structure of pnpm
 * lockfiles. It extracts the version map from the `importers` section
 * and the `packages` section. It does not need to be a general YAML parser.
 */
function parsePnpmLockYaml(content: string): Map<string, string> | null {
  const versions = new Map<string, string>();

  // Look for package entries like:
  //   /lodash@4.17.21:
  //     version: 4.17.21
  // or in importers:
  //   lodash: 4.17.21
  const lines = content.split("\n");
  let inPackages = false;

  for (const line of lines) {
    const trimmedLine = line.trimEnd();

    // Detect the packages section
    if (trimmedLine === "packages:" || trimmedLine === "importers:") {
      inPackages = true;
      continue;
    }

    // New top-level key ends the packages section
    if (inPackages && /^[a-zA-Z]/.test(trimmedLine) && !trimmedLine.startsWith("/")) {
      inPackages = false;
    }

    if (!inPackages) continue;

    // Match package entries: /name@version:
    //
    // The trailing parenthetical is stripped BEFORE the split, not after it.
    // pnpm 6+ writes a package resolved against a peer as
    // `/name@version(peer@version):`, and both capture groups below are
    // greedy — so a split on the raw line lands on the `@` INSIDE the
    // parenthetical and hands back a name and a version that are both wrong,
    // which is a dependency silently dropped from maintenance (see
    // `semver.test.ts`'s empty-current-version block for what that costs).
    // Stripping first leaves `/name@version:`, the shape this pattern was
    // written for.
    const packageMatch = /^ {2}\/(.+)@(.+):$/.exec(trimmedLine.replace(/(?:\([^)]*\))+(?=:$)/, ""));
    if (packageMatch !== null) {
      const name = packageMatch[1] ?? "";
      const version = packageMatch[2] ?? "";
      if (name.length > 0 && version.length > 0) {
        // Strip any parenthetical indicators like _(patched)
        const cleanVersion = version.replace(/\([^)]*\)$/, "");
        versions.set(name, cleanVersion);
      }
    }

    // Match version lines under a package entry: version: X.Y.Z
    const versionMatch = /^ {4,6}version:\s+(\S+)$/.exec(trimmedLine);
    if (versionMatch !== null) {
      // This is a version line — but we already captured from the key
      // This handles the case where the key doesn't have the version
    }
  }

  // Also look for importers section patterns like:
  //   lodash: 4.17.21
  let inImporters = false;
  let inSpecifiers = false;
  for (const line of lines) {
    const trimmedLine = line.trimEnd();

    if (trimmedLine === "importers:") {
      inImporters = true;
      continue;
    }

    if (inImporters && /^[a-zA-Z]/.test(trimmedLine)) {
      inImporters = false;
    }

    if (trimmedLine.includes("specifiers:")) {
      inSpecifiers = true;
      continue;
    }

    if (inSpecifiers && (!trimmedLine.startsWith(" ") || /^[^ ]/.test(trimmedLine))) {
      inSpecifiers = false;
    }

    if (inImporters && !inSpecifiers) {
      // Match: "  lodash: 4.17.21" or "    lodash: 4.17.21"
      const depMatch = /^\s{2,}([a-zA-Z0-9@/._-]+):\s+(\S+)$/.exec(trimmedLine);
      if (depMatch !== null) {
        const name = depMatch[1] ?? "";
        const version = depMatch[2] ?? "";
        // Skip if it looks like a section header, not a version
        if (/^\d/.test(version) || version.startsWith("(")) {
          if (!name.includes(":") && name !== "specifiers" && name !== "dependencies") {
            versions.set(name, version.replace(/^\(/, "").replace(/\)$/, ""));
          }
        }
      }
    }
  }

  return versions.size > 0 ? versions : null;
}

/**
 * Apply an update to a `package.json` file, returning the modified content.
 *
 * Deterministic: the same manifest content, the same proposal, and the same
 * constraint grammar produce the same output every time. No model call.
 *
 * Returns null when the update cannot be applied (e.g. the constraint grammar
 * is not one this manager knows how to rewrite).
 */
function applyUpdate(manifestContent: string, proposal: UpdateProposal): string | null {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(manifestContent) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Determine which sections the dependency lives in.
  // For npm aliases, the manifest key is the alias name, not the resolved
  // package name — so we search by value too.
  // A dependency may appear in multiple sections (e.g. both dependencies
  // and peerDependencies) — we update ALL occurrences.
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const matches: { section: string; manifestKey: string; oldConstraint: string }[] = [];

  for (const section of sections) {
    const map = pkg[section];
    if (typeof map !== "object" || map === null) continue;

    const deps = map as Record<string, unknown>;

    // First: direct key match (non-alias case)
    const directValue = deps[proposal.dependency.name];
    if (typeof directValue === "string") {
      matches.push({ section, manifestKey: proposal.dependency.name, oldConstraint: directValue });
      continue; // Check remaining sections for other occurrences
    }

    // Second: search by value for npm aliases.
    // An alias like "my-alias": "npm:lodash@^4.0.0" — the resolved name
    // is "lodash" but the manifest key is "my-alias".
    for (const [key, value] of Object.entries(deps)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.startsWith("npm:")) {
        const aliasPkg = trimmed.slice(4);
        // Extract the package name from "npm:@scope/pkg@^1.2.3" or "npm:pkg@^1.2.3"
        const atIdx = aliasPkg.lastIndexOf("@");
        const aliasName = atIdx > 0 ? aliasPkg.slice(0, atIdx) : aliasPkg;
        if (aliasName === proposal.dependency.name) {
          matches.push({ section, manifestKey: key, oldConstraint: trimmed });
          break; // Only one alias match per section
        }
      }
    }
  }

  if (matches.length === 0) {
    // Dependency not found in any section — cannot apply
    return null;
  }

  // Apply updates to all matching sections
  let anyRewritten = false;
  for (const { section, manifestKey, oldConstraint } of matches) {
    // Determine the new constraint
    const newConstraint = rewriteConstraint(oldConstraint, proposal.targetVersion);
    if (newConstraint === null) {
      // Constraint grammar not recognized — cannot safely rewrite
      // For npm aliases, rewrite the version within the alias string
      if (oldConstraint.startsWith("npm:")) {
        const aliasRewrite = rewriteAliasConstraint(oldConstraint, proposal.targetVersion);
        if (aliasRewrite !== null) {
          const sectionMap = pkg[section] as Record<string, unknown>;
          sectionMap[manifestKey] = aliasRewrite;
          anyRewritten = true;
          continue;
        }
      }
      // Unrecognized constraint in this section — skip it (other sections may still apply)
      continue;
    }

    // Apply the change
    const sectionMap = pkg[section] as Record<string, unknown>;
    sectionMap[manifestKey] = newConstraint;
    anyRewritten = true;
  }

  // When no section could be rewritten, the update cannot be applied
  if (!anyRewritten) return null;

  return stringifyPreservingIndent(manifestContent, pkg);
}

/**
 * Rewrite an npm alias constraint to target a new version.
 *
 * npm alias: `"npm:package-name@^1.2.3"` → `"npm:package-name@^2.0.0"`
 * Preserves the `npm:` prefix, package name, and constraint prefix.
 * Returns null when the alias structure cannot be parsed.
 */
function rewriteAliasConstraint(oldConstraint: string, newVersion: string): string | null {
  if (!oldConstraint.startsWith("npm:")) return null;

  const alias = oldConstraint.slice(4);
  const atIdx = alias.lastIndexOf("@");
  if (atIdx <= 0) return null; // No version separator, or @ at start (scope-only)

  const pkgName = alias.slice(0, atIdx);
  const versionPart = alias.slice(atIdx + 1);

  // Rewrite the version portion, preserving any constraint prefix
  const rewritten = rewriteConstraint(versionPart, newVersion);
  if (rewritten === null) return null;

  return `npm:${pkgName}@${rewritten}`;
}

/**
 * Rewrite a version constraint to target a new version.
 *
 * Preserves the constraint prefix (^, ~, >=, etc.) and replaces only the
 * version number. If the constraint grammar is not recognized, returns null
 * — the update will not be applied, which is safe (it just won't happen).
 */
function rewriteConstraint(oldConstraint: string, newVersion: string): string | null {
  const trimmed = oldConstraint.trim();

  // Workspace/link/file/npm-alias protocols — do not rewrite
  if (
    trimmed.startsWith("workspace:") ||
    trimmed.startsWith("link:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("npm:")
  ) {
    return null;
  }

  // Caret: ^1.2.3 → ^2.0.0
  if (trimmed.startsWith("^")) {
    return `^${newVersion}`;
  }

  // Tilde: ~1.2.3 → ~2.0.0
  if (trimmed.startsWith("~")) {
    return `~${newVersion}`;
  }

  // Comparison operators
  if (
    trimmed.startsWith(">=") ||
    trimmed.startsWith(">") ||
    trimmed.startsWith("<=") ||
    trimmed.startsWith("<")
  ) {
    return null; // Range constraints are too complex to safely rewrite
  }

  // Exact version: 1.2.3 → 2.0.0
  if (/^\d/.test(trimmed)) {
    return newVersion;
  }

  // x-range or * — rewrite to exact
  if (trimmed === "*" || trimmed === "latest" || trimmed.includes("x")) {
    return newVersion;
  }

  // Cannot safely rewrite this constraint
  return null;
}

/**
 * Stringify a package.json object preserving the original indentation.
 *
 * `JSON.stringify(pkg, null, 2)` always uses 2-space indent, but real
 * package.json files may use tabs or 4-space indentation. Detecting and
 * preserving the original indent avoids unnecessary diff noise in PRs.
 *
 * Detection: find the first indented line in the original content and
 * measure its whitespace. Fall back to 2 spaces when detection fails.
 */
function stringifyPreservingIndent(originalContent: string, pkg: Record<string, unknown>): string {
  const indent = detectIndent(originalContent);
  const suffix = originalContent.endsWith("\n") ? "\n" : "";
  return JSON.stringify(pkg, null, indent) + suffix;
}

/**
 * Detect the indentation of a JSON string by examining the first indented line.
 *
 * Returns the indent string (e.g. "  " or "\t" or "    ") or "  " as default.
 */
function detectIndent(content: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const match = /^(\s+)\S/.exec(line);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return "  ";
}
