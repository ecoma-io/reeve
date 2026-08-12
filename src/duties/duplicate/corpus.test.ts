import { describe, expect, it } from "vitest";

import type { TrackerApi } from "../../core/forge.js";
import type { Language } from "../../core/languages.js";
import { markerFor } from "../../core/marker.js";
import { authorText, crossLanguageCorpus, listCorpus, type CorpusThread } from "./corpus.js";
import { documentOf } from "./rank.js";

const AT = { owner: "acme", repo: "widgets" };

const en: Language = { code: "en", label: "English", scripts: ["Latin"] };
const zh: Language = { code: "zh", label: "中文", scripts: ["Han"] };

interface Entry {
  readonly number: number;
  readonly title?: string;
  readonly body?: string | null;
  readonly created_at: string;
  readonly pull_request?: unknown;
}

/** A `TrackerApi` whose `listForRepo` serves fixed pages of 100, from an in-memory list. */
function stubOf(entries: readonly Entry[]): TrackerApi {
  return {
    rest: {
      issues: {
        listForRepo: ({ page = 1, per_page = 100 }) => {
          const start = (page - 1) * per_page;
          return Promise.resolve({ data: entries.slice(start, start + per_page) });
        },
        get: () => {
          throw new Error("not used by listCorpus");
        },
        update: () => {
          throw new Error("not used by listCorpus");
        },
        addLabels: () => {
          throw new Error("not used by listCorpus");
        },
        createComment: () => {
          throw new Error("not used by listCorpus");
        },
        addAssignees: () => {
          throw new Error("not used by listCorpus");
        },
        listLabelsForRepo: () => {
          throw new Error("not used by listCorpus");
        },
        listEvents: () => {
          throw new Error("not used by listCorpus");
        },
        removeLabel: () => {
          throw new Error("not used by listCorpus");
        },
        createLabel: () => {
          throw new Error("not used by listCorpus");
        },
      },
      repos: {
        getCollaboratorPermissionLevel: () => {
          throw new Error("not used by listCorpus");
        },
      },
    },
  };
}

function page(count: number, offset = 0): Entry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    number: offset + index + 1,
    title: `Issue ${String(offset + index + 1)}`,
    body: "body",
    created_at: new Date(2026, 0, 1, 0, 0, offset + index).toISOString(),
  }));
}

describe("listCorpus", () => {
  it("lists every open thread when neither bound is set", async () => {
    const api = stubOf(page(3));

    const corpus = await listCorpus(api, AT, 999, null, null);

    expect(corpus.map((entry) => entry.number)).toEqual([1, 2, 3]);
  });

  it("excludes the thread being checked from its own corpus", async () => {
    const api = stubOf(page(3));

    const corpus = await listCorpus(api, AT, 2, null, null);

    expect(corpus.map((entry) => entry.number)).toEqual([1, 3]);
  });

  it("drops pull requests — a duplicate check answers about issues", async () => {
    const entries = page(2);
    const withPr = [...entries, { ...page(1, 2)[0]!, pull_request: {} }];
    const api = stubOf(withPr);

    const corpus = await listCorpus(api, AT, 999, null, null);

    expect(corpus.map((entry) => entry.number)).toEqual([1, 2]);
  });

  it("pages past ten pages when unbounded — the sweep's fixed ceiling does not apply here", async () => {
    // 1200 entries is twelve pages of 100, past `SWEEP_PAGES`'s cap of ten in
    // `core/forge.ts`. A corpus lister that copied that cap would silently
    // drop the last two hundred threads of a configured, unbounded corpus.
    const api = stubOf(page(1200));

    const corpus = await listCorpus(api, AT, 999_999, null, null);

    expect(corpus).toHaveLength(1200);
  });

  it("stops paging once `limit` is satisfied, without reading further pages", async () => {
    let pagesRead = 0;
    const entries = page(250);
    const api: TrackerApi = {
      rest: {
        issues: {
          ...stubOf(entries).rest.issues,
          listForRepo: (params) => {
            pagesRead += 1;
            const perPage = params.per_page ?? 100;
            const start = ((params.page ?? 1) - 1) * perPage;
            return Promise.resolve({ data: entries.slice(start, start + perPage) });
          },
        },
        repos: stubOf(entries).rest.repos,
      },
    };

    const corpus = await listCorpus(api, AT, 999, 120, null);

    expect(corpus).toHaveLength(120);
    // 120 is satisfied on the second page (100 + 20) — a third page would be
    // wasted work `listCorpus` should not do.
    expect(pagesRead).toBe(2);
  });

  it("stops paging once an entry falls before `corpus-since`", async () => {
    const entries = [
      { number: 3, title: "new", body: "", created_at: "2026-06-01T00:00:00Z" },
      { number: 2, title: "mid", body: "", created_at: "2026-01-01T00:00:00Z" },
      { number: 1, title: "old", body: "", created_at: "2025-01-01T00:00:00Z" },
    ];
    const api = stubOf(entries);

    const corpus = await listCorpus(api, AT, 999, null, new Date("2026-01-01T00:00:00Z"));

    expect(corpus.map((entry) => entry.number)).toEqual([3, 2]);
  });

  it("carries the title, body and creation date through for ranking and display", async () => {
    const api = stubOf([
      { number: 1, title: "Login broken", body: "Details.", created_at: "2026-01-01T00:00:00Z" },
    ]);

    const corpus = await listCorpus(api, AT, 999, null, null);

    expect(corpus[0]).toEqual({
      number: 1,
      title: "Login broken",
      body: "Details.",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("reads a missing title or body as empty rather than throwing", async () => {
    const api = stubOf([{ number: 1, created_at: "2026-01-01T00:00:00Z" }]);

    const corpus = await listCorpus(api, AT, 999, null, null);

    expect(corpus[0]).toMatchObject({ title: "", body: "" });
  });

  it("returns an empty corpus for a repository with nothing open", async () => {
    const api = stubOf([]);

    expect(await listCorpus(api, AT, 999, null, null)).toEqual([]);
  });

  it("strips a published block out of a candidate's body before it is indexed", async () => {
    const translate = markerFor("translate");
    const body = [
      "Login fails on Safari.",
      "",
      translate.render("fp1"),
      "",
      "Đăng nhập thất bại trên Safari.",
    ].join("\n\n");
    const api = stubOf([
      { number: 1, title: "Login broken", body, created_at: "2026-01-01T00:00:00Z" },
    ]);

    const corpus = await listCorpus(api, AT, 999, null, null);

    expect(corpus[0]?.body).toBe("Login fails on Safari.");
  });

  it("truncates a candidate's body to `maxBodyChars`, the same bound the thread's own body reads", async () => {
    const long = "x".repeat(200);
    const api = stubOf([
      { number: 1, title: "Long report", body: long, created_at: "2026-01-01T00:00:00Z" },
    ]);

    const corpus = await listCorpus(api, AT, 999, null, null, 50);

    expect(corpus[0]?.body).toBe("x".repeat(50));
  });

  it("truncates after stripping a published block, not before — the budget is spent on what an author wrote", async () => {
    const translate = markerFor("translate");
    const body = `${"x".repeat(200)}\n\n${translate.render("fp1")}\n\nTranslated text.`;
    const api = stubOf([
      { number: 1, title: "Long report", body, created_at: "2026-01-01T00:00:00Z" },
    ]);

    const corpus = await listCorpus(api, AT, 999, null, null, 50);

    expect(corpus[0]?.body).toBe("x".repeat(50));
  });

  it("reads the whole candidate body when `maxBodyChars` is null, the default", async () => {
    const long = "x".repeat(200);
    const api = stubOf([
      { number: 1, title: "Long report", body: long, created_at: "2026-01-01T00:00:00Z" },
    ]);

    const corpus = await listCorpus(api, AT, 999, null, null);

    expect(corpus[0]?.body).toBe(long);
  });

  it("reaches the judge's own document truncated too — `rank.ts`'s `documentOf` reads straight off the corpus entry", async () => {
    const long = "y".repeat(200);
    const api = stubOf([
      { number: 1, title: "Long report", body: long, created_at: "2026-01-01T00:00:00Z" },
    ]);

    const corpus = await listCorpus(api, AT, 999, null, null, 50);

    expect(documentOf(corpus[0]!)).toBe(`Long report\n\n${"y".repeat(50)}`);
  });

  it("lists the whole open corpus with `exclude` null — a sweep's shared listing", async () => {
    const api = stubOf(page(3));

    const corpus = await listCorpus(api, AT, null, null, null);

    expect(corpus.map((entry) => entry.number)).toEqual([1, 2, 3]);
  });
});

describe("authorText", () => {
  it("returns the body unchanged when it carries no marker", () => {
    expect(authorText("Login fails on Safari.")).toBe("Login fails on Safari.");
  });

  it("cuts a body off at any duty's marker, keeping only what came before it", () => {
    const translate = markerFor("translate");
    const body = `Original report.\n\n${translate.render("fp1")}\n\nTranslated text.`;

    expect(authorText(body)).toBe("Original report.");
  });

  it("recognises a different duty's marker just as well", () => {
    const other = markerFor("duplicate");
    const body = `Original report.\n\n${other.render("fp1")}\n\nAppended by another duty.`;

    expect(authorText(body)).toBe("Original report.");
  });

  it("trims trailing whitespace left in front of the marker, the same as `authorHalf`", () => {
    const translate = markerFor("translate");
    const body = `Original report.\n\n\n${translate.render("fp1")}\n\nTranslated text.`;

    expect(authorText(body)).toBe("Original report.");
  });
});

function candidate(number: number, body: string): CorpusThread {
  return { number, title: "", body, createdAt: new Date("2026-01-01T00:00:00Z") };
}

describe("crossLanguageCorpus", () => {
  it("finds a candidate written in the pivot language specifically", async () => {
    const corpus = [candidate(1, "English report."), candidate(2, "中文报告。")];

    expect(await crossLanguageCorpus([en, zh], zh, corpus, new Map())).toBe(true);
  });

  it("is false when nothing in the corpus is in the pivot language, even in a third language", async () => {
    const corpus = [candidate(1, "English report.")];

    expect(await crossLanguageCorpus([en, zh], zh, corpus, new Map())).toBe(false);
  });

  it("is false for an empty corpus", async () => {
    expect(await crossLanguageCorpus([en, zh], zh, [], new Map())).toBe(false);
  });

  it("skips a candidate script narrowing cannot place, rather than counting it as a match", async () => {
    // No configured script occurs at all — a stack trace, not prose in any
    // language `detectLanguage` was given to try.
    const corpus = [candidate(1, "12345 67890 !@#$%")];

    expect(await crossLanguageCorpus([en, zh], zh, corpus, new Map())).toBe(false);
  });

  it("memoises a candidate's detected language across calls sharing the same cache", async () => {
    const cache = new Map<number, Language | null>();
    const corpus = [candidate(1, "中文报告。")];

    await crossLanguageCorpus([en, zh], zh, corpus, cache);

    expect(cache.get(1)).toEqual(zh);

    // A second call against the same cache does not need to re-detect —
    // pinned by checking the cached answer still drives the result even for
    // a pivot language the (now irrelevant) body text does not itself carry.
    const result = await crossLanguageCorpus([en, zh], zh, corpus, cache);
    expect(result).toBe(true);
  });
});
