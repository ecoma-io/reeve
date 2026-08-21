/**
 * The node-version manager — discovers the Node.js runtime pin from
 * `.node-version` and `.nvmrc`.
 *
 * Deterministic: the same file content produces the same `Dependency` list
 * every time. No LLM, no network.
 *
 * Both files carry a single version reference on their first meaningful line:
 *   - `24` (major-only pin)
 *   - `24.1.0` (full pin)
 *   - `v24.1.0` (nvm's own prefix)
 *   - `lts/*`, `node`, `system` (nvm aliases — discovered, never rewritten)
 *
 * The dependency is always named `node` and belongs to the `node-version`
 * ecosystem, where the Node release index answers for available versions —
 * the npm registry's `node` package is a different artifact and is never
 * consulted for this file.
 *
 * A major-only pin (`24`) is discovered but not proposed for update: it is a
 * range in spirit, and rewriting it to a full version would change what the
 * file means. Only a full `x.y.z` pin is rewritten, preserving any `v` prefix
 * and the file's trailing newline.
 */
import type { Dependency, UpdateProposal } from "../model.js";
import type { Manager, ManagerId, ManagerResult } from "./types.js";

/** The node-version manager identifier. */
const ID: ManagerId = "node-version";

/** Filenames the node-version manager looks for. */
const MANIFEST_FILENAMES = [".node-version", ".nvmrc"] as const;

export function createNodeVersionManager(): Manager {
  return {
    id: ID,
    ecosystem: "node-version",
    manifestFilenames: MANIFEST_FILENAMES,
    parse,
    applyUpdate,
  };
}

/**
 * Parse a `.node-version` / `.nvmrc` file and return the Node runtime pin.
 *
 * The first non-empty, non-comment line is the reference. A file with no
 * such line discovers nothing.
 */
function parse(
  manifestPath: string,
  manifestContent: string,
  _lockfileContent: string | null,
): ManagerResult {
  const reference = firstReference(manifestContent);
  if (reference === null) {
    return { manifestPath, dependencies: [], partial: false };
  }

  const bare = stripPrefix(reference);
  const isFullPin = /^\d+\.\d+\.\d+$/.test(bare);

  const dependencies: Dependency[] = [
    {
      ecosystem: "node-version",
      name: "node",
      constraint: bare,
      // Only a full x.y.z pin is a resolved version; a major-only pin or an
      // nvm alias is a range in spirit, and downstream stages skip what they
      // cannot classify.
      currentVersion: isFullPin ? bare : "",
      manifestPath,
      dev: false,
      manager: ID,
    },
  ];

  return { manifestPath, dependencies, partial: false };
}

/** The first non-empty, non-comment line of the file, or null. */
function firstReference(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

/** Strip nvm's `v` prefix: `v24.1.0` → `24.1.0`. */
function stripPrefix(reference: string): string {
  return reference.startsWith("v") ? reference.slice(1) : reference;
}

/**
 * Apply an update to a `.node-version` / `.nvmrc` file.
 *
 * Only a full `x.y.z` pin is rewritten — a major-only pin or an nvm alias is
 * left alone, because rewriting it would change what the file means. The `v`
 * prefix and the trailing newline are preserved exactly as written.
 */
function applyUpdate(manifestContent: string, proposal: UpdateProposal): string | null {
  const reference = firstReference(manifestContent);
  if (reference === null) return null;

  const bare = stripPrefix(reference);
  if (!/^\d+\.\d+\.\d+$/.test(bare)) return null;
  if (bare !== proposal.currentVersion) return null;
  if (!/^\d+\.\d+\.\d+$/.test(proposal.targetVersion)) return null;

  const prefix = reference.startsWith("v") ? "v" : "";
  const replacement = `${prefix}${proposal.targetVersion}`;

  // Replace only the reference line, preserving comments and the newline shape.
  const lines = manifestContent.split("\n");
  const rewritten = lines.map((line) => (line.trim() === reference ? replacement : line));
  return rewritten.join("\n");
}
