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
 * Lockfile parsing (pnpm-lock.yaml, package-lock.json) is handled to resolve
 * `currentVersion` from the lockfile when available. Without a lockfile,
 * `currentVersion` is the constraint itself — which may not be a version at
 * all, and downstream stages handle that case. yarn.lock v1 is not YAML and
 * is reported as an unreadable lockfile rather than guessed at.
 */
import { parse as parseYaml } from "yaml";

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

  // `packageManager` pins one package manager to one exact version —
  // `"pnpm@11.20.0"`, optionally with a corepack integrity hash after `+`.
  // The pin is a real dependency of the project's toolchain; a manifest that
  // declares it expects updates to it the same way Renovate proposes them.
  const packageManager = parsePackageManagerField(pkg.packageManager);
  if (packageManager !== null) {
    dependencies.push({
      ecosystem: "npm",
      name: packageManager.name,
      constraint: packageManager.version,
      currentVersion: packageManager.version,
      manifestPath,
      dev: true,
      manager: ID,
    });
  }

  // `engines` declares runtime constraints — `{"node": ">=24", "pnpm": ">=11"}`.
  // Discovered for parity with what the manifest actually states; ranges like
  // `>=24` are deliberately never rewritten by `applyUpdate`, so these produce
  // no proposals until a maintainer pins them. `node` is the runtime itself,
  // not an npm package — it belongs to the `node-version` ecosystem, where the
  // Node release index answers for it instead of the npm registry.
  const engines = pkg.engines;
  if (typeof engines === "object" && engines !== null && !Array.isArray(engines)) {
    for (const [name, rawConstraint] of Object.entries(engines as Record<string, unknown>)) {
      if (typeof rawConstraint !== "string" || rawConstraint.trim().length === 0) continue;
      dependencies.push({
        ecosystem: name === "node" ? "node-version" : "npm",
        name,
        constraint: rawConstraint.trim(),
        currentVersion: extractPinnedVersion(rawConstraint.trim()),
        manifestPath,
        dev: true,
        manager: ID,
      });
    }
  }

  return { manifestPath, dependencies, partial };
}

/**
 * Parse the `packageManager` field — `"name@version"` with an optional
 * `+integrity-hash` suffix that corepack appends. Returns null when the field
 * is absent or does not carry an exact version.
 */
function parsePackageManagerField(
  raw: unknown,
): { readonly name: string; readonly version: string } | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0) return null;

  const name = trimmed.slice(0, atIdx);
  // Strip the corepack integrity hash: "11.20.0+sha512.abc…" → "11.20.0"
  const version = trimmed.slice(atIdx + 1).split("+")[0] ?? "";
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;

  return { name, version };
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
 * Parse a lockfile to extract resolved versions.
 *
 * package-lock.json is JSON; pnpm-lock.yaml is YAML. yarn.lock v1 is neither
 * (its own line grammar fails YAML parsing) and comes back null, which the
 * caller reports as a partial read rather than a guessed version.
 *
 * Returns null when the lockfile cannot be parsed.
 */
function parseLockfile(content: string): Map<string, string> | null {
  // Quick JSON check — if it starts with '{', it's package-lock.json
  if (content.trimStart().startsWith("{")) {
    return parsePackageLockJson(content);
  }

  return parsePnpmLockYaml(content);
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
 * Parse pnpm-lock.yaml with a real YAML parser, across lockfile generations.
 *
 * The shapes that matter, by `lockfileVersion`:
 * - **5.x**: `packages` keys are `/name/1.2.3`; importers map names straight
 *   to version strings under `dependencies:`/`devDependencies:`.
 * - **6.x**: `packages` keys are `/name@1.2.3`, with peer-resolved entries
 *   suffixed `(peer@1.0.0)`.
 * - **9.0** (pnpm 9/10): `packages` keys drop the leading slash —
 *   `name@1.2.3` — and importers entries become `{specifier, version}`
 *   objects, where `version` may carry peer suffixes of its own.
 *
 * Importers are read first: they name the version the manifest's own
 * constraint resolved to, which is exactly what `currentVersion` means. The
 * `packages` keys are a fallback for names the importers did not resolve —
 * they never overwrite an importer's answer, because `packages` may hold
 * several versions of one name (one per consumer) and picking among those is
 * a guess the importers section exists to avoid.
 *
 * Returns null when the content is not a YAML mapping or resolves nothing —
 * the caller reports that as a partial read.
 */
function parsePnpmLockYaml(content: string): Map<string, string> | null {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;

  const lock = doc as Record<string, unknown>;
  const versions = new Map<string, string>();

  // Importers — one entry per workspace project.
  const importers = lock.importers;
  if (typeof importers === "object" && importers !== null && !Array.isArray(importers)) {
    for (const importer of Object.values(importers as Record<string, unknown>)) {
      collectImporterVersions(importer, versions);
    }
  }

  // A v5 lockfile without workspaces keeps its sections at the root. Only
  // the named sections are read here — a flat scan of root keys would
  // mistake `lockfileVersion: '6.0'` itself for a resolution.
  collectSectionVersions(lock, versions);

  // Fallback: `packages` keys, for names no importer resolved.
  const packages = lock.packages;
  if (typeof packages === "object" && packages !== null && !Array.isArray(packages)) {
    for (const key of Object.keys(packages)) {
      const entry = parsePnpmPackageKey(key);
      if (entry !== null && !versions.has(entry.name)) {
        versions.set(entry.name, entry.version);
      }
    }
  }

  return versions.size > 0 ? versions : null;
}

/** The importer sections whose entries resolve dependency versions. */
const IMPORTER_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/**
 * Collect resolved versions from one importer (or the lockfile root).
 *
 * Handles both entry shapes: a plain string version (v5/v6) and a
 * `{specifier, version}` object (v9). The `specifiers` block names
 * constraints, not resolved versions, and is never read.
 */
function collectImporterVersions(importer: unknown, versions: Map<string, string>): void {
  if (typeof importer !== "object" || importer === null || Array.isArray(importer)) return;
  const record = importer as Record<string, unknown>;

  collectSectionVersions(record, versions);

  // Some importer blocks map names straight to versions with no section
  // wrapper. Only plain string values count; `specifiers` is a constraint
  // block, never a resolution.
  for (const [name, entry] of Object.entries(record)) {
    if (name === "specifiers" || (IMPORTER_SECTIONS as readonly string[]).includes(name)) continue;
    if (typeof entry !== "string") continue;
    const version = cleanResolvedVersion(entry);
    if (version !== null) versions.set(name, version);
  }
}

/**
 * Collect resolved versions from the named dependency sections of a record —
 * an importer, or the root of a v5 lockfile without workspaces.
 */
function collectSectionVersions(
  record: Record<string, unknown>,
  versions: Map<string, string>,
): void {
  for (const section of IMPORTER_SECTIONS) {
    const block = record[section];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;

    for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
      const version =
        typeof entry === "string"
          ? cleanResolvedVersion(entry)
          : typeof entry === "object" &&
              entry !== null &&
              typeof (entry as Record<string, unknown>).version === "string"
            ? cleanResolvedVersion((entry as Record<string, unknown>).version as string)
            : null;
      if (version !== null) versions.set(name, version);
    }
  }
}

/**
 * Everything from the first `(` onwards, removed.
 *
 * pnpm writes a resolution's peer context as a parenthetical suffix, and from
 * v9 those suffixes NEST — `@eslint/js@10.0.1(eslint@10.8.1(jiti@2.6.1)(supports-color@7.2.0))`
 * is one entry from this repository's own lockfile. A regex built out of
 * `\([^)]*\)` cannot match a nested group, so the anchored version of it
 * matched nothing at all and every peer-resolved entry kept its whole suffix:
 * `currentVersion` came out as `10.0.1(eslint@…)`, which is not a version,
 * so `classifyUpdate` returned null and the dependency was dropped with a
 * "could not classify" line. That was every peer-resolved dependency in a
 * pnpm v9 repository — the majority of a modern one.
 *
 * Cutting at the first `(` needs no balancing: a resolved version is a
 * semver string, and semver has no parenthesis in it. Whatever follows the
 * first one is peer context by construction.
 */
function stripPeerSuffix(raw: string): string {
  const open = raw.indexOf("(");
  return open === -1 ? raw : raw.slice(0, open);
}

/**
 * Normalise a resolved-version string from an importers entry.
 *
 * Strips trailing peer-resolution suffixes (`1.2.3(react@18.0.0)` → `1.2.3`,
 * nesting included) and rejects anything that is not a version — `link:`,
 * `workspace:`, and `file:` resolutions are local packages, and a constraint
 * like `^1.2.3` is a specifier that leaked in, not a resolution.
 */
function cleanResolvedVersion(raw: string): string | null {
  const stripped = stripPeerSuffix(raw);
  return /^\d/.test(stripped) ? stripped : null;
}

/**
 * Split a pnpm `packages` key into a name and a version.
 *
 * The peer parenthetical is stripped BEFORE the split: a peer-resolved key
 * like `/name@1.2.3(peer@1.0.0)` would otherwise split on the `@` inside the
 * parenthetical, and a name and version that are both wrong is a dependency
 * silently dropped from maintenance (see `semver.test.ts`'s
 * empty-current-version block for what that costs). A nested v9 suffix made
 * that worse than a drop: `@eslint/js@10.0.1(eslint@10.8.1(jiti@2.6.1)(supports-color@7.2.0))`
 * split at the last `@` — the one inside `(supports-color@7.2.0)` — and
 * `7.2.0))` starts with a digit, so the wrong name and the wrong version
 * were returned as a confident answer rather than refused.
 */
function parsePnpmPackageKey(key: string): { name: string; version: string } | null {
  const bare = stripPeerSuffix(key.startsWith("/") ? key.slice(1) : key);

  // v6/v9 style: name@version. lastIndexOf keeps a scope's leading `@` (at
  // index 0) out of the split.
  const at = bare.lastIndexOf("@");
  if (at > 0) {
    const name = bare.slice(0, at);
    const version = bare.slice(at + 1);
    return /^\d/.test(version) ? { name, version } : null;
  }

  // v5 style: name/version.
  const slash = bare.lastIndexOf("/");
  if (slash > 0) {
    const name = bare.slice(0, slash);
    const version = bare.slice(slash + 1);
    return /^\d/.test(version) ? { name, version } : null;
  }

  return null;
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

  // `packageManager` is its own location — `"pnpm@11.20.0"`, outside every
  // dependency section. Rewritten when the pinned name and version match the
  // proposal; the corepack integrity hash (after `+`) belongs to the old
  // version and is dropped rather than carried over wrong.
  let packageManagerRewritten = false;
  const pmField = parsePackageManagerField(pkg.packageManager);
  if (
    pmField !== null &&
    pmField.name === proposal.dependency.name &&
    pmField.version === proposal.currentVersion &&
    /^\d+\.\d+\.\d+/.test(proposal.targetVersion)
  ) {
    pkg.packageManager = `${pmField.name}@${proposal.targetVersion}`;
    packageManagerRewritten = true;
  }

  if (matches.length === 0 && !packageManagerRewritten) {
    // Dependency not found in any section — cannot apply
    return null;
  }

  // Apply updates to all matching sections
  let anyRewritten = packageManagerRewritten;
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
