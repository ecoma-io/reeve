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

    for (const entry of parseTomlEntries(table, key)) {
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
 * Returns the text between `[tablename]` and the next section header that
 * is NOT a sub-table of `tablename`.
 *
 * Sub-tables (dotted headers like `[dependencies.serde]`) extend their parent
 * table — their content belongs to the same dependency section. This function
 * includes sub-table content by continuing past dotted headers that start with
 * `[tablename.`.
 *
 * Handles both:
 * - A bare `[tablename]` header followed by key=value entries
 * - Only dotted sub-tables like `[tablename.dep]` with no bare header
 *
 * Array-of-tables headers like `[[example]]` are NOT sub-tables of
 * `[dependencies]`, so they terminate the section.
 */
function extractTomlTable(content: string, tableName: string): string | null {
  const header = `[${tableName}]`;
  const subHeader = `[${tableName}.`;

  // Find the start: either a bare header [tablename] or a sub-table [tablename.X]
  let startIdx = -1;
  let startsWithSubTable = false;

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "[") continue;
    // Must be at line start or after a newline
    if (i > 0 && content[i - 1] !== "\n") continue;

    // Check for bare header
    if (content.slice(i).startsWith(header)) {
      // Make sure it's not a sub-table by checking the char after the header
      const afterHeader = i + header.length;
      if (
        afterHeader >= content.length ||
        content[afterHeader] === "\n" ||
        content[afterHeader] === "]"
      ) {
        startIdx = i;
        startsWithSubTable = false;
        break;
      }
      // It's something like [dependencies.serde] — keep looking
    }

    // Check for sub-table header
    if (content.slice(i).startsWith(subHeader)) {
      startIdx = i;
      startsWithSubTable = true;
      break;
    }
  }

  if (startIdx === -1) return null;

  if (startsWithSubTable) {
    // No bare header — extract from the first sub-table
    return extractFromSubTableStart(content, startIdx, tableName);
  }

  return extractFromHeader(content, startIdx, header, tableName);
}

/**
 * Extract content when the section starts with a sub-table (no bare header).
 */
function extractFromSubTableStart(content: string, startIdx: number, tableName: string): string {
  // The sub-table header IS part of the content we return
  let searchFrom = startIdx;
  let endIdx = -1;

  while (searchFrom < content.length) {
    const nextBracket = content.indexOf("\n[", searchFrom + 1);
    if (nextBracket === -1) {
      endIdx = -1;
      break;
    }

    const headerStart = nextBracket + 1;
    const afterBracket = headerStart + 1;

    // Array-of-tables: [[ — always a different section
    if (content[afterBracket] === "[") {
      endIdx = nextBracket;
      break;
    }

    const headerEnd = content.indexOf("]", afterBracket);
    if (headerEnd === -1) {
      endIdx = nextBracket;
      break;
    }

    const headerName = content.slice(afterBracket, headerEnd);

    // Same table or sub-table — continue
    if (headerName === tableName || headerName.startsWith(`${tableName}.`)) {
      searchFrom = headerEnd + 1;
      continue;
    }

    endIdx = nextBracket;
    break;
  }

  if (endIdx === -1) {
    return content.slice(startIdx);
  }

  return content.slice(startIdx, endIdx);
}

/**
 * Extract content starting from a found header, scanning past sub-tables.
 */
function extractFromHeader(
  content: string,
  startIdx: number,
  header: string,
  tableName: string,
): string {
  const afterHeader = startIdx + header.length;

  // Scan forward, skipping sub-table headers that extend this table
  let endIdx = -1;
  let searchFrom = afterHeader;

  while (searchFrom < content.length) {
    const nextBracket = content.indexOf("\n[", searchFrom);
    if (nextBracket === -1) {
      // No more section headers — rest of file belongs to this table
      endIdx = -1;
      break;
    }

    // Check what follows the \n[
    const headerStart = nextBracket + 1; // Position of the [
    const afterBracket = headerStart + 1; // Position after [

    // Array-of-tables: [[ — always a different section
    if (content[afterBracket] === "[") {
      endIdx = nextBracket;
      break;
    }

    // Find the end of this header line
    const headerEnd = content.indexOf("]", afterBracket);
    if (headerEnd === -1) {
      endIdx = nextBracket;
      break;
    }

    const headerName = content.slice(afterBracket, headerEnd);

    // Is this a sub-table of our table? (e.g. `dependencies.serde` when tableName is `dependencies`)
    if (headerName === tableName || headerName.startsWith(`${tableName}.`)) {
      // It's the same table or a sub-table — continue scanning past it
      searchFrom = headerEnd + 1;
      continue;
    }

    // Different table — this is where our section ends
    endIdx = nextBracket;
    break;
  }

  if (endIdx === -1) {
    return content.slice(afterHeader);
  }

  return content.slice(afterHeader, endIdx);
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
 *
 * Also handles sub-table headers like `[dependencies.serde]` — the sub-table
 * name becomes the dependency key, and `version = "..."` inside the sub-table
 * is associated with it. Other sub-table keys (features, etc.) are ignored.
 */
function parseTomlEntries(tableContent: string, parentTable?: string): readonly TomlEntry[] {
  const entries: TomlEntry[] = [];
  let currentSubTable: string | null = null;

  for (const line of tableContent.split("\n")) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;

    // Sub-table header: [dependencies.serde] or [dev-dependencies.tokio]
    // These extend the parent table — the sub-table name is the dependency name.
    const subTableMatch = /^\[(\S+)\]$/.exec(trimmed);
    if (subTableMatch !== null) {
      const headerName = subTableMatch[1] ?? "";
      // Only recognise sub-tables of our parent (e.g. `dependencies.serde` when
      // parentTable is `dependencies`). If no parentTable, skip this check.
      if (
        parentTable !== undefined &&
        (headerName === parentTable || headerName.startsWith(`${parentTable}.`))
      ) {
        // Extract the part after the parent table name + dot
        const dotParts = headerName.split(".");
        // e.g. `dependencies.serde` → last part is `serde`
        // e.g. `dependencies.serde` when parentTable is `dependencies` → `serde`
        if (dotParts.length >= 2 && dotParts[0] === parentTable) {
          currentSubTable = dotParts.slice(1).join(".");
        } else {
          currentSubTable = null;
        }
      } else if (parentTable === undefined) {
        // No parent context — extract last part after the dot
        const dotParts = headerName.split(".");
        if (dotParts.length >= 2) {
          currentSubTable = dotParts.slice(1).join(".");
        } else {
          currentSubTable = null;
        }
      } else {
        currentSubTable = null;
      }
      continue;
    }

    // Match key = value
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (key.length > 0 && value.length > 0) {
      if (currentSubTable !== null) {
        // Inside a sub-table like [dependencies.serde]
        // Only the `version` key matters for dependency discovery
        if (key === "version") {
          entries.push({ key: currentSubTable, value });
        }
        // Skip other sub-table keys (features, default-features, etc.)
        continue;
      }
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
 * For sub-tables (`[dependencies.serde]`): replaces the `version = "..."` line
 * within the sub-table.
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
  let inSubTable = false; // Inside a [dependencies.X] sub-table

  for (const line of lines) {
    const trimmed = line.trim();

    // Track which dependency section we're in
    if (/^\[(dependencies|dev-dependencies|build-dependencies)\]/.test(trimmed)) {
      inTargetSection = true;
      inSubTable = false;
    } else if (/^\[(dependencies|dev-dependencies|build-dependencies)\./.test(trimmed)) {
      // Sub-table like [dependencies.serde] — still in the dependency section.
      // Check if this sub-table is for our target dependency.
      const subTableMatch = /^\[(dependencies|dev-dependencies|build-dependencies)\.(.+)\]$/.exec(
        trimmed,
      );
      inTargetSection = true;
      inSubTable = subTableMatch?.[2] === depName;
    } else if (trimmed.startsWith("[") && !trimmed.startsWith("[[")) {
      // A different section — stop looking
      inTargetSection = false;
      inSubTable = false;
    }

    if (inTargetSection) {
      // Sub-table version: under [dependencies.serde], the line is just `version = "1.0"`
      if (inSubTable) {
        const versionMatch = /^version\s*=\s*"([^"]*)"/.exec(trimmed);
        if (versionMatch?.[1] !== undefined) {
          newLines.push(line.replace(versionMatch[1], newVersion));
          replaced = true;
          inSubTable = false; // Done with this sub-table
          continue;
        }
      }

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
