/**
 * Property-based tests for the duplicate-detection ranking.
 *
 * `rank` decides which open threads a model is shown as possible duplicates of
 * the one in front of the run, and the model may only pick from that list — so
 * a candidate that fails to make the cut cannot be chosen, and a thread can be
 * closed as a duplicate of whichever candidate did.
 *
 * The corpus is assembled by paging `issues.listForRepo` (`corpus.ts`), which
 * means its order is **the tracker's**, not this repository's: a page boundary,
 * a thread edited between two pages, or a different `corpus-limit` all hand the
 * same set of open threads over in a different sequence. `rank.test.ts` pins
 * one hand-written tie against that. This file states the whole claim over a
 * generated corpus instead:
 *
 *  - a candidate's score is a function of the corpus, never of where in it the
 *    candidate sits — BM25's document frequency and average length are both
 *    corpus-wide, so a permutation that moved a single score would mean the
 *    ranking had started reading position;
 *  - the ranked list, the scores on it, and **which candidates survive the
 *    `limit` cut**, are identical for every permutation of the corpus;
 *  - the same holds for the order the queries were listed in, which is the
 *    cross-language seam: a caller has a thread's own text and its pivot-language
 *    translation, and which of the two it puts first is its own detail.
 *
 * The corpus vocabulary is deliberately small and shared, so generated
 * candidates collide on score and the tie-break is exercised rather than
 * skipped past. Every `fc.assert` carries a fixed seed.
 *
 * ── The relevance property, and why it is first ────────────────────────────
 *
 * Every claim above is an *invariance* claim, and an adversarial review of
 * this file made the cost of that plain: it replaced `rank` with a scorer that
 * ignores the queries entirely and returns every candidate with `score: 1`,
 * and all six properties passed. They had to — a permutation-invariance claim
 * is true of any function that does not read position, including one that does
 * not read anything.
 *
 * So the file now leads with a property that has the opposite shape: the
 * output must depend on the query. `lexical`'s BM25 weight carries a `+ 1`
 * inside its logarithm precisely so a term is never worth zero or less, which
 * makes the relationship exact rather than approximate — a candidate sharing a
 * token with some query scores above zero, one sharing none scores exactly
 * zero, and `rank` drops every candidate at or below zero before it sorts.
 * That is an iff, and it is what the constant scorer fails on its first case.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { tokenise } from "../../core/memory.js";

import { rank, type Candidate, type Ranked } from "./rank.js";

// ── Arbitraries ──────────────────────────────────────────────────────────

/**
 * The words an issue tracker for one product is actually written in. Uniform
 * random text would give every candidate a score of zero and every comparison
 * a tie, which proves nothing about a ranking.
 */
const VOCABULARY = [
  "export",
  "csv",
  "empty",
  "zero",
  "byte",
  "download",
  "slow",
  "timeout",
  "login",
  "redirect",
  "column",
  "order",
  "total",
  "date",
  "crash",
  "报表导出为空",
  "xuất khẩu trống",
];

const phrase = fc
  .array(fc.constantFrom(...VOCABULARY), { minLength: 1, maxLength: 8 })
  .map((words) => words.join(" "));

/**
 * A corpus of open threads with distinct numbers — distinct because the
 * tie-break is the thread number, and two candidates sharing one would leave
 * the comparator with nothing left to decide on.
 */
const corpusArb: fc.Arbitrary<readonly Candidate[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 9999 }), { minLength: 1, maxLength: 12 })
  .chain((numbers) =>
    fc.tuple(
      ...numbers.map((number) =>
        fc.record({ number: fc.constant(number), title: phrase, body: phrase }),
      ),
    ),
  );

const queriesArb = fc.array(phrase, { minLength: 1, maxLength: 3 });

/** A permutation of `items` — same members, order chosen by the generator. */
function permutation<T>(items: readonly T[]): fc.Arbitrary<readonly T[]> {
  return fc.shuffledSubarray([...items], { minLength: items.length, maxLength: items.length });
}

/** A list and one of its permutations, drawn together so a single property can compare them. */
function withPermutation<T>(
  arbitrary: fc.Arbitrary<readonly T[]>,
): fc.Arbitrary<readonly [readonly T[], readonly T[]]> {
  return arbitrary.chain((items) => fc.tuple(fc.constant(items), permutation(items)));
}

function shape(ranked: readonly Ranked[]): readonly { number: number; score: number }[] {
  return ranked.map((entry) => ({ number: entry.candidate.number, score: entry.score }));
}

// ── Relevance: the output depends on the query ───────────────────────────

/** Every distinct token across a candidate's title and body, as `rank` reads them. */
function tokensOf(candidate: Candidate): Set<string> {
  return new Set([...tokenise(candidate.title), ...tokenise(candidate.body)]);
}

/** Whether `candidate` shares at least one token with at least one query. */
function shares(candidate: Candidate, queries: readonly string[]): boolean {
  const mine = tokensOf(candidate);
  return queries.some((query) => tokenise(query).some((term) => mine.has(term)));
}

describe("the ranking reads the query", () => {
  it("offers no candidate that shares nothing with any query", () => {
    // The direction that kills a scorer which ignores its input: a model may
    // only close a thread as a duplicate of a candidate on this list, so a
    // candidate the query has nothing to do with must never reach it.
    fc.assert(
      fc.property(
        corpusArb,
        queriesArb,
        fc.integer({ min: 1, max: 12 }),
        (corpus, queries, limit) => {
          for (const entry of rank(queries, corpus, limit)) {
            expect({
              number: entry.candidate.number,
              shares: shares(entry.candidate, queries),
            }).toEqual({ number: entry.candidate.number, shares: true });
            expect(entry.score).toBeGreaterThan(0);
          }
          return true;
        },
      ),
      { numRuns: 400, seed: 20_260_821 },
    );
  });

  it("offers every candidate that does share, when the limit does not cut it", () => {
    // The other direction, so the property above cannot be satisfied by
    // returning nothing at all. With the limit at the corpus size there is no
    // cut, so the offered set is exactly the sharing set — an iff, which is
    // what `lexical`'s strictly-positive term weight makes true.
    fc.assert(
      fc.property(corpusArb, queriesArb, (corpus, queries) => {
        const offered = new Set(
          rank(queries, corpus, corpus.length).map((entry) => entry.candidate.number),
        );
        const sharing = new Set(
          corpus.filter((candidate) => shares(candidate, queries)).map((c) => c.number),
        );

        expect([...offered].sort((a, b) => a - b)).toEqual([...sharing].sort((a, b) => a - b));
        return true;
      }),
      { numRuns: 400, seed: 20_260_821 },
    );
  });
});

// ── The corpus's own order ───────────────────────────────────────────────

describe("the ranking is a function of the corpus, not of the order the tracker listed it", () => {
  it("gives the identical ranking and the identical scores for any permutation", () => {
    fc.assert(
      fc.property(
        withPermutation(corpusArb),
        queriesArb,
        fc.integer({ min: 1, max: 12 }),
        ([corpus, shuffled], queries, limit) => {
          expect(shape(rank(queries, shuffled, limit))).toEqual(
            shape(rank(queries, corpus, limit)),
          );
          return true;
        },
      ),
      { numRuns: 400, seed: 20_260_821 },
    );
  });

  it("cuts the same tail at the limit, so a candidate cannot page in and out between runs", () => {
    // The cut is where an order dependency does the damage: a candidate that
    // did not make the list cannot be chosen, and a thread nobody touched would
    // be closed as a duplicate on one run and not the next.
    fc.assert(
      fc.property(
        withPermutation(corpusArb),
        queriesArb,
        fc.integer({ min: 1, max: 12 }),
        ([corpus, shuffled], queries, limit) => {
          const straight = rank(queries, corpus, limit).map((r) => r.candidate.number);
          expect(rank(queries, shuffled, limit).map((r) => r.candidate.number)).toEqual(straight);
          expect(
            rank(queries, [...corpus].reverse(), limit).map((r) => r.candidate.number),
          ).toEqual(straight);
          // And the cut is a prefix of the uncut ranking, never a resample.
          const uncut = rank(queries, corpus, corpus.length).map((r) => r.candidate.number);
          expect(straight).toEqual(uncut.slice(0, limit));
          return true;
        },
      ),
      { numRuns: 150, seed: 20_260_821 },
    );
  });

  it("scores one candidate the same wherever it sits in the corpus", () => {
    // Stated per candidate rather than per list, so a failure names the entry
    // whose score moved rather than "the arrays differ".
    fc.assert(
      fc.property(corpusArb, queriesArb, (corpus, queries) => {
        const byNumber = new Map(
          rank(queries, corpus, corpus.length).map((r) => [r.candidate.number, r.score]),
        );
        for (let cut = 0; cut < corpus.length; cut += 1) {
          const rotated = [...corpus.slice(cut), ...corpus.slice(0, cut)];
          for (const entry of rank(queries, rotated, corpus.length)) {
            expect(byNumber.get(entry.candidate.number)).toBe(entry.score);
          }
        }
        return true;
      }),
      { numRuns: 100, seed: 20_260_821 },
    );
  });

  it("breaks every tie on the record, so the ranking is total over a corpus of distinct threads", () => {
    // The property above would also pass if the ranking merely happened to be
    // stable. This one is the reason it is not luck: for any corpus of distinct
    // numbers the output is strictly descending in (score, number), which is a
    // total order and therefore cannot depend on input order at all.
    fc.assert(
      fc.property(corpusArb, queriesArb, (corpus, queries) => {
        const ranked = rank(queries, corpus, corpus.length);
        for (let at = 1; at < ranked.length; at += 1) {
          const left = ranked[at - 1];
          const right = ranked[at];
          if (left === undefined || right === undefined) continue;
          const strictlyOrdered =
            left.score > right.score ||
            (left.score === right.score && left.candidate.number > right.candidate.number);
          expect(strictlyOrdered).toBe(true);
        }
        return true;
      }),
      { numRuns: 300, seed: 20_260_821 },
    );
  });
});

// ── The order the queries were listed in ─────────────────────────────────

describe("the cross-language merge does not read the order its queries arrived in", () => {
  it("merges to the identical ranking for any permutation of the queries", () => {
    // Each candidate keeps the best score any query found it with, and a
    // maximum does not care what order it saw its arguments in. A caller with
    // one query gets that query's ranking back, merge or no merge — which is
    // the same statement at length one.
    fc.assert(
      fc.property(
        corpusArb,
        withPermutation(fc.array(phrase, { minLength: 2, maxLength: 4 })),
        fc.integer({ min: 1, max: 12 }),
        (corpus, [queries, reordered], limit) => {
          expect(shape(rank(reordered, corpus, limit))).toEqual(
            shape(rank(queries, corpus, limit)),
          );
          return true;
        },
      ),
      { numRuns: 400, seed: 20_260_821 },
    );
  });

  it("a blank query changes nothing, wherever in the list it was put", () => {
    // Blank queries are skipped rather than scored, and `translateToPivot`
    // hands one back when every model rotated past it — so this is the shape a
    // degraded cross-language run actually takes, and it must not perturb the
    // same-language ranking it falls back to.
    fc.assert(
      fc.property(corpusArb, phrase, (corpus, query) => {
        const alone = shape(rank([query], corpus, 5));
        expect(shape(rank([query, "   "], corpus, 5))).toEqual(alone);
        expect(shape(rank(["", query], corpus, 5))).toEqual(alone);
        expect(shape(rank(["\n", query, ""], corpus, 5))).toEqual(alone);
        return true;
      }),
      { numRuns: 200, seed: 20_260_821 },
    );
  });
});
