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
  /**
   * Locale code → file path. Not `readonly`: `findOrCreate` folds newly
   * discovered locales (a language added to the warrant, a bootstrap path)
   * into an existing entry, so `markStale` can see them.
   */
  files: ReadonlyMap<string, string>;
  /** The git SHA of the source file at the time of the last sync. */
  sourceRevision: string;
  /** Locale code → the git SHA of the target file at the time it was last synced. */
  synced: Map<string, string>;
  /**
   * Locale code → the source revision THAT locale is synced to.
   *
   * `sourceRevision` above is a fact about the document group and cannot answer
   * the question this one does. A run syncs its locales one at a time and any
   * of them may fail on its own — a refused draft, a roster out of capacity, a
   * chunk that came back empty — and the group-level revision advanced anyway,
   * at the top of the run, before a single draft was asked for. From the next
   * run's point of view a locale that missed the change and a locale that took
   * it were indistinguishable, and the diff it computed started *after* the
   * change the failed locale never received. The hunk was not retried; it was
   * gone.
   *
   * With a revision per locale, "behind" is a question that has an answer, and
   * a locale that missed a run is stale until it catches up.
   */
  syncedRevision: Map<string, string>;
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

    // Missing is the migration case, and it is read as "every locale that was
    // recorded as synced was synced at the document's revision" — which is
    // exactly what the old shape meant. Reading it as "nothing is synced"
    // would be safe but would re-sync every locale of every document the first
    // time a repository runs this version.
    const syncedRevision = new Map<string, string>();
    if (
      typeof e.syncedRevision === "object" &&
      e.syncedRevision !== null &&
      !Array.isArray(e.syncedRevision)
    ) {
      for (const [locale, sha] of Object.entries(e.syncedRevision as Record<string, unknown>)) {
        if (typeof sha === "string") syncedRevision.set(locale, sha);
      }
    } else {
      for (const locale of synced.keys()) syncedRevision.set(locale, e.sourceRevision);
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
      syncedRevision,
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
    syncedRevision: Object.fromEntries(doc.syncedRevision),
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
 *
 * An existing entry has the discovered files folded in: a locale the state
 * file has never seen (a language newly added to the warrant, or a bootstrap
 * path for a file that does not exist yet) must reach `markStale`, which
 * walks `doc.files` — an entry frozen at first sight would silently pin the
 * group to the locales it had back then.
 */
export function findOrCreate(
  state: DocumentState[],
  id: string,
  files: ReadonlyMap<string, string>,
): DocumentState {
  const existing = state.find((doc) => doc.id === id);
  if (existing !== undefined) {
    const merged = new Map(existing.files);
    let changed = false;
    for (const [locale, path] of files) {
      if (merged.get(locale) !== path) {
        merged.set(locale, path);
        changed = true;
      }
    }
    if (changed) existing.files = merged;
    return existing;
  }

  const doc: DocumentState = {
    id,
    files: new Map(files),
    sourceRevision: "",
    synced: new Map(),
    syncedRevision: new Map(),
    stale: [],
    conflicts: [],
  };
  state.push(doc);
  return doc;
}

/**
 * Marks target locales stale, and locales a human has edited as conflicts.
 *
 * **Stale is a per-locale question now, and that is the whole change.** It used
 * to be asked of the document — "has the source moved since we last touched
 * this group?" — with a short-circuit that returned early whenever it had not.
 * A run that synced `vi` and lost `zh` advanced the group's revision anyway
 * (this function is called before a single draft is asked for), so on the next
 * source change `zh` was diffed from a revision it had never seen, and the hunk
 * it missed was never propagated. Asking each locale whether *it* has caught up
 * makes the fallen-behind locale visible for exactly as long as it is behind.
 *
 * Conflicts are unchanged in substance: a target whose SHA in the tree is not
 * the one we recorded has been edited by a human since, and human work is never
 * overwritten (D3). `pending` is the bot's own write whose SHA the API did not
 * hand back, so it is not evidence of a human edit and never raises one.
 *
 * The one behaviour this adds beside staleness: conflict detection now also
 * runs on a source that has not moved, where the old early return skipped it.
 * That direction is the safe one — it can only stop Reeve writing over an edit
 * somebody made.
 *
 * @param sourceLocale - The locale code of the source language (lowercased).
 */
export function markStale(
  doc: DocumentState,
  currentSourceSha: string,
  currentTargetShas: ReadonlyMap<string, string>,
  sourceLocale: string,
): void {
  const stale: string[] = [];
  const conflicts: string[] = [];

  for (const [locale] of doc.files) {
    // Skip the source locale
    if (locale === sourceLocale) continue;

    const lastSynced = doc.synced.get(locale);
    const currentSha = currentTargetShas.get(locale);

    // "pending" means the locale was just synced by the bot but the real SHA
    // wasn't recorded yet (it becomes available only after the branch write).
    // A pending SHA is not evidence of a human edit — skip conflict detection.
    if (
      currentSha !== undefined &&
      lastSynced !== undefined &&
      lastSynced !== "pending" &&
      currentSha !== lastSynced
    ) {
      conflicts.push(locale);
      continue;
    }

    // Behind the source, whether because the source moved or because this
    // locale missed the run that took it there. A locale with no recorded
    // revision at all is the cold start and the bootstrap case at once: it has
    // never caught up with anything.
    if (doc.syncedRevision.get(locale) !== currentSourceSha) stale.push(locale);
  }

  doc.stale = stale;
  doc.conflicts = conflicts;
  doc.sourceRevision = currentSourceSha;
}

/**
 * The source revision every one of `locales` is synced to, or null when they do
 * not agree on one — which is what a partially failed earlier run leaves behind.
 *
 * Null is the honest answer rather than a nuisance, because there is no way to
 * order two blob SHAs by age: git hands out content digests, and nothing in
 * them says which came first. So a caller that cannot use one baseline for the
 * whole group has to fall back to treating the document as new, which is the
 * only option that cannot silently drop a change one locale still needs.
 *
 * That fallback costs a larger prompt for one run and is self-limiting: once
 * every stale locale has been brought to the same revision they agree again.
 */
export function sharedBaseline(doc: DocumentState, locales: readonly string[]): string | null {
  const revisions = new Set(locales.map((locale) => doc.syncedRevision.get(locale) ?? ""));
  if (revisions.size !== 1) return null;
  const [only] = [...revisions];
  return only === undefined || only === "" ? null : only;
}

/**
 * Records that a locale was fully synced to `sourceRevision`.
 *
 * The revision is a parameter rather than read off `doc` because `doc`'s own
 * revision is advanced by `markStale` at the top of the run, before any drafting
 * — so reading it here would record every locale as caught up whether or not it
 * was, which is precisely the defect this pair of functions exists to fix.
 */
export function markSynced(
  doc: DocumentState,
  locale: string,
  sha: string,
  sourceRevision: string,
): void {
  doc.synced.set(locale, sha);
  doc.syncedRevision.set(locale, sourceRevision);
  doc.stale = doc.stale.filter((s) => s !== locale);
  doc.conflicts = doc.conflicts.filter((c) => c !== locale);
}

/**
 * Records a locale that was written but is NOT caught up — a draft at least one
 * of whose chunks is the original target text, kept because no model replaced it.
 *
 * The file that was written is still the better file, so it is published and its
 * SHA recorded: conflict detection needs to know what Reeve last wrote, or a
 * human edit on top of it cannot be told from Reeve's own bytes. What is
 * deliberately not recorded is a revision, so the locale stays behind and a
 * later run comes back for the chunk this one lost.
 */
export function markPartial(doc: DocumentState, locale: string, sha: string): void {
  doc.synced.set(locale, sha);
  doc.conflicts = doc.conflicts.filter((c) => c !== locale);
}
