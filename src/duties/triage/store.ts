/**
 * The corrections store's write path — commit a decided correction to the
 * sharded, git-backed store at `corrections`, retrying a lost race and
 * rolling a shard over once it grows too large for the Contents API to
 * inline.
 *
 * No checkout, no git binary, anywhere in this module: every read and write
 * goes through the Contents API, the same way a maintainer opening the store
 * by hand would — one shard at a time, because there is no index to consult
 * instead. `triage/main.ts` is the only caller (through `record.ts`'s
 * `recordCorrection`/`recordReversal`, and directly for `repoRelativePath`,
 * which `act()` also needs ahead of `gateClose`); this module reads and
 * writes the tracker but decides nothing about whether a run may — that gate
 * is narrowed before either `record.ts` or this module is ever reached.
 */
import { relative, isAbsolute } from "node:path";

import * as core from "@actions/core";

import {
  listCorrectionFiles,
  readContentsFile,
  writeContentsFile,
  UnreadableContentsFile,
  type ContentsApi,
  type Location,
} from "../../core/forge.js";
import { formatCorrection, parseCorrection, type Correction } from "../../core/memory.js";

/**
 * How many times a record write may retry after losing a race on a shard's
 * `sha` — the read-modify-write sequence run again from the top, not just the
 * final write, because a concurrent commit can have changed which shard holds
 * this thread as easily as it changed one shard's contents.
 */
const WRITE_ATTEMPTS = 3;

/**
 * Commits `correction` to the store at `path` — replacing the line for this
 * thread wherever it already lives, appending a fresh one when it does not.
 *
 * No checkout, no git binary: every shard already committed is read through
 * the Contents API to look for an existing entry for this thread, the same
 * way a maintainer opening the store by hand would look — one file at a time,
 * because there is no index to consult instead. `contents: write` is what
 * this needs on the token, and its absence is left to fail the way any other
 * authentication problem does: loud, and uncaught.
 *
 * Two record runs racing the same shard is the one failure this retries: the
 * Contents API answers a stale `sha` with a conflict, and re-reading before
 * trying again is the whole fix, because the second run's write was computed
 * against a version of the file that no longer exists. Every other failure —
 * a missing scope, a network error, anything that is not that specific
 * conflict — propagates on the first attempt, the same as it always did.
 */
export async function writeCorrection(
  contentsApi: ContentsApi,
  at: Location,
  path: string,
  correction: Correction,
  stateBranch?: string,
): Promise<void> {
  const relativePath = repoRelativePath(path);

  for (let attempt = 1; ; attempt += 1) {
    try {
      await attemptWrite(contentsApi, at, relativePath, correction, stateBranch);
      return;
    } catch (error) {
      if (attempt >= WRITE_ATTEMPTS || !isShaConflict(error)) throw error;
      core.info(
        `Recording #${String(correction.thread)} lost a race on the store — another commit ` +
          `landed first. Retrying (attempt ${String(attempt + 1)} of ${String(WRITE_ATTEMPTS)}).`,
      );
    }
  }
}

/**
 * Whether `existing` is an exact (repo, thread, duty) match for `correction`
 * — the store's own dedup key, widened twice as `Correction.duty`'s own doc
 * comment explains. A match here is the only line `attemptWrite` ever
 * rewrites in place rather than appends after.
 */
function findExactLine(existing: Correction, correction: Correction): boolean {
  return (
    existing.thread === correction.thread &&
    existing.repo === correction.repo &&
    existing.duty === correction.duty
  );
}

/**
 * Whether this line proves the store holds more than one repository's
 * history — the fact the loose legacy match below has to stay provably false
 * to fire at all. Matching it loosely there would let today's repo silently
 * steal another repository's legacy entry whenever their thread numbers
 * happened to collide.
 *
 * Two shapes prove it: a line this run could not parse at all (garbage
 * proves nothing about whose history it was, so it counts against the loose
 * match rather than for it), or a line carrying a *different* explicit
 * `repo`. A line sharing this correction's own `repo`, or carrying none at
 * all (the pre-`repo` legacy shape), proves nothing either way.
 *
 * A shard this run could not read leaves shared-ness just as unknowable as a
 * foreign repo's line would — this function alone has no way to see it,
 * which is why `attemptWrite`'s loose-match branch checks `unreadable.length
 * === 0` on top of what `provenShared` catches here, rather than trusting
 * this function's answer by itself.
 */
function isProvenShared(existing: Correction | null, correction: Correction): boolean {
  if (existing === null) return true;
  return existing.repo !== "" && existing.repo !== correction.repo;
}

/**
 * Whether `existing` is this thread's own pre-`repo` legacy line — the one
 * `attemptWrite` may rewrite in place instead of appending a fresh entry,
 * once the search has finished and proven the store single-repository.
 *
 * A line written before `repo` existed parses as `repo: ""`, and in a store
 * that has only ever recorded for today's repo, a stored empty repo can only
 * mean "written before this field existed" — read as this thread number's
 * own legacy entry. `duty` is checked here too, deliberately: a legacy
 * `repo: ""` line predates `duty` as well and reads as `"triage"` by
 * default, so a reversal write (`duty: "duplicate"`) never loosely claims a
 * thread's pre-`repo` standing-label line as though it were the same
 * correction.
 *
 * That is what lets a single-repo store self-migrate: the first write a
 * thread sees after the field shipped leaves nothing legacy to match loosely
 * the next time. Even so, only the exact-match branch above, which already
 * compares `duty`, is allowed to treat two lines as one entry outright —
 * this one only ever offers a *candidate*, rewritten in place solely once
 * the whole-store search finishes and {@link isProvenShared} has stayed
 * false throughout.
 */
function legacyCandidate(existing: Correction, correction: Correction): boolean {
  return (
    existing.repo === "" &&
    existing.thread === correction.thread &&
    existing.duty === correction.duty
  );
}

/**
 * One read-modify-write pass, the unit `writeCorrection` retries whole on a
 * conflict.
 *
 * A shard too large for the Contents API to inline (`UnreadableContentsFile`)
 * does not fail the write outright — it is skipped, warned about by name, and
 * the search continues through the rest of the store, so one oversized shard
 * does not brick every recording from now on. What it does refuse is
 * appending: if the thread's existing entry, if it has one, might be sitting
 * in exactly the shard this run could not read, appending a fresh line
 * elsewhere cannot be told apart from silently duplicating it — so that path
 * throws instead, naming the shard that made the answer unknowable.
 *
 * The walk stops the moment {@link findExactLine} matches: nothing later in
 * the store can change what an explicit match means, so the shards past it
 * are never read at all — the common case, a repeat correction on a thread
 * already recorded, costs the reads it takes to find the line and not one
 * more. Only a write that finds no explicit match anywhere has, by then,
 * necessarily read the whole store — which is exactly the knowledge
 * {@link legacyCandidate}'s loose rule needs, gathered as a side-effect of the
 * search rather than as an extra pass. And no shard is retained past its own
 * visit except the single candidate line the loose rule might still rewrite,
 * so a store of many large shards is never held in memory whole. See
 * {@link isProvenShared} and {@link legacyCandidate} for what makes the loose
 * rule safe to fire, and what proves it should not.
 */
export async function attemptWrite(
  contentsApi: ContentsApi,
  at: Location,
  path: string,
  correction: Correction,
  stateBranch?: string,
): Promise<void> {
  const files = await listCorrectionFiles(contentsApi, at, path, stateBranch);
  const unreadable: string[] = [];

  let provenShared = false;
  let candidate: {
    readonly path: string;
    readonly lines: string[];
    readonly sha: string;
    readonly index: number;
  } | null = null;

  for (const file of files) {
    let read: { readonly text: string; readonly sha: string } | null;
    try {
      read = await readContentsFile(contentsApi, at, file.path, stateBranch);
    } catch (error) {
      if (!(error instanceof UnreadableContentsFile)) throw error;
      core.warning(
        `corrections: \`${file.path}\` could not be read, so it was skipped rather than ` +
          "failing the whole write — the search continued through the rest of the store. " +
          "Split the corrections store into smaller shards.",
      );
      unreadable.push(file.path);
      continue;
    }
    if (read === null) continue;
    const lines = read.text.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) continue;
      const existing = parseCorrection(line);

      if (isProvenShared(existing, correction)) provenShared = true;
      if (existing === null) continue;

      if (findExactLine(existing, correction)) {
        const updated = [...lines];
        updated[index] = formatCorrection(correction);
        await writeContentsFile(
          contentsApi,
          at,
          file.path,
          `${updated.join("\n").replace(/\n*$/, "")}\n`,
          commitMessage(correction),
          read.sha,
          stateBranch,
        );
        return;
      }

      if (legacyCandidate(existing, correction) && candidate === null) {
        candidate = { path: file.path, lines, sha: read.sha, index };
      }
    }
  }

  if (candidate !== null && !provenShared && unreadable.length === 0) {
    const lines = [...candidate.lines];
    lines[candidate.index] = formatCorrection(correction);
    await writeContentsFile(
      contentsApi,
      at,
      candidate.path,
      `${lines.join("\n").replace(/\n*$/, "")}\n`,
      commitMessage(correction),
      candidate.sha,
      stateBranch,
    );
    return;
  }

  if (unreadable.length > 0) {
    throw new Error(
      `#${String(correction.thread)} was not found in any shard this run could read, and ` +
        `${unreadable.map((shard) => `\`${shard}\``).join(", ")} could not be read at all. ` +
        "Appending a fresh entry cannot rule out duplicating one already sitting in the shard " +
        "this run could not see, so nothing was written — split the corrections store into " +
        "smaller shards.",
    );
  }

  // Not found in any existing shard: append to this month's, the same
  // sharding a store filled in by hand already uses — small enough that two
  // maintainers correcting different threads the same week append to the same
  // file and git resolves it, rather than every correction becoming a
  // conflict on one file that never rolls over.
  const { shard, existing } = await selectShard(contentsApi, at, path, stateBranch);
  const text =
    existing === null
      ? `${formatCorrection(correction)}\n`
      : `${existing.text.replace(/\n*$/, "")}\n${formatCorrection(correction)}\n`;
  await writeContentsFile(
    contentsApi,
    at,
    shard,
    text,
    commitMessage(correction),
    existing?.sha ?? null,
    stateBranch,
  );
}

/**
 * A soft ceiling on one shard's own size, not a hard one — the Contents API's
 * real limit is the 1 MB `readContentsFile` already treats as unreadable, and
 * this is well under it on purpose, so a shard rolls over while it can still
 * be read and written normally rather than only once it has already crossed
 * into `UnreadableContentsFile` territory.
 */
const SHARD_SOFT_LIMIT_BYTES = 900_000;

/**
 * How many numbered siblings one calendar month's shard may grow before this
 * gives up — not a real ceiling on how much a project may record, only a
 * bound on the loop below, because a bounded loop is one that cannot hang a
 * run over a store that has gone genuinely, unexpectedly enormous.
 */
const MAX_SHARD_ATTEMPTS = 500;

/**
 * This month's shard, and whatever is already in it — `monthShard().ndjson`
 * for the first correction of the month, `monthShard().2.ndjson` once that
 * one has grown past `SHARD_SOFT_LIMIT_BYTES`, and so on. Read once per
 * candidate rather than sized off a directory listing, because size is a
 * property of a shard's own content, not of its name.
 *
 * Rolling over by size rather than only by month keeps `writeCorrection`'s
 * read-modify-write pass — and `attemptWrite`'s search before it — working
 * against files small enough for the Contents API to inline, on a project
 * recording enough corrections that one calendar month would otherwise grow
 * past that on its own.
 */
async function selectShard(
  contentsApi: ContentsApi,
  at: Location,
  path: string,
  stateBranch?: string,
): Promise<{
  readonly shard: string;
  readonly existing: { readonly text: string; readonly sha: string } | null;
}> {
  const base = `${path.replace(/\/+$/, "")}/${monthShard()}`;

  for (let n = 1; n <= MAX_SHARD_ATTEMPTS; n += 1) {
    const shard = n === 1 ? `${base}.ndjson` : `${base}.${String(n)}.ndjson`;
    let existing: { readonly text: string; readonly sha: string } | null;
    try {
      existing = await readContentsFile(contentsApi, at, shard, stateBranch);
    } catch (error) {
      // Unreadable — over the 1 MB the Contents API can inline — is read the
      // same way `attemptWrite`'s own search treats it: not proof the shard
      // is full, but not a shard this run can safely append to either, so
      // the roll-over moves past it exactly as it would past one merely over
      // the soft limit.
      if (!(error instanceof UnreadableContentsFile)) throw error;
      core.warning(
        `corrections: \`${shard}\` could not be read, so a fresh correction rolls over to the ` +
          "next shard instead. Split the corrections store into smaller shards.",
      );
      continue;
    }
    if (existing === null || Buffer.byteLength(existing.text, "utf8") < SHARD_SOFT_LIMIT_BYTES) {
      return { shard, existing };
    }
  }

  throw new Error(
    `corrections: this month's store has grown past ${String(MAX_SHARD_ATTEMPTS)} shards, ` +
      `every one of them already at or past the ${String(SHARD_SOFT_LIMIT_BYTES)}-byte soft ` +
      "limit. That is almost certainly a runaway write loop rather than a genuinely enormous " +
      "month, so this stops here rather than trying a shard 501.",
  );
}

/**
 * Whether `error` is the Contents API's way of saying this write's `sha` is
 * already stale — a 409 always means that, and a 422 means it only when the
 * message names the `sha` field, the same distinction GitHub itself draws
 * between "this ref changed under you" and "this request is simply malformed".
 */
export function isShaConflict(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 409) return true;
  if (status !== 422) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("sha");
}

/**
 * `path`, guaranteed repo-relative before it reaches the Contents API.
 *
 * Recall reads the store straight off disk, where an absolute path resolves
 * the same as a relative one — but record sends this path to the Contents
 * API, which only understands one relative to the repository root. A
 * workflow built with `${{ github.workspace }}` produces exactly this
 * absolute-but-still-inside-the-checkout shape, so that one case is stripped
 * back to relative rather than refused; any other absolute path names
 * somewhere the API cannot express at all, and is rejected rather than
 * half-handled.
 */
export function repoRelativePath(path: string): string {
  if (!isAbsolute(path)) return path;

  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace !== undefined && workspace.length > 0) {
    const stripped = relative(workspace, path);
    if (!isAbsolute(stripped) && !stripped.startsWith("..")) return stripped;
  }

  throw new Error(
    `\`corrections\` (\`${path}\`) is an absolute path record cannot use — the Contents API only ` +
      "understands a path relative to the repository root. Use a repo-relative path, or one " +
      "under `GITHUB_WORKSPACE` if the workflow built it from `${{ github.workspace }}`.",
  );
}

/** This run's shard name — the store rolls over by calendar month. */
export function monthShard(): string {
  const now = new Date();
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The commit message a recorded correction lands with. House voice: plain about what changed. */
export function commitMessage(correction: Correction): string {
  const decided = correction.decided.length > 0 ? correction.decided.join(", ") : "no labels";
  return `memory: record #${String(correction.thread)} as ${decided}`;
}
