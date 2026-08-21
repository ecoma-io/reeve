/**
 * DETERMIN — the memory a duty reasons from is a function of the store, not of
 * the machine that read it.
 *
 * Recall is the one stage whose output is pasted verbatim into a prompt as
 * worked examples of what this project's maintainers decided. Two runs over an
 * unchanged store that recalled different examples would produce different
 * verdicts on the same thread and there would be nothing in the summary to say
 * why — the store is committed, so a maintainer looking for the cause would
 * find a file that had not moved.
 *
 * Three environmental knobs can reach that answer, and each is pinned here:
 *
 *  - **the filesystem's listing order.** `readStore` reads every `.ndjson`
 *    shard under one directory. `readdir` is not sorted by the kernel — ext4
 *    returns hash order, and a repository checked out on a different runner can
 *    hand the same shards back in a different sequence. The store's order is
 *    what breaks a tie in `topOf`, so this is not cosmetic.
 *  - **the order the corrections happen to sit in.** A caller assembling a
 *    store from more than one source, or a future shard scheme, must not change
 *    which corrections are recalled.
 *  - **the order the queries are asked in.** `recallAcrossQueries` is the
 *    cross-language seam: one query in the thread's own language, one against
 *    the pivot rendering. Which of the two is listed first is a caller's
 *    detail, and it must not decide what reaches the prompt.
 *
 * A fourth is pinned by exclusion: `tokenise` folds case with `toLowerCase`,
 * not `toLocaleLowerCase`, so a Turkish runner still matches `ID` with `id`.
 *
 * `fast-check` carries a fixed seed throughout; nothing is read from a clock or
 * a real filesystem.
 */
import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listing: { names: string[] } = { names: [] };
  const contents = new Map<string, string>();
  return { listing, contents };
});

vi.mock("node:fs/promises", () => ({
  readdir: () => Promise.resolve([...mocks.listing.names]),
  readFile: (path: string) => Promise.resolve(mocks.contents.get(path) ?? ""),
}));

import {
  createMemory,
  formatCorrection,
  readStore,
  tokenise,
  type Correction,
  type WeightedQuery,
} from "./memory.js";

const STORE = "/repo/.reeve/corrections";

function correction(over: Partial<Correction> = {}): Correction {
  return {
    repo: "acme/widgets",
    thread: 1,
    duty: "triage",
    at: "2026-01-01T00:00:00.000Z",
    title: "the export is empty",
    excerpt: "downloading the report gives a zero byte file",
    language: "en",
    proposed: ["question"],
    decided: ["bug"],
    by: "maintainer",
    note: null,
    outcome: null,
    duplicateOf: null,
    pivot: null,
    ...over,
  };
}

// ── The filesystem's listing order ───────────────────────────────────────

describe("readStore — readdir-order invariance", () => {
  /** Writes the shards, then serves the directory listing in exactly `order`. */
  function shards(files: Record<string, string>, order: readonly string[]): void {
    mocks.contents.clear();
    for (const [name, body] of Object.entries(files)) {
      mocks.contents.set(`${STORE}/${name}`, body);
    }
    mocks.listing.names = [...order];
  }

  const FILES = {
    "2026-01.ndjson": `${formatCorrection(correction({ thread: 1, at: "2026-01-05T00:00:00.000Z" }))}\n`,
    "2026-02.ndjson": `${formatCorrection(correction({ thread: 2, at: "2026-02-05T00:00:00.000Z" }))}\n`,
    "2026-03.ndjson": `${formatCorrection(correction({ thread: 3, at: "2026-03-05T00:00:00.000Z" }))}\n`,
    "README.md": "not a shard\n",
  };

  it("reads the identical store in any listing order the filesystem hands back", async () => {
    shards(FILES, Object.keys(FILES));
    const reference = await readStore(STORE);
    expect(reference.corrections.map((c) => c.thread)).toEqual([1, 2, 3]);

    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(Object.keys(FILES), {
          minLength: Object.keys(FILES).length,
          maxLength: Object.keys(FILES).length,
        }),
        async (listing) => {
          shards(FILES, listing);
          const read = await readStore(STORE);
          // Filename order, not listing order — the sequence a maintainer sees
          // in the directory, which is also the sequence `topOf` falls back on.
          expect(read.corrections.map((c) => c.thread)).toEqual([1, 2, 3]);
          expect(read).toEqual(reference);
        },
      ),
      { numRuns: 40, seed: 20_260_821 },
    );
  });

  it("reports the same unreadable lines, in the same order, whatever the listing said", async () => {
    // The warning list is written into the run summary, so it is output too.
    const broken = {
      "2026-01.ndjson": `{"not":"a correction"}\n${formatCorrection(correction({ thread: 1 }))}\n`,
      "2026-02.ndjson": `nonsense\n`,
    };
    shards(broken, ["2026-01.ndjson", "2026-02.ndjson"]);
    const forward = await readStore(STORE);
    shards(broken, ["2026-02.ndjson", "2026-01.ndjson"]);
    const backward = await readStore(STORE);

    expect(forward.unreadable).toEqual([
      `${STORE}/2026-01.ndjson:1 is not a correction`,
      `${STORE}/2026-02.ndjson:1 is not a correction`,
    ]);
    expect(backward).toEqual(forward);
  });
});

// ── The order the corrections sit in ─────────────────────────────────────

/**
 * A store of corrections that share vocabulary, so BM25 has real ties and near
 * ties to break rather than one obvious winner. `at` is distinct per entry,
 * which is what makes `topOf`'s tie-break a total order — see the test below
 * that pins what happens when it is not.
 */
const CORPUS: readonly Correction[] = [
  correction({
    thread: 11,
    at: "2026-01-01T00:00:00.000Z",
    title: "export is empty",
    excerpt: "the csv export downloads a zero byte file",
    decided: ["bug"],
  }),
  correction({
    thread: 12,
    at: "2026-01-02T00:00:00.000Z",
    title: "export is slow",
    excerpt: "the csv export takes four minutes",
    decided: ["performance"],
  }),
  correction({
    thread: 13,
    at: "2026-01-03T00:00:00.000Z",
    title: "export is empty",
    excerpt: "the csv export downloads a zero byte file",
    decided: ["bug", "regression"],
  }),
  correction({
    thread: 14,
    at: "2026-01-04T00:00:00.000Z",
    title: "login redirects twice",
    excerpt: "signing in bounces through the idp and back",
    decided: ["auth"],
  }),
  correction({
    thread: 15,
    at: "2026-01-05T00:00:00.000Z",
    title: "csv columns are in the wrong order",
    excerpt: "the export puts the total before the date",
    decided: ["bug"],
  }),
];

const permutationOfCorpus = fc
  .shuffledSubarray([...CORPUS.keys()], { minLength: CORPUS.length, maxLength: CORPUS.length })
  .map((order) =>
    order.map((index) => CORPUS[index]).filter((entry): entry is Correction => entry !== undefined),
  );

describe("recall — store-order invariance", () => {
  it("recalls the same corrections, in the same order, for any permutation of the store", () => {
    const reference = createMemory(CORPUS).recall("the csv export is empty", 3);
    expect(reference.map((c) => c.thread)).toEqual([13, 11, 12]);

    fc.assert(
      fc.property(permutationOfCorpus, (shuffled) => {
        expect(
          createMemory(shuffled)
            .recall("the csv export is empty", 3)
            .map((c) => c.thread),
        ).toEqual(reference.map((c) => c.thread));
        return true;
      }),
      { numRuns: 200, seed: 20_260_821 },
    );
  });

  it("scores a correction on the corpus, never on where in the corpus it sits", () => {
    // BM25's document frequency and average length are both corpus-wide, so a
    // permutation that changed a single correction's score would mean the
    // ranking was reading position. Asserted over every count a caller can ask
    // for, because the cut is where a scoring wobble would first show up.
    fc.assert(
      fc.property(permutationOfCorpus, fc.integer({ min: 1, max: 8 }), (shuffled, count) => {
        const straight = createMemory(CORPUS).recall("csv export", count);
        const permuted = createMemory(shuffled).recall("csv export", count);
        expect(permuted.map((c) => c.thread)).toEqual(straight.map((c) => c.thread));
        return true;
      }),
      { numRuns: 200, seed: 20_260_821 },
    );
  });

  it("the tie-break is the recency in the record, so two orders of a tie settle the same way", () => {
    // 11 and 13 carry identical searchable text, so they score identically.
    // The tie is broken by `at`, descending — the record's own field, not the
    // store's order — which is what makes the line above reproducible.
    const tied = [CORPUS[0], CORPUS[2]].filter((c): c is Correction => c !== undefined);
    expect(
      createMemory(tied)
        .recall("export empty", 2)
        .map((c) => c.thread),
    ).toEqual([13, 11]);
    expect(
      createMemory([...tied].reverse())
        .recall("export empty", 2)
        .map((c) => c.thread),
    ).toEqual([13, 11]);
  });

  it("two records with the same score and the same instant fall back to store order", () => {
    // ADJUDICATE: `compareAt` answers 0 when two corrections carry the same
    // `at`, and `topOf`'s sort is stable, so the store's own order decides.
    // Reachable: `at` is written by whichever duty recorded the decision, two
    // corrections recorded in the same run share the instant, and a store is a
    // hand-editable committed file. It is not currently a non-determinism,
    // because `readStore` sorts the shards and reads each in line order — the
    // order is fixed, it is just fixed by the file rather than by the record.
    // Pinned as found rather than fixed: adding `thread` as a final tie-break
    // would change which example reaches a prompt, which is a decision about
    // recall, not about a test. Question for adjudication: should `compareAt`
    // fall through to the thread number so the ranking is total on the record
    // alone?
    const same = "2026-05-05T00:00:00.000Z";
    const a = correction({ thread: 21, at: same, title: "export empty", excerpt: "zero bytes" });
    const b = correction({ thread: 22, at: same, title: "export empty", excerpt: "zero bytes" });

    expect(
      createMemory([a, b])
        .recall("export empty", 2)
        .map((c) => c.thread),
    ).toEqual([21, 22]);
    expect(
      createMemory([b, a])
        .recall("export empty", 2)
        .map((c) => c.thread),
    ).toEqual([22, 21]);
  });
});

// ── The order the queries are asked in ───────────────────────────────────

describe("recallAcrossQueries — query-order invariance", () => {
  const PIVOTED: readonly Correction[] = [
    correction({
      thread: 31,
      at: "2026-02-01T00:00:00.000Z",
      language: "vi",
      title: "xuất khẩu trống",
      excerpt: "tệp tải về không có gì",
      pivot: { language: "en", title: "export is empty", excerpt: "the file downloads empty" },
    }),
    correction({
      thread: 32,
      at: "2026-02-02T00:00:00.000Z",
      language: "en",
      title: "export is empty",
      excerpt: "the csv download is a zero byte file",
      pivot: null,
    }),
    correction({
      thread: 33,
      at: "2026-02-03T00:00:00.000Z",
      language: "en",
      title: "csv column order",
      excerpt: "the export puts the total before the date",
      pivot: null,
    }),
  ];

  const QUERIES: readonly WeightedQuery[] = [
    { text: "the csv export is empty", against: "own" },
    { text: "export is empty download", against: { pivot: "en" } },
    { text: "column order", against: { pivot: "en" } },
  ];

  it("merges to the same recall whichever order the queries were listed in", () => {
    const memory = createMemory(PIVOTED);
    const reference = memory.recallAcrossQueries(QUERIES, 3).map((c) => c.thread);
    // Both language halves are actually reached, or the property below is
    // asserting over a merge that never merged anything.
    expect(reference).toContain(31);
    expect(reference).toContain(32);

    fc.assert(
      fc.property(
        fc.shuffledSubarray([...QUERIES], {
          minLength: QUERIES.length,
          maxLength: QUERIES.length,
        }),
        (order) => {
          expect(memory.recallAcrossQueries(order, 3).map((c) => c.thread)).toEqual(reference);
          return true;
        },
      ),
      { numRuns: 100, seed: 20_260_821 },
    );
  });

  it("keeps the best score a query found, so query order cannot promote a weaker match", () => {
    // The merge is a maximum, and a maximum does not care what order it saw its
    // arguments in. Stated over a permutation of both the queries and the
    // store, because the two orders reach the merge through different maps.
    const reference = createMemory(PIVOTED)
      .recallAcrossQueries(QUERIES, 2)
      .map((c) => c.thread);

    fc.assert(
      fc.property(
        fc.shuffledSubarray([...PIVOTED], {
          minLength: PIVOTED.length,
          maxLength: PIVOTED.length,
        }),
        fc.shuffledSubarray([...QUERIES], {
          minLength: QUERIES.length,
          maxLength: QUERIES.length,
        }),
        (store, queries) => {
          expect(
            createMemory(store)
              .recallAcrossQueries(queries, 2)
              .map((c) => c.thread),
          ).toEqual(reference);
          return true;
        },
      ),
      { numRuns: 200, seed: 20_260_821 },
    );
  });
});

// ── The runner's locale ──────────────────────────────────────────────────

describe("tokenise folds case without a locale, so a runner's LANG cannot break matching", () => {
  it("lowercases `I` to `i`, which Turkish collation-aware folding would not", () => {
    // `toLocaleLowerCase("tr")` maps `I` to the dotless `ı`, so a store indexed
    // one way and a query folded the other would never match. `tokenise` calls
    // `toLowerCase`, which is locale-independent by specification — this test
    // is what stops a future edit reaching for the locale-aware spelling.
    expect("ID".toLocaleLowerCase("tr")).toBe("ıd");
    expect(tokenise("ID")).toEqual(["id"]);
    expect(tokenise("ISSUE")).toEqual(["issue"]);
  });

  it("recalls the same correction whether the query shouted or whispered it", () => {
    const memory = createMemory(CORPUS);
    expect(memory.recall("CSV EXPORT IS EMPTY", 2).map((c) => c.thread)).toEqual(
      memory.recall("csv export is empty", 2).map((c) => c.thread),
    );
  });

  it("tokenises the same text the same way for any input, run twice", () => {
    // Cheap, and it is the assumption every index in this module rests on: the
    // store is tokenised once per run and the query per thread, so a tokeniser
    // that read anything outside its argument would produce a corpus and a
    // query that no longer agree.
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 120, unit: "binary" }), (text) => {
        expect(tokenise(text)).toEqual(tokenise(text));
        return true;
      }),
      { numRuns: 200, seed: 20_260_821 },
    );
  });
});
