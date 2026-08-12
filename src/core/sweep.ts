/**
 * The backlog walk four duties share, and the progress it reports.
 *
 * A sweep is the same walk every time: list the open threads, drop the ones
 * this duty never looks at, and work down the rest until the `limit` runs out,
 * the roster runs dry, or the listing does. What changes between duties is
 * what "work" means for one thread — a translation, a verdict, a duplicate
 * check — and that is the one thing this module does not know.
 *
 * **The accumulator is mutated in place, deliberately.** Nothing here returns
 * its progress, because a value returned only on success cannot be read by a
 * caller that never got the return: an `AuthenticationFailure` thrown partway
 * down the loop, a dropped connection on the twenty-first thread. Every duty's
 * `run` declares its accumulator before the `try` and reports from `finally`,
 * so an object the loop writes into is exactly what makes "twenty threads done,
 * then it failed" reportable at all. D12 is the reason it has to be: GitHub
 * capacity is weather, and weather is not a reason to report zero outputs for
 * a sweep that did twenty threads' worth of real work.
 *
 * **Starvation stops the walk; it does not fail it.** `starved` asks whether
 * every model on the roster is grounded, and a walk that finds them all
 * grounded stops and says so rather than spending the rest of the backlog
 * discovering the same answer one thread at a time. The threads it never
 * reached are `remaining`, which is what a repeat sweep exists to pick up.
 */
import type { Listed, Standing } from "./forge.js";
import { starved, type Weather } from "./provider.js";

/**
 * A sweep's progress so far — see this module's own doc comment for why it is
 * written into rather than returned.
 *
 * `Row` is whatever one duty puts in its results table: a number and a
 * sentence, for the three duties that describe an outcome in words, and the
 * whole `Outcome` for lifecycle, whose summary reads the structure back.
 */
export interface SweepAccumulator<Row> {
  readonly results: Row[];
  /**
   * Candidates the walk reached and deliberately did not work: already
   * decided, already translated, filtered out before a single read was spent.
   * Counted apart from `results` so a rerun over a mostly-done backlog reports
   * honestly rather than looking like it did nothing.
   */
  skipped: number;
  /** The roster ran dry mid-walk (D12) — everything already in `results` is real. */
  starvedRun: boolean;
  /** How many threads the listing offered, after this duty's own filter. */
  candidates: number;
  /** Set once, before the listing, when the warrant never named this duty at all. */
  ungranted: string | null;
}

export function newAccumulator<Row>(): SweepAccumulator<Row> {
  return { results: [], skipped: 0, starvedRun: false, candidates: 0, ungranted: null };
}

/** Candidates neither processed nor skipped — what a next sweep still has to look at. */
export function remainingOf<Row>(acc: SweepAccumulator<Row>): number {
  return Math.max(acc.candidates - acc.results.length - acc.skipped, 0);
}

/**
 * What a sweep knows about a thread from the listing alone.
 *
 * The listing endpoint does not carry who opened a thread, its milestone or
 * its assignees — only a per-thread fetch does — and neither triage nor
 * duplicate reads any of the three: ranking a candidate against the thread in
 * hand never turns on who either one's author is, and a label taxonomy is not
 * a judgement about an assignee. So the three are left at their honest
 * "unknown" values rather than a per-thread request bought to fill fields
 * nothing will look at. `respond` is the duty whose bot-author guard reads
 * `author`, and `respond` does not sweep; `lifecycle` reads milestone and
 * assignee state, and pays for the fetch.
 */
export function standingFromListing(thread: Listed): Standing {
  return {
    title: thread.title,
    body: thread.body,
    labels: thread.labels,
    closed: false,
    author: { login: "", isBot: false },
    milestone: null,
    assignees: [],
    createdAt: thread.createdAt,
    isPullRequest: thread.isPullRequest,
  };
}

/** What one duty does differently inside the walk every duty shares. */
export interface SweepHooks<Thread, Row> {
  /**
   * A free, already-answered check on the listing's own fields: this thread
   * has been done before, or is one this duty never touches. Counted as
   * skipped, and never against `limit`.
   */
  readonly alreadyDone?: (thread: Thread) => boolean;
  /**
   * A ceiling of the run's own, checked before starting a thread rather than
   * mid-thread — translate's request budget is the one today. Stops the walk;
   * the caller already holds whatever said so.
   */
  readonly exhausted?: () => boolean;
  /**
   * The work. Returning `null` is "this thread turned out to be a skip after
   * all" — a decision only the work itself could reach.
   */
  readonly processOne: (thread: Thread) => Promise<Row | null>;
  /** Run after each worked thread, for a duty that re-checks something the work itself changed. */
  readonly afterEach?: () => void;
}

/**
 * The walk itself, over candidates the caller has already listed and filtered.
 *
 * The listing stays with the caller because no two duties make the same one:
 * triage passes its own `sweep-state`, duplicate and triage drop pull requests
 * for different reasons, translate keeps them. What is shared is everything
 * after that — the order of the four checks, which one counts as `skipped` and
 * which as `starvedRun`, and the fact that `limit` counts worked threads
 * rather than candidates seen.
 */
export async function sweepThreads<Thread, Row>(
  acc: SweepAccumulator<Row>,
  candidates: readonly Thread[],
  settings: { readonly limit: number | null; readonly models: readonly string[] },
  weather: Weather,
  hooks: SweepHooks<Thread, Row>,
): Promise<void> {
  acc.candidates = candidates.length;

  for (const thread of candidates) {
    if (settings.limit !== null && acc.results.length >= settings.limit) break;

    if (hooks.alreadyDone?.(thread) === true) {
      acc.skipped += 1;
      continue;
    }

    if (starved(settings.models, weather)) {
      acc.starvedRun = true;
      break;
    }

    if (hooks.exhausted?.() === true) break;

    const row = await hooks.processOne(thread);
    if (row === null) acc.skipped += 1;
    else acc.results.push(row);

    hooks.afterEach?.();
  }
}
