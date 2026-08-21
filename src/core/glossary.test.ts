/**
 * The shared glossary loader and the two checks built on it.
 *
 * The Contents API is a stub of exactly the shape `readContentsFile` asks for,
 * because what is being tested is the reading of a file's *text*, not the
 * decoding of GitHub's envelope — `forge.test.ts` owns that. What matters here
 * is the four answers a repository can give this module: no file, a file that is
 * not YAML, a file that is a map, and a file that is YAML but not a map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";

import type { ContentsApi } from "./forge.js";
import { loadGlossary, termsPreserved, translatedTerm } from "./glossary.js";

vi.mock("@actions/core", () => ({ warning: vi.fn() }));

const mockedWarning = vi.mocked(core.warning);

const at = { owner: "ecoma-io", repo: "reeve" };

/** The Contents API answering with one file's text, and 404 for everything else. */
function serving(files: Record<string, string>): ContentsApi {
  return {
    rest: {
      repos: {
        getContent: ({ path }: { path: string }) => {
          const text = files[path];
          if (text === undefined)
            return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
          return Promise.resolve({
            data: {
              sha: `sha-${path}`,
              content: Buffer.from(text, "utf8").toString("base64"),
              encoding: "base64",
            },
          });
        },
        createOrUpdateFileContents: () => Promise.reject(new Error("no case here writes")),
      },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("loadGlossary", () => {
  it("reads a map of term to note", async () => {
    const api = serving({
      ".reeve/glossary.yml": ["Reeve: The product name.", "warrant: The authority file."].join(
        "\n",
      ),
    });

    const entries = await loadGlossary(api, at, ".reeve/glossary.yml", "translate");

    expect(entries).toEqual([
      { term: "Reeve", note: "The product name." },
      { term: "warrant", note: "The authority file." },
    ]);
  });

  it("keeps a term whose value is not a string, without a note", async () => {
    // The term is the load-bearing half. A note somebody wrote as a list, a
    // number or nothing at all is a note this run does not show the model —
    // never a term it stops protecting.
    const api = serving({
      ".reeve/glossary.yml": ["Reeve:", "sweep: 42", "duty: [a, b]"].join("\n"),
    });

    const entries = await loadGlossary(api, at, ".reeve/glossary.yml", "translate");

    expect(entries).toEqual([{ term: "Reeve" }, { term: "sweep" }, { term: "duty" }]);
  });

  it("is empty, and silent, when there is no file at the path", async () => {
    // The common case: most repositories have no protected terms, and a duty
    // that warned about it every run would be asking for a file it says is
    // optional.
    const entries = await loadGlossary(serving({}), at, ".reeve/glossary.yml", "translate");

    expect(entries).toEqual([]);
    expect(mockedWarning).not.toHaveBeenCalled();
  });

  it("warns and continues when the file cannot be parsed", async () => {
    // A YAML typo in an optional file costs this run its terminology check, not
    // the translation the run was actually for — but it is said out loud, since
    // a maintainer who wrote the file believes it is in force.
    const api = serving({ ".reeve/glossary.yml": "Reeve: [unclosed\n  - :" });

    const entries = await loadGlossary(api, at, ".reeve/glossary.yml", "harmonise");

    expect(entries).toEqual([]);
    expect(mockedWarning).toHaveBeenCalledWith(
      "harmonise: glossary file `.reeve/glossary.yml` could not be parsed — continuing without glossary.",
    );
  });

  it("names the duty that could not read it, so a log says which run this was", async () => {
    const api = serving({ ".reeve/terms.yml": "a: [unclosed\n  - :" });

    await loadGlossary(api, at, ".reeve/terms.yml", "translate");

    expect(mockedWarning).toHaveBeenCalledWith(
      "translate: glossary file `.reeve/terms.yml` could not be parsed — continuing without glossary.",
    );
  });

  it.each([
    ["a list", "- Reeve\n- warrant"],
    ["a scalar", "just a sentence"],
    ["an empty document", ""],
  ])("is empty, and silent, when the file is %s rather than a map", async (_case, text) => {
    // Parseable YAML that is not a map of terms is a file somebody wrote for
    // something else. There is nothing in it this could half-read, so there is
    // nothing to warn about either.
    const api = serving({ ".reeve/glossary.yml": text });

    const entries = await loadGlossary(api, at, ".reeve/glossary.yml", "translate");

    expect(entries).toEqual([]);
    expect(mockedWarning).not.toHaveBeenCalled();
  });
});

describe("translatedTerm", () => {
  it("names the first term the source used and the draft did not", () => {
    expect(
      translatedTerm("Reeve reads the warrant.", "Reeve đọc tệp thẩm quyền.", ["Reeve", "warrant"]),
    ).toBe("warrant");
  });

  it("says nothing about a term the source never used", () => {
    // A glossary is a list for the whole repository, and most of its terms
    // appear in neither half of any one comparison.
    expect(translatedTerm("Có lỗi.", "An error.", ["Reeve"])).toBeNull();
  });

  it("matches case-sensitively, because a term is a spelling", () => {
    expect(translatedTerm("Reeve reads it.", "reeve reads it.", ["Reeve"])).toBe("Reeve");
  });

  it("says nothing when there are no terms at all", () => {
    expect(translatedTerm("Reeve", "Quan trị", [])).toBeNull();
  });
});

describe("termsPreserved", () => {
  it("counts only the terms the source used", () => {
    const measured = termsPreserved("Reeve reads the warrant.", "Reeve đọc warrant.", [
      "Reeve",
      "warrant",
      "sweep",
    ]);

    expect(measured).toEqual({ relevant: 2, preserved: 2, value: 1 });
  });

  it("scores the fraction carried through", () => {
    const measured = termsPreserved("Reeve reads the warrant.", "Reeve đọc tệp thẩm quyền.", [
      "Reeve",
      "warrant",
    ]);

    expect(measured).toEqual({ relevant: 2, preserved: 1, value: 0.5 });
  });

  it("scores a text with no relevant term at all as perfect", () => {
    // Nothing was there to lose, and a draft cannot be ranked below another one
    // for text neither of them had.
    expect(termsPreserved("Có lỗi.", "An error.", ["Reeve"])).toEqual({
      relevant: 0,
      preserved: 0,
      value: 1,
    });
  });
});
