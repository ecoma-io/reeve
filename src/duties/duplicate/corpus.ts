/**
 * The corpus a duplicate check ranks a thread against.
 *
 * Deliberately not `listOpenThreads` from `core/forge.ts` — a sweep calls both
 * in the same run, and they are not the same listing. `listOpenThreads` hands
 * back a work list: raw bodies, every label, and an `isPullRequest` flag for
 * the caller to decide about thread by thread. This hands back a ranking
 * index, already shaped for BM25 — pull requests dropped outright rather than
 * flagged, the thread being checked excluded, any Reeve-published block cut
 * off by `authorText` so a rank measures what an author wrote, each body
 * bounded by `maxBodyChars`.
 *
 * Their bounds differ in kind too. A sweep's `limit` is a work budget: it caps
 * how many of the threads a listing returned one run then processes, leaving
 * the listing itself to run to `since` or the end of the backlog.
 * `corpus-limit` and `corpus-since` are the whole of what an operator asked
 * the index to *contain*, not a work budget layered on top of an index that
 * already exists — so `limit` here stops the paging itself the moment the
 * corpus holds that many, and otherwise this module pages until `since` is
 * satisfied or GitHub's own listing runs out. Anything stricter would silently
 * shrink the corpus a maintainer configured rather than protect anything.
 */
import { detectLanguage } from "../../core/detect.js";
import type { Location, TrackerApi } from "../../core/forge.js";
import type { Language } from "../../core/languages.js";
import { authorHalf } from "../../core/marker.js";
import { documentOf } from "./rank.js";

/** How many threads one page of the corpus listing carries. GitHub's own ceiling per request. */
const CORPUS_PAGE = 100;

/**
 * The opener every duty's marker starts with, generic across duty names —
 * `<!-- reeve:translate source=`, `<!-- reeve:duplicate source=`, and so on.
 * `core/marker.ts`'s own `Marker.split` only ever recognises one named duty's
 * marker, which is right for a duty checking whether it already wrote into a
 * body itself. The question here is different: this corpus does not know, and
 * does not need to know, which duty (if any) previously published into a
 * candidate's body — only that whatever follows the first Reeve marker of any
 * kind is machine-appended rather than the author's own words.
 */
const ANY_MARKER = /<!-- reeve:[a-z][a-z0-9-]*\ssource=/;

/**
 * DECISION (completeness-audit flag on this duty's corpus): index and judge
 * author text only. A body carrying a published block — today, only
 * `translate`'s, since `duplicate` publishes to a comment rather than the body
 * and no other shipped duty writes into one — has that block cut off before it
 * reaches a query, a candidate document, or the judge.
 *
 * The alternative was including it, on the argument that a thread's own
 * translation makes it lexically reachable from a query written in that
 * language — free cross-language recall. It is not free: a corpus indexed
 * that way ranks partly on how much a body happens to have been translated,
 * so a candidate translated into five languages would out-rank a closer match
 * only ever written in one, for a reason that has nothing to do with how
 * similar the two reports are. `translateToPivot` already buys cross-language
 * recall on purpose, one query at a time, against a corpus of author text —
 * indexing the machine blocks too would make that a second, accidental source
 * of the same thing, one that depends on which threads happened to get
 * translated first rather than on which are actually alike. Stripping keeps
 * ranking measuring one thing: what the two authors wrote.
 *
 * A published block is always the tail of a body once written —
 * `core/publish.ts`'s `assemble` only ever appends after the marker, never
 * before or inside — so cutting at the first marker found and keeping what is
 * in front of it is exactly `Marker.split(body).official`, generalised across
 * every duty's marker rather than one named duty's own.
 */
export function authorText(body: string): string {
  const match = ANY_MARKER.exec(body);
  return match === null ? body : authorHalf(body.slice(0, match.index));
}

/** One open thread as the corpus sees it — enough to rank, nothing a rank never reads. */
export interface CorpusThread {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * Every open thread that belongs in this run's corpus, newest created first.
 *
 * `exclude` drops the thread being checked from its own corpus — it cannot be
 * a duplicate of itself, and BM25 would otherwise hand the judge a perfect
 * match every time. Null skips that filter entirely, which is what a sweep
 * wants: it lists this corpus once, shared across every thread the walk
 * checks, and excludes each thread's own number downstream instead — see
 * `main.ts`'s `runSweep`. Pull requests are dropped the same way
 * `listOpenThreads` drops them: a duplicate check answers "does an issue
 * already describe this", and a pull request implementing something is not
 * that.
 *
 * `limit` stops paging the moment the corpus holds that many threads, so a
 * generous `corpus-limit` on a large repository does not page further than it
 * has to. `since` stops paging the moment a page's oldest entry falls before
 * the bound — the same prefix property `listOpenThreads` relies on, because
 * both listings are sorted newest-created-first.
 *
 * `maxBodyChars` bounds a candidate's body the same way `main.ts`'s `decide`
 * bounds the thread's own — applied after `authorText` strips any published
 * block, so the budget is spent on what a candidate's author wrote, never on
 * a block Reeve itself appended. Null reads the whole thing.
 */
export async function listCorpus(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  exclude: number | null,
  limit: number | null,
  since: Date | null,
  maxBodyChars: number | null = null,
): Promise<readonly CorpusThread[]> {
  const corpus: CorpusThread[] = [];

  for (let page = 1; ; page += 1) {
    const { data } = await api.rest.issues.listForRepo({
      owner: at.owner,
      repo: at.repo,
      state: "open",
      sort: "created",
      direction: "desc",
      per_page: CORPUS_PAGE,
      page,
    });

    let stop = false;
    for (const entry of data) {
      const createdAt = new Date(entry.created_at);
      if (since !== null && createdAt < since) {
        stop = true;
        break;
      }
      if (entry.pull_request !== undefined || entry.number === exclude) continue;

      const authored = authorText(entry.body ?? "");
      corpus.push({
        number: entry.number,
        title: entry.title ?? "",
        body: maxBodyChars === null ? authored : authored.slice(0, maxBodyChars),
        createdAt,
      });

      if (limit !== null && corpus.length >= limit) {
        stop = true;
        break;
      }
    }

    if (stop || data.length < CORPUS_PAGE) break;
  }

  return corpus;
}

/**
 * Whether at least one corpus candidate is written in the pivot language
 * specifically — not merely in some language other than the thread's own —
 * which is the fact the configured languages promise triggers the bridge, and
 * the fact that makes `translateToPivot` worth a request. A corpus that holds
 * a candidate in a third configured language but none in the pivot would
 * still fail to match after the bridge ran, so checking "not the thread's
 * language" would spend a translation a same-language BM25 pass could never
 * have used anyway.
 *
 * Every check here is free: `detectLanguage` is called with no `pick`
 * argument, so it never reaches past script narrowing and the local
 * byte-ngram profile — no model, no request, whatever the size of `corpus`.
 * A candidate `detectLanguage` cannot place at all (`by: "none"`) proves
 * nothing either way and is skipped rather than counted as a match, the same
 * caution `detectLanguage`'s own callers use everywhere else.
 *
 * `cache` memoises a candidate's detected language by its issue number.
 * Cheap on its own, but a sweep offers the same candidate to this function
 * once per thread the walk checks it against, and without this the free
 * detection above would repeat that many times over for no new answer.
 */
export async function crossLanguageCorpus(
  languages: readonly Language[],
  pivotLanguage: Language,
  corpus: readonly CorpusThread[],
  cache: Map<number, Language | null>,
): Promise<boolean> {
  for (const candidate of corpus) {
    let detected: Language | null;
    if (cache.has(candidate.number)) {
      detected = cache.get(candidate.number) ?? null;
    } else {
      detected = (await detectLanguage(documentOf(candidate), languages)).language;
      cache.set(candidate.number, detected);
    }
    if (detected !== null && detected.code === pivotLanguage.code) return true;
  }
  return false;
}
