/**
 * The Cargo manager — discovers dependencies from `Cargo.toml`.
 *
 * Deterministic: the same `Cargo.toml` content produces the same `Dependency`
 * list every time. No LLM, no network.
 *
 * Cargo's manifest grammar is TOML with `[dependencies]`, `[dev-dependencies]`,
 * and `[build-dependencies]` tables. Dependencies can be specified as:
 * - Simple: `serde = "1.0"` (version only)
 * - Detailed: `serde = { version = "1.0", features = ["derive"] }`
 * - Git: `serde = { git = "https://github.com/serde-rs/serde" }`
 * - Path: `serde = { path = "../serde" }`
 *
 * Only version-specified dependencies are proposed for update. Git and path
 * dependencies are discovered but carry a null constraint — they are not
 * proposed for update by the semver pipeline.
 */
import type { Dependency, UpdateProposal } from "../model.js";
import type { Manager, ManagerId, ManagerResult } from "./types.js";

/** The Cargo manager identifier. */
const ID: ManagerId = "cargo";

/** Filenames the Cargo manager looks for. */
const MANIFEST_FILENAMES = ["Cargo.toml"] as const;

export function createCargoManager(): Manager {
  return {
    id: ID,
    ecosystem: "cargo",
    manifestFilenames: MANIFEST_FILENAMES,
    parse,
    applyUpdate,
  };
}

/**
 * Parse a `Cargo.toml` and return every dependency found.
 *
 * Reads `[dependencies]`, `[dev-dependencies]`, and `[build-dependencies]`
 * tables. Each entry becomes a `Dependency` with its constraint.
 */
function parse(
  manifestPath: string,
  manifestContent: string,
  lockfileContent: string | null,
): ManagerResult {
  const dependencies: Dependency[] = [];
  let partial = false;

  // Resolve locked versions from Cargo.lock if available
  const lockedVersions = lockfileContent !== null ? parseCargoLock(lockfileContent) : null;
  if (lockfileContent !== null && lockedVersions === null) {
    partial = true;
  }

  // Read each dependency section
  const sections: readonly { key: string; dev: boolean }[] = [
    { key: "dependencies", dev: false },
    { key: "dev-dependencies", dev: true },
    { key: "build-dependencies", dev: false },
  ];

  for (const { key, dev } of sections) {
    const table = extractTomlTable(manifestContent, key);
    if (table === null) continue;

    for (const entry of parseTomlEntries(table)) {
      const { name, constraint } = resolveCargoConstraint(entry.key, entry.value);

      if (constraint === null) {
        // Git/path dependency — discovered but not proposed for update
        dependencies.push({
          ecosystem: "cargo",
          name,
          constraint: null,
          currentVersion: "",
          manifestPath,
          dev,
          manager: ID,
        });
        continue;
      }

      const currentVersion = lockedVersions?.get(name) ?? extractPinnedVersion(constraint);

      dependencies.push({
        ecosystem: "cargo",
        name,
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
 * Extract a TOML table's content from the manifest.
 *
 * Returns the text between `[tablename]` and the next `[` or end of file.
 * This is a simplified parser — it does not handle inline tables at the
 * top level or nested tables, which are not common in Cargo.toml
 * dependency sections.
 */
function extractTomlTable(content: string, tableName: string): string | null {
  const header = `[${tableName}]`;
  const startIdx = content.indexOf(header);
  if (startIdx === -1) return null;

  // Find the next section header
  const afterHeader = startIdx + header.length;
  const nextSection = content.indexOf("\n[", afterHeader);

  if (nextSection === -1) {
    return content.slice(afterHeader);
  }

  return content.slice(afterHeader, nextSection);
}

/** A key-value pair from a TOML table. */
interface TomlEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * Parse key-value pairs from a TOML table section.
 *
 * Handles both simple values (`key = "value"`) and inline tables
 * (`key = { version = "1.0", features = [...] }`).
 */
function parseTomlEntries(tableContent: string): readonly TomlEntry[] {
  const entries: TomlEntry[] = [];

  for (const line of tableContent.split("\n")) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;

    // Match key = value
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (key.length > 0 && value.length > 0) {
      entries.push({ key, value });
    }
  }

  return entries;
}

/**
 * Resolve a Cargo dependency constraint from its TOML value.
 *
 * Handles:
 * - Simple version: `"1.0"` → constraint "1.0"
 * - Detailed table: `{ version = "1.0" }` → constraint "1.0"
 * - Git dependency: `{ git = "..." }` → null (not proposed for update)
 * - Path dependency: `{ path = "..." }` → null (not proposed for update)
 */
function resolveCargoConstraint(
  name: string,
  value: string,
): {
  readonly name: string;
  readonly constraint: string | null;
} {
  // Simple string version: "1.0" or "1.0.0"
  if (value.startsWith('"')) {
    const version = /^"([^"]*)"/.exec(value)?.[1];
    if (version !== undefined) {
      return { name, constraint: version.length > 0 ? version : null };
    }
  }

  // Inline table: { version = "1.0", ... }
  if (value.startsWith("{")) {
    const versionMatch = /version\s*=\s*"([^"]*)"/.exec(value);
    if (versionMatch !== null && (versionMatch[1] ?? "").length > 0) {
      return { name, constraint: versionMatch[1] ?? "" };
    }

    // Git or path dependency in table form
    if (value.includes("git =") || value.includes("path =")) {
      return { name, constraint: null };
    }
  }

  // Cannot determine constraint
  return { name, constraint: null };
}

/**
 * Extract a pinned version from a constraint when no lockfile is available.
 */
function extractPinnedVersion(constraint: string): string {
  // Cargo constraints are typically caret (^) or tilde (~) ranges,
  // or exact versions. Only exact versions are usable as currentVersion.
  const trimmed = constraint.trim();

  // Exact version
  if (/^\d/.test(trimmed) && !trimmed.includes("*") && !trimmed.includes(" ")) {
    return trimmed;
  }

  return "";
}

/**
 * Parse a Cargo.lock file to extract resolved versions.
 *
 * Cargo.lock is TOML. The `[[package]]` entries contain name and version.
 * Returns null when the lockfile cannot be parsed.
 */
function parseCargoLock(content: string): Map<string, string> | null {
  const versions = new Map<string, string>();

  // Parse [[package]] sections
  let currentName: string | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "[[package]]") {
      currentName = null;
      continue;
    }

    // name = "serde"
    const nameMatch = /^name\s*=\s*"([^"]*)"/.exec(trimmed);
    if (nameMatch !== null) {
      currentName = nameMatch[1] ?? null;
      continue;
    }

    // version = "1.0.0"
    const versionMatch = /^version\s*=\s*"([^"]*)"/.exec(trimmed);
    if (versionMatch !== null && currentName !== null) {
      versions.set(currentName, versionMatch[1] ?? "");
      currentName = null; // Reset for next package
    }
  }

  return versions.size > 0 ? versions : null;
}

/**
 * Apply an update to a `Cargo.toml` file, returning the modified content.
 *
 * For simple version strings: replaces the old version with the new one.
 * For inline tables: replaces the `version = "..."` value.
 *
 * Returns null when the old reference is not found in the file.
 */
function applyUpdate(manifestContent: string, proposal: UpdateProposal): string | null {
  const depName = proposal.dependency.name;
  const newVersion = proposal.targetVersion;

  // Find the dependency in the manifest
  const lines = manifestContent.split("\n");
  const newLines: string[] = [];
  let replaced = false;
  let inTargetSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track which dependency section we're in
    if (/^\[(dependencies|dev-dependencies|build-dependencies)\]/.test(trimmed)) {
      inTargetSection = true;
    } else if (trimmed.startsWith("[") && !trimmed.startsWith("[[")) {
      inTargetSection = false;
    }

    if (inTargetSection && !replaced) {
      // Match: name = "old-version" or name = { version = "old-version", ... }
      const simpleMatch = new RegExp(`^${escapeRegex(depName)}\\s*=\\s*"([^"]*)"`).exec(trimmed);
      if (simpleMatch?.[1] !== undefined) {
        newLines.push(line.replace(simpleMatch[1], newVersion));
        replaced = true;
        continue;
      }

      // Inline table: name = { version = "old-version", ... }
      const tableMatch = new RegExp(`^${escapeRegex(depName)}\\s*=\\s*\\{(.*)\\}$`).exec(trimmed);
      if (tableMatch?.[1] !== undefined) {
        const inner = tableMatch[1];
        const updated = inner.replace(/version\s*=\s*"[^"]*"/, `version = "${newVersion}"`);
        newLines.push(line.replace(inner, updated));
        replaced = true;
        continue;
      }
    }

    newLines.push(line);
  }

  if (!replaced) return null;

  return newLines.join("\n");
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
