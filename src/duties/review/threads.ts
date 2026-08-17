/**
 * Inline findings: the review's second write, beside the owned summary comment.
 *
 * A review is still exactly one owned issue comment (see `publish.ts`) — that
 * comment is the summary, idempotent under its marker, and it is never dropped.
 * What this module adds is the useful half of a human review the summary alone
 * does not have: each finding with a line the diff proves also gets one inline
 * review comment, anchored at that line, so the author answers the finding
 * where it lives rather than scrolling a wall of findings in one comment.
 *
 * **Every inline comment is owned, the same way the summary is owned.** It
 * carries its own marker — `<!-- reeve:review:thread source=<fingerprint>.<key>
 * -->` — written by a bot author, and only a body whose marker parses as a real
 * fingerprint over a nonempty position key is ever touched as Reeve's own. A
 * forged, truncated, or human-authored thread is left alone (D8: untrusted
 * thread text never drives a write).
 *
 * **The key is position-based, not id-based.** `ruleId|path|line`, the same
 * position `reconcile` matches on — preflight findings all share one id, so a
 * finding-id key would collapse every deterministic finding into one thread.
 * Two findings at the same position collapse to one thread, first wins, and the
 * second renders in the summary only.
 *
 * **Idempotency comes from the live listing, never from memory.** Each run
 * lists the pull request's review comments, parses its own threads out, and
 * plans writes against what is actually there: a thread whose rendered body
 * already matches is left alone, a rerun never stacks a second copy. The
 * listing walks pages until a short one, so a thread buried past a hundred
 * comments is still found — the anti-duplicate guard.
 *
 * **A thread whose line GitHub no longer proves falls back to the summary,
 * never a stale thread and never a lost finding.** `createReviewComment` is
 * position-immutable and returns 422 when it cannot anchor; only that one
 * status is caught, and the finding renders summary-only. Every other failure —
 * a missing scope, a denied permission — throws before the summary is written
 * (D5: fail loud, fail closed), so a thread permission problem can never leave
 * a duplicate behind on the next run's relisting.
 */
import { chrome } from "../../core/chrome.js";
import { isBotAuthor, type Author, type Location } from "../../core/forge.js";
import { isFingerprint } from "../../core/marker.js";
import type { DiffStanding, Finding } from "./findings.js";
import { findingFingerprint } from "./findings.js";
import { findingLine } from "./publish.js";

/** The thread marker's literal opener — a local grammar, not core's `markerFor`. */
const THREAD_MARKER = "<!-- reeve:review:thread source=";
const CLOSER = " -->";
/** One listing page — GitHub's own cap, and the anti-duplicate walk's step. */
const PAGE = 100;
/** The listing walk is bounded so a pathological thread count cannot run away. */
const MAX_THREAD_PAGES = 10;
/** A thread body may never exceed GitHub's own 65536-char ceiling with room to spare. */
const THREAD_BODY_CAP = 8000;

/** The part of an Octokit client this module needs — the review-comment trio. */
export interface ReviewThreadApi {
  readonly rest: {
    readonly pulls: {
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: {
          id: number;
          body?: string | null;
          path?: string;
          line?: number | null;
          user?: Author | null;
        }[];
      }>;
      createReviewComment(params: {
        owner: string;
        repo: string;
        pull_number: number;
        body: string;
        commit_id: string;
        path: string;
        line: number;
      }): Promise<unknown>;
      updateReviewComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

/** This duty's own inline thread, as the listing found it. */
export interface OwnedThread {
  readonly id: number;
  /** The position key its marker carries — the identity the plan matches on. */
  readonly key: string;
  /** The thread's body, for the rendered-body idempotency comparison. */
  readonly body: string;
  readonly path: string;
  /** Where GitHub actually placed it — may have drifted from the key's line. */
  readonly line: number | null;
}

export interface OwnedThreads {
  readonly threads: readonly OwnedThread[];
  /**
   * Whether the walk ended at a full page with no owned thread found — a
   * pathological listing could hide one past the walk's bound, so the caller
   * withholds thread writes rather than risk a duplicate.
   */
  readonly uncertain: boolean;
}

/** What one thread sync would do, decided from the live listing. */
export interface ThreadPlan {
  readonly creates: readonly { key: string; finding: Finding }[];
  readonly updates: readonly { id: number; finding: Finding }[];
  /** Position keys that 422'd mid-sync and belong in the summary only. */
  readonly fallback: readonly string[];
}

/** What one thread sync did. */
export interface ThreadSync {
  readonly created: number;
  readonly updated: number;
  readonly fallback: readonly string[];
  readonly uncertain: boolean;
}

/** The position-based thread key: `ruleId|path|line`. */
export function keyOf(finding: Finding): string {
  return `${finding.ruleId}|${finding.path}|${finding.line === null ? "" : String(finding.line)}`;
}

function threadMarker(finding: Finding): string {
  return `${THREAD_MARKER}${findingFingerprint(finding)}.${keyOf(finding)}${CLOSER}`;
}

/**
 * The position key a thread body's marker names, or null when the body carries
 * no marker this duty may touch as its own. A marker whose fingerprint is not
 * sixteen hex characters is text someone typed, a marker with no ` -->` closer
 * is a truncation, and a marker with an empty key names nothing — none of them
 * is a record of this run's own thread, so none is owned.
 */
function ownedThreadKey(body: string): string | null {
  const at = body.indexOf(THREAD_MARKER);
  if (at === -1) return null;
  const from = at + THREAD_MARKER.length;
  const to = body.indexOf(CLOSER, from);
  if (to === -1) return null;
  const payload = body.slice(from, to);
  const dot = payload.indexOf(".");
  if (dot <= 0) return null;
  const fp = payload.slice(0, dot);
  const key = payload.slice(dot + 1);
  if (!isFingerprint(fp) || key.length === 0) return null;
  return key;
}

/**
 * Whether a finding earns an inline thread: a claim that is not resolved, on a
 * line the diff standing still proves. Everything else is summary-only.
 */
export function anchorable(
  entry: { readonly finding: Finding; readonly status: string },
  standing: DiffStanding,
): boolean {
  const { finding, status } = entry;
  if (finding.line === null || status === "resolved") return false;
  const lines = standing.files.get(finding.path);
  if (lines === undefined || lines === null) return false;
  return lines.has(finding.line);
}

/**
 * The thread's body: the finding line, the thread marker, and the fixed
 * machine notice — the same floor `publish.ts` renders under the summary. A
 * finding body is capped so a huge model claim cannot blow the comment; the
 * marker and the notice always survive the cap.
 */
export function threadBody(finding: Finding): string {
  const tail = `\n\n${threadMarker(finding)}\n\n${chrome("reviewFooterFloor", null)}`;
  const prefix = findingLine({ ...finding, body: "" });
  const budget = THREAD_BODY_CAP - prefix.length - tail.length;
  const body =
    budget > 0 && finding.body.length > budget ? finding.body.slice(0, budget) : finding.body;
  return `${findingLine({ ...finding, body })}${tail}`;
}

/**
 * Lists this duty's own threads, walking pages until a short one. A full first
 * page is walked, not assumed empty — the one thing that prevents a duplicate
 * behind a hundred unrelated comments is finding it. The walk is bounded, and
 * ending at a full page with nothing owned is reported as `uncertain` so the
 * caller can withhold writes instead of risking a copy.
 */
export async function listOwnedThreads(api: ReviewThreadApi, at: Location): Promise<OwnedThreads> {
  const threads: OwnedThread[] = [];
  let lastFull = false;
  for (let page = 1; page <= MAX_THREAD_PAGES; page += 1) {
    const { data } = await api.rest.pulls.listReviewComments({
      owner: at.owner,
      repo: at.repo,
      pull_number: at.number,
      per_page: PAGE,
      page,
    });
    for (const comment of data) {
      if (!isBotAuthor(comment.user)) continue;
      const key = ownedThreadKey(comment.body ?? "");
      if (key === null) continue;
      threads.push({
        id: comment.id,
        key,
        body: comment.body ?? "",
        path: comment.path ?? "",
        line: comment.line ?? null,
      });
    }
    lastFull = data.length === PAGE;
    if (!lastFull) break;
  }
  return { threads, uncertain: threads.length === 0 && lastFull };
}

/**
 * Decides the thread writes from the reconciled findings and the live listing,
 * without writing anything.
 *
 * Per anchorable finding, in reconciled order: the first finding at a position
 * owns its thread and later ones render summary-only; a position with no owned
 * thread is a create; a position whose owned thread sits at a different line
 * than the finding now proves is a create at the new line (the old thread is
 * left for GitHub to mark outdated — the update endpoint cannot move one); a
 * position whose thread already renders the same body is left alone. An owned
 * thread whose key matches no current finding is never touched — resolved and
 * outdated threads stay as the history they are.
 */
export function planThreads(
  reconciled: readonly { finding: Finding; status: string }[],
  standing: DiffStanding,
  owned: readonly OwnedThread[],
): ThreadPlan {
  const creates: { key: string; finding: Finding }[] = [];
  const updates: { id: number; finding: Finding }[] = [];
  const claimed = new Set<string>();
  for (const entry of reconciled) {
    if (!anchorable(entry, standing)) continue;
    const key = keyOf(entry.finding);
    if (claimed.has(key)) continue;
    claimed.add(key);
    const at = owned.find((thread) => thread.key === key);
    if (at === undefined) {
      creates.push({ key, finding: entry.finding });
      continue;
    }
    if (at.line !== entry.finding.line || at.path !== entry.finding.path) {
      creates.push({ key, finding: entry.finding });
      continue;
    }
    if (at.body === threadBody(entry.finding)) continue;
    updates.push({ id: at.id, finding: entry.finding });
  }
  return { creates, updates, fallback: [] };
}

function isUnprocessable(error: unknown): boolean {
  return (error as { status?: unknown }).status === 422;
}

/**
 * Writes this run's thread plan, threads before the summary is written.
 * A 422 from create or update — the one status that means "GitHub cannot
 * anchor this comment at this commit" — sends the finding to the fallback list
 * instead of failing the run. Any other error throws: a permission failure
 * aborts before the summary write, and the next run's relisting finds no
 * half-written state.
 */
export async function syncThreads(
  api: ReviewThreadApi,
  at: Location,
  reconciled: readonly { finding: Finding; status: string }[],
  standing: DiffStanding,
  headSha: string,
): Promise<ThreadSync> {
  const { threads, uncertain } = await listOwnedThreads(api, at);
  const plan = planThreads(reconciled, standing, threads);
  const fallback: string[] = [];
  let created = 0;
  let updated = 0;
  for (const entry of plan.creates) {
    try {
      await api.rest.pulls.createReviewComment({
        owner: at.owner,
        repo: at.repo,
        pull_number: at.number,
        body: threadBody(entry.finding),
        commit_id: headSha,
        path: entry.finding.path,
        line: entry.finding.line ?? 0,
      });
      created += 1;
    } catch (error) {
      if (isUnprocessable(error)) {
        fallback.push(entry.key);
        continue;
      }
      throw error;
    }
  }
  for (const entry of plan.updates) {
    try {
      await api.rest.pulls.updateReviewComment({
        owner: at.owner,
        repo: at.repo,
        comment_id: entry.id,
        body: threadBody(entry.finding),
      });
      updated += 1;
    } catch (error) {
      if (isUnprocessable(error)) {
        fallback.push(keyOf(entry.finding));
        continue;
      }
      throw error;
    }
  }
  return { created, updated, fallback, uncertain };
}

/** What the thread sync would do, without doing it — dry-run's rehearsal. */
export async function dryRunThreads(
  api: ReviewThreadApi,
  at: Location,
  reconciled: readonly { finding: Finding; status: string }[],
  standing: DiffStanding,
): Promise<ThreadSync> {
  const { threads, uncertain } = await listOwnedThreads(api, at);
  const plan = planThreads(reconciled, standing, threads);
  return {
    created: plan.creates.length,
    updated: plan.updates.length,
    fallback: [],
    uncertain,
  };
}
