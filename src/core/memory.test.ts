import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createMemory,
  formatCorrection,
  lexical,
  parseCorrection,
  readStore,
  tokenise,
  type Correction,
} from "./memory.js";

// The filesystem is real rather than mocked. `readStore` is a thin thing whose
// whole behaviour is what it does with directories that are missing, files that
// are not NDJSON and lines that are not records — and a mocked `fs` would be
// this test asserting its own stub.

function correction(over: Partial<Correction> = {}): Correction {
  return {
    thread: 1,
    at: "2026-08-01T00:00:00Z",
    title: "Export produces an empty file",
    excerpt: "The export writes zero bytes when the table has exactly one row.",
    language: "en",
    proposed: ["bug"],
    decided: ["bug", "needs reproduction"],
    by: "maintainer",
    note: null,
    ...over,
  };
}

describe("tokenise", () => {
  it("emits a cased word as itself and nothing else", () => {
    // Bigramming it too was tried: every English sentence shares `es`, `in` and
    // `re` with every other, so everything matches everything a little and
    // "shares nothing with this" stops being reachable.
    expect(tokenise("dark")).toEqual(["dark"]);
  });

  it("lowercases, so a title and a body match each other", () => {
    expect(tokenise("Dark")).toEqual(["dark"]);
  });

  it("drops punctuation and keeps digits", () => {
    expect(tokenise("v2.1, done!")).toEqual(["v2", "1", "done"]);
  });

  it("finds terms in a script that puts no spaces between words", () => {
    // The whole reason bigrams are emitted at all: here the word run is the
    // sentence, so matching on runs alone would match on nothing.
    expect(tokenise("导出为空")).toEqual(["导出为空", "导出", "出为", "为空"]);
  });

  it("keeps a Vietnamese syllable whole, because Latin is cased and spaced", () => {
    expect(tokenise("xuất khẩu rỗng")).toEqual(["xuất", "khẩu", "rỗng"]);
  });

  it("emits nothing for text with no letters or digits in it", () => {
    expect(tokenise("--- !!! ---")).toEqual([]);
  });

  it("does not bigram a run of digits, which carries no word to find inside it", () => {
    expect(tokenise("20260811")).toEqual(["20260811"]);
  });

  it("bigrams by code point, not by code unit", () => {
    // Halves of a surrogate pair are not text and match nothing.
    expect(tokenise("𩸽料理")).toEqual(["𩸽料理", "𩸽料", "料理"]);
  });

  it("leaves a long run unbigrammed, so a pasted blob does not fill the index", () => {
    const blob = "字".repeat(60);
    expect(tokenise(blob)).toEqual([blob]);
  });
});

describe("lexical", () => {
  const documents = [
    "Export produces an empty file when the table has one row",
    "The retry counter resets on a timeout but not on a 500",
    "Dark mode would be nice to have in the settings panel",
  ];

  it("ranks the document sharing the most with the query highest", () => {
    const scores = lexical("the export file is empty", documents);
    const best = scores.indexOf(Math.max(...scores));

    expect(best).toBe(0);
  });

  it("scores a document sharing nothing at zero", () => {
    expect(lexical("kubernetes", ["dark mode in the settings"])).toEqual([0]);
  });

  it("answers zero for every document when the query has no terms", () => {
    expect(lexical("!!!", documents)).toEqual([0, 0, 0]);
  });

  it("answers nothing for an empty corpus", () => {
    expect(lexical("export", [])).toEqual([]);
  });

  it("keeps a term every document carries at a positive weight", () => {
    // A negative weight would make a shared word evidence of dissimilarity,
    // which on a store of a few hundred project-specific records is common.
    expect(lexical("export", ["export a", "export b"]).every((score) => score > 0)).toBe(true);
  });

  it("does not divide by zero on a corpus of empty documents", () => {
    expect(lexical("export", ["", ""])).toEqual([0, 0]);
  });

  it("ranks across a script with no spaces in it", () => {
    const scores = lexical("导出的文件是空的", ["导出为空的问题", "深色模式"]);

    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
  });
});

describe("createMemory", () => {
  const store = [
    correction({ thread: 1, title: "Export produces an empty file" }),
    correction({ thread: 2, title: "Dark mode for the settings panel", excerpt: "" }),
  ];

  it("reports the size of the store", () => {
    expect(createMemory(store).size).toBe(2);
  });

  it("recalls the closest correction first", () => {
    expect(createMemory(store).recall("the export is empty", 2)[0]?.thread).toBe(1);
  });

  it("recalls at most what was asked for", () => {
    expect(createMemory(store).recall("export dark", 1)).toHaveLength(1);
  });

  it("recalls nothing from an empty store", () => {
    // The cold start. Every duty works with no memory.
    expect(createMemory([]).recall("anything", 3)).toEqual([]);
  });

  it("recalls nothing when the thread shares nothing with the store", () => {
    // An unrelated example in a prompt is worse than no example, because a
    // model will find a way to use it.
    expect(createMemory(store).recall("kubernetes ingress certificates", 3)).toEqual([]);
  });

  it("recalls nothing when nothing was asked for", () => {
    expect(createMemory(store).recall("export", 0)).toEqual([]);
  });

  it("breaks a tie by recency, because a taxonomy moves", () => {
    const older = correction({ thread: 10, at: "2026-01-01T00:00:00Z" });
    const newer = correction({ thread: 11, at: "2026-07-01T00:00:00Z" });

    expect(createMemory([older, newer]).recall("export empty file", 1)[0]?.thread).toBe(11);
  });

  it("matches on the title, the excerpt and the note, and not on the labels", () => {
    // The labels are the answer rather than the question. A store where `bug`
    // is matchable ranks every correction mentioning the word above the ones
    // describing the same problem.
    const labelled = correction({ thread: 20, title: "x", excerpt: "", decided: ["performance"] });

    expect(createMemory([labelled]).recall("performance", 3)).toEqual([]);
  });

  it("matches on a maintainer's note", () => {
    const noted = correction({
      thread: 21,
      title: "x",
      excerpt: "",
      note: "a slow query at a documented size is performance, not a defect",
    });

    expect(createMemory([noted]).recall("the query is slow", 3)).toHaveLength(1);
  });

  it("takes the ranking as a parameter, which is the seam the language layer needs", () => {
    // What ships today ranks Vietnamese against Vietnamese, because shared
    // words are what it counts. Reeve's thesis is that those should be one
    // memory, and reaching that is a different ranking rather than a different
    // store.
    const reversed = createMemory(store, (_query, documents) =>
      documents.map((_document, index) => index + 1),
    );

    expect(reversed.recall("anything at all", 1)[0]?.thread).toBe(2);
  });
});

describe("parseCorrection", () => {
  it("round-trips what `formatCorrection` writes", () => {
    const original = correction({ note: "the steps were there" });

    expect(parseCorrection(formatCorrection(original))).toEqual(original);
  });

  it("cuts the excerpt at 500 characters, so the store is not a copy of the tracker", () => {
    const long = correction({ excerpt: "x".repeat(900) });

    expect(parseCorrection(formatCorrection(long))?.excerpt).toHaveLength(500);
  });

  it("fills in what a hand-written record left out", () => {
    const parsed = parseCorrection('{"thread":7,"decided":["bug"]}');

    expect(parsed).toEqual({
      thread: 7,
      at: "",
      title: "",
      excerpt: "",
      language: null,
      proposed: [],
      decided: ["bug"],
      by: "",
      note: null,
    });
  });

  it.each([
    ["not json at all"],
    ["[1, 2, 3]"],
    ["null"],
    ['{"decided":["bug"]}'],
    ['{"thread":"7","decided":["bug"]}'],
    ['{"thread":7.5,"decided":["bug"]}'],
    ['{"thread":7}'],
    ['{"thread":7,"decided":"bug"}'],
    ['{"thread":7,"decided":[1]}'],
  ])("refuses `%s` rather than half-reading it", (line) => {
    // A half-parsed correction is a maintainer's decision with the decision
    // missing, and a prompt teaches the model whatever the corruption said.
    expect(parseCorrection(line)).toBeNull();
  });

  it("treats an empty note as no note", () => {
    expect(parseCorrection('{"thread":7,"decided":["bug"],"note":"  "}')?.note).toBeNull();
  });
});

describe("readStore", () => {
  async function store(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "reeve-memory-"));
    const path = join(root, "corrections");
    await mkdir(path);
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(path, name), contents);
    }
    return path;
  }

  it("reads every shard, in filename order", async () => {
    const path = await store({
      "2026-02.ndjson": `${formatCorrection(correction({ thread: 2 }))}\n`,
      "2026-01.ndjson": `${formatCorrection(correction({ thread: 1 }))}\n`,
    });

    const { corrections } = await readStore(path);

    // Sharding by month is what keeps this mergeable: a store that grew as one
    // file would eventually make every correction a conflict.
    expect(corrections.map((entry) => entry.thread)).toEqual([1, 2]);
  });

  it("reads a directory that is not there as the cold start", async () => {
    // The same answer as a store with nothing in it, on purpose.
    expect(await readStore("/nowhere/at/all")).toEqual({ corrections: [], unreadable: [] });
  });

  it("ignores a file that is not a shard", async () => {
    const path = await store({
      "README.md": "This directory holds corrections.\n",
      "2026-01.ndjson": `${formatCorrection(correction())}\n`,
    });

    expect((await readStore(path)).corrections).toHaveLength(1);
  });

  it("ignores blank lines, which is what an editor leaves behind", async () => {
    const path = await store({
      "2026-01.ndjson": `\n${formatCorrection(correction())}\n\n`,
    });

    expect((await readStore(path)).corrections).toHaveLength(1);
  });

  it("skips a line that is not a correction and says where it was", async () => {
    // This is a committed file that maintainers open. Losing one example is not
    // worth losing the verdict.
    const path = await store({
      "2026-01.ndjson": `{"broken":true}\n${formatCorrection(correction())}\n`,
    });

    const { corrections, unreadable } = await readStore(path);

    expect(corrections).toHaveLength(1);
    expect(unreadable[0]).toMatch(/2026-01\.ndjson:1 is not a correction/);
  });
});
