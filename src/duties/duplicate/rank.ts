/**
 * Which open threads look like the one in front of this run, by shared words.
 *
 * The same BM25 that `core/memory.ts` runs over the corrections store, over a
 * different corpus: candidates are open threads, not maintainer decisions, and
 * there is no `Correction` to construct one from. A second BM25 implementation
 * here would be the fork `lexical` and `tokenise` are exported to prevent, so
 * this module borrows both and supplies only what is specific to ranking a
 * corpus of threads — the document shape and the cross-language merge.
 */
import { lexical, type Similarity } from "../../core/memory.js";

/** One open thread, as the corpus lists it. */
export interface Candidate {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface Ranked {
  readonly candidate: Candidate;
  readonly score: number;
}

/** What a candidate is matched on — title and body, nothing else is indexed. */
export function documentOf(candidate: Candidate): string {
  return [candidate.title, candidate.body].join("\n\n");
}

/**
 * The candidates most like `queries`, closest first, at most `limit` of them.
 *
 * `queries` takes more than one string so a cross-language run can rank the
 * thread's own text and its pivot-language translation in the same pass: each
 * query is scored against the same candidate documents and a candidate keeps
 * the best score any query found it with. That is the whole of the bridge —
 * candidates are never translated, only the query is, because translating a
 * whole corpus on every run is a cost `translateToPivot` was built to spend
 * once per thread rather than once per candidate. A same-language candidate
 * scores highest off the thread's own text; a candidate that happens to be
 * written in the pivot language scores off the translated one instead — a
 * single merged ranking either way, not two lists a caller has to reconcile.
 *
 * A caller with exactly one query — the ordinary, same-language run — gets
 * that query's own ranking back, merge or no merge.
 */
export function rank(
  queries: readonly string[],
  candidates: readonly Candidate[],
  limit: number,
  similarity: Similarity = lexical,
): readonly Ranked[] {
  if (candidates.length === 0 || limit <= 0) return [];

  const documents = candidates.map(documentOf);
  // Keyed by index but storing the candidate alongside its score, so the
  // ranking below never has to index back into `candidates` — a lookup a
  // type checker cannot know always resolves, even though `index` here always
  // does: it came from iterating `documents`, which is `candidates.map`.
  const best = new Map<number, Ranked>();

  for (const query of queries) {
    if (query.trim().length === 0) continue;
    const scores = similarity(query, documents);
    scores.forEach((score, index) => {
      if (score <= 0) return;
      const candidate = candidates[index];
      if (candidate === undefined) return;
      const current = best.get(index);
      if (current === undefined || score > current.score) best.set(index, { candidate, score });
    });
  }

  return [...best.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      // Ties broken by thread number, descending, so the newer of two equally
      // similar candidates — the one more likely to be an active duplicate
      // rather than a stale one already dealt with — sorts first.
      return right.candidate.number - left.candidate.number;
    })
    .slice(0, limit);
}
