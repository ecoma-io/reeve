/**
 * The two glossary checks read as one rule.
 *
 * `translatedTerm` refuses a draft and `termsPreserved` ranks one, and the
 * module says outright that the second is "the measured statement of the rule
 * the first refuses on". Nothing held them to that. They are consulted at
 * different points — one gates, one scores — so a drift between them is not a
 * failing test anywhere: it is a draft refused while scoring perfectly, or a
 * draft ranked below its rival for a term no refusal would ever name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentsApi } from "./forge.js";
import { loadGlossary, termsPreserved, translatedTerm } from "./glossary.js";

vi.mock("@actions/core", () => ({ warning: vi.fn() }));

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
  it("drops an entry that names no term, keeping the ones around it", async () => {
    // A key with nothing in it is a half-finished edit. Carried through, it is
    // a term every text contains and every draft preserves — which is not a
    // harmless no-op: it is a free point in `termsPreserved`, added to every
    // draft, diluting the one measurement that notices a real term was lost.
    const api = serving({
      ".reeve/glossary.yml": ['"": A note nobody attached to a word.', "Reeve: The product."].join(
        "\n",
      ),
    });

    const entries = await loadGlossary(api, at, ".reeve/glossary.yml", "translate");

    expect(entries).toEqual([{ term: "Reeve", note: "The product." }]);
  });
});

describe("the refusal and the score state the same rule", () => {
  const terms = ["Reeve", "warrant", "sweep"];

  it.each([
    ["every relevant term carried through", "Reeve reads the warrant.", "Reeve đọc warrant."],
    ["one of them translated away", "Reeve reads the warrant.", "Reeve đọc tệp thẩm quyền."],
    ["all of them translated away", "Reeve reads the warrant.", "Quan trị đọc tệp thẩm quyền."],
    ["no term the source ever used", "Có lỗi.", "An error."],
    ["a term the draft added but the source never had", "Có lỗi.", "Reeve failed."],
  ])("agree on %s", (_case, source, draft) => {
    const named = translatedTerm(source, draft, terms);
    const measured = termsPreserved(source, draft, terms);

    // A term is named exactly when something was lost, and nothing is named
    // exactly when the score is perfect. Either half alone can be satisfied by
    // a check that stopped looking at the source, or at the draft.
    expect(named === null).toBe(measured.value === 1);
  });

  it("names a term that the score also counts as lost", () => {
    const named = translatedTerm("Reeve reads the warrant.", "Reeve đọc tệp thẩm quyền.", terms);
    const measured = termsPreserved("Reeve reads the warrant.", "Reeve đọc tệp thẩm quyền.", terms);

    expect(named).toBe("warrant");
    expect(measured).toEqual({ relevant: 2, preserved: 1, value: 0.5 });
  });

  it("counts a term the source used twice once, so repetition cannot buy a better score", () => {
    // The measurement is over the glossary's terms, not over their occurrences
    // — a draft that dropped `warrant` must not be scored back up because the
    // source happened to say `Reeve` three times.
    const measured = termsPreserved(
      "Reeve, Reeve, Reeve reads the warrant.",
      "Reeve, Reeve, Reeve đọc tệp thẩm quyền.",
      terms,
    );

    expect(measured).toEqual({ relevant: 2, preserved: 1, value: 0.5 });
  });
});
