/**
 * Provenance tracking for the `harmonise` duty.
 *
 * State file at `${provenance-dir}/state.json` tracks per-document sync
 * status: which source revision was last synced, and which locale variants
 * are up to date or stale.
 *
 * When a source file's SHA changes from the recorded `sourceRevision`,
 * target locales are marked stale. If a target locale has been edited since
 * its `synced` revision, report conflict — D3: human work is inviolable.
 */
import {
  type ContentsApi,
  type Location,
  readContentsFile,
  writeContentsFile,
} from "../../core/forge.js";

/** One document's sync status. */
export interface DocumentState {
  /** The document group's base name — e.g. `docs/getting-started`. */
  readonly id: string;
  /** Locale code → file path. */
  readonly files: ReadonlyMap<string, string>;
  /** The git SHA of the source file at the time of the last sync. */
  sourceRevision: string;
  /** Locale code → the git SHA of the target file at the time it was last synced. */
  synced: Map<string, string>;
  /** Locale codes that are stale — source has changed since last sync. */
  stale: string[];
  /** Locale codes that have conflicts — human edit since last sync. */
  conflicts: string[];
}

/** The full state file contents. */
export type StateFile = DocumentState[];

/**
 * Reads the state file, or returns empty when it does not exist yet.
 *
 * A missing state file is the cold start — a repository that has never run
 * `harmonise` has no sync status, and every document group is considered
 * stale from scratch.
 *
 * When `stateBranch` is given, reads from the default branch first and falls
 * back to the state branch when the file is not found there. This supports the
 * cold-start scenario where a PR with the state file has been opened but not
 * yet merged: the state branch holds the current state, while the default
 * branch has not caught up yet.
 *
 * Returns the parsed state and two SHAs: `sha` from the default branch (or
 * null if not found there), and `branchSha` from the state branch (or null if
 * not found there, or if `stateBranch` was not given).
 */
export async function readState(
  api: ContentsApi,
  at: Pick<Location, "owner" | "repo">,
  path: string,
  stateBranch?: string,
): Promise<{
  readonly state: StateFile;
  readonly sha: string | null;
  readonly branchSha: string | null;
}> {
  // Read from the default branch first
  const file = await readContentsFile(api, at, path);
  if (file !== null) {
    return { state: parseState(file.text, path), sha: file.sha, branchSha: null };
  }

  // Not on default branch — try the state branch if configured
  if (stateBranch !== undefined && stateBranch !== "") {
    const branchFile = await readContentsFile(api, at, path, stateBranch);
    if (branchFile !== null) {
      return { state: parseState(branchFile.text, path), sha: null, branchSha: branchFile.sha };
    }
  }

  // Not found anywhere — cold start
  return { state: [], sha: null, branchSha: null };
}

/**
 * Parses the JSON text of a state file into a `StateFile`.
 *
 * Extracted from `readState` so both read paths (default branch and state
 * branch) share the same validation, and so `serialiseState` has a pure
 * inverse for tests.
 */
function parseState(text: string, path: string): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `harmonise: \`${path}\` could not be parsed as JSON — the provenance state file is malformed. ` +
        "Delete it to force a full re-sync, or fix the syntax.",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `harmonise: \`${path}\` is not a JSON array — the provenance state file is malformed.`,
    );
  }

  const state: DocumentState[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `harmonise: \`${path}\` has an entry that is not a JSON object — the provenance state file is malformed.`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string") {
      throw new Error(
        `harmonise: \`${path}\` has an entry without a string \`id\` — the provenance state file is malformed.`,
      );
    }
    if (typeof e.sourceRevision !== "string") {
      throw new Error(
        `harmonise: \`${path}\` has an entry without a string \`sourceRevision\` — the provenance state file is malformed.`,
      );
    }

    const files = new Map<string, string>();
    if (typeof e.files === "object" && e.files !== null && !Array.isArray(e.files)) {
      for (const [locale, filePath] of Object.entries(e.files as Record<string, unknown>)) {
        if (typeof filePath === "string") files.set(locale, filePath);
      }
    }

    const synced = new Map<string, string>();
    if (typeof e.synced === "object" && e.synced !== null && !Array.isArray(e.synced)) {
      for (const [locale, sha] of Object.entries(e.synced as Record<string, unknown>)) {
        if (typeof sha === "string") synced.set(locale, sha);
      }
    }

    const stale = Array.isArray(e.stale)
      ? (e.stale as unknown[]).filter((s): s is string => typeof s === "string")
      : [];

    const conflicts = Array.isArray(e.conflicts)
      ? (e.conflicts as unknown[]).filter((c): c is string => typeof c === "string")
      : [];

    state.push({
      id: e.id,
      files,
      sourceRevision: e.sourceRevision,
      synced,
      stale,
      conflicts,
    });
  }

  return state;
}

/**
 * Serialises a `StateFile` to the JSON string written to disk.
 *
 * Extracted from `writeState` so the branch-write path in `main.ts` can
 * serialise state content for `publishState` without going through the
 * GitHub API — the same pattern `publishSync` follows for locale files,
 * where `draft.ts` produces text and `publish.ts` writes it.
 */
export function serialiseState(state: StateFile): string {
  const serialised = state.map((doc) => ({
    id: doc.id,
    files: Object.fromEntries(doc.files),
    sourceRevision: doc.sourceRevision,
    synced: Object.fromEntries(doc.synced),
    stale: doc.stale,
    conflicts: doc.conflicts,
  }));

  return JSON.stringify(serialised, null, 2) + "\n";
}

/**
 * Writes the state file back to the repository.
 *
 * Uses `serialiseState` for the JSON conversion — the branch-write path in
 * `main.ts` calls `serialiseState` directly and writes via `publishState`
 * instead, so both paths produce the same output.
 */
export async function writeState(
  api: ContentsApi,
  at: Pick<Location, "owner" | "repo">,
  path: string,
  state: StateFile,
  sha: string | null,
): Promise<void> {
  await writeContentsFile(
    api,
    at,
    path,
    serialiseState(state),
    "harmonise: update provenance state",
    sha,
  );
}

/**
 * Finds or creates a DocumentState for the given group id.
 */
export function findOrCreate(
  state: DocumentState[],
  id: string,
  files: ReadonlyMap<string, string>,
): DocumentState {
  const existing = state.find((doc) => doc.id === id);
  if (existing !== undefined) return existing;

  const doc: DocumentState = {
    id,
    files: new Map(files),
    sourceRevision: "",
    synced: new Map(),
    stale: [],
    conflicts: [],
  };
  state.push(doc);
  return doc;
}

/**
 * Marks target locales as stale when the source revision has changed.
 *
 * Also detects conflicts: if a target locale's current SHA differs from its
 * last synced SHA, a human has edited it since the last sync, and we must
 * not overwrite (D3).
 *
 * @param sourceLocale - The locale code of the source language (lowercased).
 */
export function markStale(
  doc: DocumentState,
  currentSourceSha: string,
  currentTargetShas: ReadonlyMap<string, string>,
  sourceLocale: string,
): void {
  // No change since last sync — nothing to do
  if (doc.sourceRevision === currentSourceSha && doc.sourceRevision !== "") return;

  const stale: string[] = [];
  const conflicts: string[] = [];

  for (const [locale] of doc.files) {
    // Skip the source locale
    if (locale === sourceLocale) continue;

    const lastSynced = doc.synced.get(locale);
    const currentSha = currentTargetShas.get(locale);

    if (currentSha !== undefined && lastSynced !== undefined && currentSha !== lastSynced) {
      // Human edit since last sync — conflict
      conflicts.push(locale);
    } else {
      stale.push(locale);
    }
  }

  doc.stale = stale;
  doc.conflicts = conflicts;
  doc.sourceRevision = currentSourceSha;
}

/**
 * Records that a locale was successfully synced.
 */
export function markSynced(doc: DocumentState, locale: string, sha: string): void {
  doc.synced.set(locale, sha);
  doc.stale = doc.stale.filter((s) => s !== locale);
  doc.conflicts = doc.conflicts.filter((c) => c !== locale);
}
