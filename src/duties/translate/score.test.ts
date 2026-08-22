import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectLanguage } from "../../core/detect.js";
import type { Language } from "../../core/languages.js";
import type * as MarkdownModule from "../../core/markdown.js";
import { segments, type Segment } from "../../core/markdown.js";
import { score, type Draft } from "./score.js";

// Every collaborator is stubbed to say as little as possible: the segmenter
// hands back one prose run and the detector hands back no answer. A case that
// needs one of them to say something says it in the case, which keeps every
// measurement below readable as the arithmetic it is.
//
// `core/script.js` is deliberately NOT stubbed. It used to be, through
// `containsScript`, and that stopped working the moment the leak rule moved
// into the core as `scriptLeak` — a stub on the module's export cannot reach a
// call the module makes to itself. Running the real one is also the better
// test: Unicode's answer about a Han character is not a thing this suite
// should be able to get wrong on purpose. A case that is not about scripts
// stays not about them by configuring only Latin languages, which is what
// `request` below does.
vi.mock("../../core/detect.js", () => ({ detectLanguage: vi.fn() }));
// `importOriginal` rather than a bare factory: a module gains exports over
// time, and a factory that replaces the whole module goes red the moment the
// code under test uses one it does not list.
vi.mock("../../core/markdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MarkdownModule>()),
  segments: vi.fn(),
}));

const mockedDetect = vi.mocked(detectLanguage);
const mockedSegments = vi.mocked(segments);

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const chinese: Language = { code: "zh", label: "中文", scripts: ["Han"] };

beforeEach(() => {
  vi.resetAllMocks();
  mockedSegments.mockImplementation((markdown: string) => [{ kind: "prose", text: markdown }]);
  mockedDetect.mockResolvedValue({ language: null, by: "none", candidates: [] });
});

/** The two `segments` calls a scoring makes, in the order it makes them. */
function splitting(source: Segment[], draft: Segment[]): void {
  mockedSegments.mockReturnValueOnce(source).mockReturnValueOnce(draft);
}

function request(source: string, draft: string, over: Partial<Draft> = {}): Draft {
  return {
    source,
    draft,
    from: vietnamese,
    to: english,
    languages: [vietnamese, english],
    ...over,
  };
}

function valueOf(checks: readonly { name: string; value: number }[], name: string): number {
  const check = checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`no ${name} check was reported`);
  return check.value;
}

describe("score", () => {
  describe("drafts it refuses outright", () => {
    it.each([
      ["an empty draft", "Có lỗi", "", "the draft is empty"],
      ["a draft of nothing but whitespace", "Có lỗi", "  \n\n ", "the draft is empty"],
      [
        "the source handed back unchanged",
        "Có lỗi",
        "Có lỗi",
        "the draft is the source, unchanged",
      ],
      [
        "the source handed back with only whitespace moved",
        "Có lỗi",
        "\n Có lỗi \n",
        "the draft is the source, unchanged",
      ],
    ])("refuses %s", async (_case, source, draft, reason) => {
      const result = await score(request(source, draft));

      expect(result.admissible).toBe(false);
      expect(result.reason).toBe(reason);
    });

    it("scores a refused draft zero and measures nothing", async () => {
      // A refused draft must not be rankable against an admitted one, and a
      // measurement of it would invite exactly that comparison.
      const result = await score(request("Có lỗi", ""));

      expect(result.value).toBe(0);
      expect(result.checks).toEqual([]);
    });

    it("admits a draft that closes a section it never opened — publish disarms it", async () => {
      // This used to be inadmissible, and the danger it named is real: a stray
      // closer ends the `<details>` wrapper `publish.ts` puts each translation
      // inside, spilling every language after it into the visible body.
      //
      // The answer moved rather than softened. Refusing cost the whole language
      // for one loose tag — run 32563990348 lost BOTH configured languages on
      // #131 that way — while `publish.ts` can escape the tag as it assembles
      // the section, which removes the damage instead of pricing it. Nothing is
      // left here to refuse, and nothing to measure either: see
      // `publish.test.ts` for where the rule lives now.
      const result = await score(request("Có lỗi", "An error.\n\n</details>\n"));

      expect(result.admissible).toBe(true);
    });

    it("admits a draft that closes the section it opened itself", async () => {
      // Always was admitted, and still is — the source is allowed a collapsible
      // section and reproducing it is the correct answer. Kept because it is
      // the case a future re-refusal would have to break to come back.
      const source = "<details><summary>Nhật ký</summary>\n\nCó lỗi\n\n</details>";
      const draft = "<details open><summary>Log</summary>\n\nAn error\n\n</details>";

      const result = await score(request(source, draft));

      expect(result.admissible).toBe(true);
    });

    it("ranks a draft that translated a glossary term rather than refusing it", async () => {
      // It used to be inadmissible. With one draft configured — the setup this
      // project dogfoods — that is not "take the other candidate", it is the
      // language missing from the thread: run 32461467950 lost Vietnamese on
      // #123 to a `capability` the draft rendered as ordinary prose. The loss
      // is priced now instead of fatal.
      const result = await score(
        request("Reeve đọc warrant.", "Reeve reads the authority file.", {
          glossary: [{ term: "warrant", note: "The authority file." }],
        }),
      );

      expect(result.admissible).toBe(true);
      expect(valueOf(result.checks, "glossary")).toBe(0);
    });

    it("measures nothing for a glossary term this chunk's source never used", async () => {
      // Each chunk of a body is scored on its own, against its own source. A
      // term that appears in chunk three is nothing chunk one could have lost,
      // and charging a draft for every term in the file would score every
      // draft down the moment the glossary grew.
      const result = await score(
        request("Có lỗi.", "An error.", { glossary: [{ term: "warrant" }] }),
      );

      expect(result.admissible).toBe(true);
      expect(result.checks.some((check) => check.name === "glossary")).toBe(false);
    });

    it("matches a glossary term case-sensitively, because a term is a spelling", async () => {
      const result = await score(
        request("Reeve đọc tệp.", "reeve reads the file.", { glossary: [{ term: "Reeve" }] }),
      );

      expect(result.admissible).toBe(true);
      expect(valueOf(result.checks, "glossary")).toBe(0);
    });

    it("ranks down a draft carrying a script neither the target nor the source has", async () => {
      // The failure a cheap model produces most visibly: a phrase of the wrong
      // language left sitting in an otherwise plausible translation. Every
      // other measurement scores it well, and the detector clears it, because
      // the draft really is mostly the language it was asked for.
      //
      // Two characters of it. That used to refuse the draft, and on #130 it
      // refused the only draft there was, so the pull request was published
      // with Chinese and no Vietnamese at all.
      const result = await score(
        request("Có lỗi", "An error 等到 while loading.", {
          languages: [vietnamese, english, chinese],
        }),
      );

      expect(result.admissible).toBe(true);
      expect(valueOf(result.checks, "script")).toBeGreaterThan(0.5);
      expect(valueOf(result.checks, "script")).toBeLessThan(1);
    });

    it("scores a draft wholly in a script nobody asked for at zero", async () => {
      // The far end of the slide the refusal used to be a cliff at. A draft
      // that answered the whole request in the wrong language loses to
      // anything else the run produced — without being able to take the
      // language down with it when it is the only draft there is.
      const result = await score(
        request("An error while loading the page.", "加载页面时出错了，请稍后重试。", {
          from: english,
          to: vietnamese,
          languages: [vietnamese, english, chinese],
        }),
      );

      expect(result.admissible).toBe(true);
      expect(valueOf(result.checks, "script")).toBe(0);
    });

    it("reports no leak for a script the source already used", async () => {
      // A thread quoting a Chinese error message wants that message carried
      // across intact, and scoring the draft down for reproducing it would
      // charge it for the correct answer.
      const result = await score(
        request("Có lỗi 等到", "An error 等到 while loading.", {
          languages: [vietnamese, english, chinese],
        }),
      );

      expect(result.admissible).toBe(true);
      expect(result.checks.some((check) => check.name === "script")).toBe(false);
    });

    it("exempts the target's own scripts however the workflow spelled them", async () => {
      // Not by comparing script names: a workflow that wrote `Latn` for one
      // language and `Latin` for another would otherwise be told its English
      // draft had leaked into Vietnamese.
      const latn: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] };
      const result = await score(request("Có lỗi", "An error.", { languages: [latn, english] }));

      expect(result.checks.some((check) => check.name === "script")).toBe(false);
    });

    it("looks for no script the workflow did not configure", async () => {
      // There is no table of scripts in this action and there must not become
      // one — the configured languages are the whole population it can name.
      // Han is right there in the draft, and nothing asked about Han.
      const result = await score(
        request("Có lỗi", "An error 等到 while loading.", { languages: [vietnamese, english] }),
      );

      expect(result.checks.some((check) => check.name === "script")).toBe(false);
    });

    it("refuses a draft the detector still finds in the source language", async () => {
      mockedDetect.mockResolvedValue({
        language: vietnamese,
        by: "profile",
        candidates: [vietnamese, english],
      });

      const result = await score(request("Có lỗi khi tải trang", "Có lỗi khi tải lại trang"));

      expect(result.admissible).toBe(false);
      expect(result.reason).toBe("the draft is still in Tiếng Việt");
    });

    it("asks the detector only about the two languages in play", async () => {
      await score(request("Có lỗi", "An error"));

      expect(mockedDetect).toHaveBeenCalledWith("An error", [vietnamese, english]);
    });

    it("gives the detector no way to reach a model", async () => {
      // A third argument here would put a request behind every draft of every
      // run, which is the cost this module exists to avoid.
      await score(request("Có lỗi", "An error"));

      expect(mockedDetect.mock.calls[0]).toHaveLength(2);
    });

    it("admits a draft the detector could not place", async () => {
      const result = await score(request("Có lỗi", "An error"));

      expect(result.admissible).toBe(true);
      expect(result.reason).toBeNull();
    });

    it("admits a draft the detector places in the target language", async () => {
      mockedDetect.mockResolvedValue({
        language: english,
        by: "profile",
        candidates: [vietnamese, english],
      });

      const result = await score(request("Có lỗi", "An error"));

      expect(result.admissible).toBe(true);
    });

    it("does not detect at all when the source language is unknown", async () => {
      const result = await score(request("Có lỗi", "An error", { from: null }));

      expect(mockedDetect).not.toHaveBeenCalled();
      expect(result.admissible).toBe(true);
    });

    it("does not detect at all when the source and target are the same language", async () => {
      // Nothing to prove: a draft in the target language is also a draft in the
      // source language, and refusing it would refuse every draft.
      await score(request("An error", "A failure", { from: { ...english, code: "EN" } }));

      expect(mockedDetect).not.toHaveBeenCalled();
    });
  });

  describe("glossary terms carried through", () => {
    it("reports every term this chunk's source used and the draft kept", async () => {
      const result = await score(
        request("Reeve đọc warrant.", "Reeve reads the warrant.", {
          glossary: [{ term: "Reeve" }, { term: "warrant" }],
        }),
      );

      expect(valueOf(result.checks, "glossary")).toBe(1);
      expect(result.checks.find((check) => check.name === "glossary")?.note).toBe(
        "2 of 2 glossary terms carried through unchanged",
      );
    });

    it("counts only the terms this chunk's source used", async () => {
      // The glossary is a list for the whole repository. Most of it has nothing
      // to say about any one chunk, and the note has to say so honestly rather
      // than reporting a denominator nobody wrote.
      const result = await score(
        request("Reeve đọc tệp.", "Reeve reads the file.", {
          glossary: [{ term: "Reeve" }, { term: "warrant" }, { term: "sweep" }],
        }),
      );

      expect(result.checks.find((check) => check.name === "glossary")?.note).toBe(
        "1 of 1 glossary terms carried through unchanged",
      );
    });

    it("measures the raw text, so a term inside a code span still counts", async () => {
      // Half of what a glossary protects is the name of something, and names
      // live in code spans. The segmenter would hand those back separately, so
      // a check reading the prose alone would be blind to exactly the terms
      // most likely to be on the list.
      splitting([{ kind: "code", text: "`dry-run`" }], [{ kind: "code", text: "`dry-run`" }]);

      const result = await score(
        request("Bật `dry-run`.", "Turn on `dry-run`.", { glossary: [{ term: "dry-run" }] }),
      );

      expect(valueOf(result.checks, "glossary")).toBe(1);
    });

    it("measures nothing at all when the chunk used no term", async () => {
      // A perfect score worth 3 added to every draft in every repository
      // without a glossary — which is most of them — would move every number
      // this duty reports while measuring nothing.
      const result = await score(
        request("Có lỗi.", "An error.", { glossary: [{ term: "Reeve" }] }),
      );

      expect(result.checks.map((check) => check.name)).not.toContain("glossary");
    });

    it("measures nothing when there is no glossary", async () => {
      const result = await score(request("Có lỗi.", "An error."));

      expect(result.checks.map((check) => check.name)).toEqual([
        "code",
        "links",
        "structure",
        "length",
      ]);
    });

    it("weighs the glossary as heavily as links", async () => {
      // A term the project decided on is a literal string a reader maps back to
      // an input name or a reference page, exactly as a link destination is.
      const result = await score(
        request("Reeve đọc tệp.", "Reeve reads the file.", { glossary: [{ term: "Reeve" }] }),
      );

      const weightOf = (name: string): number | undefined =>
        result.checks.find((check) => check.name === name)?.weight;
      expect(weightOf("glossary")).toBe(weightOf("links"));
    });
  });

  describe("code carried across", () => {
    it("scores a draft that copied every block and span unchanged", async () => {
      splitting(
        [
          { kind: "prose", text: "Chạy " },
          { kind: "code", text: "`pnpm build`" },
          { kind: "fence", text: "```\nerror\n```" },
        ],
        [
          { kind: "prose", text: "Run " },
          { kind: "code", text: "`pnpm build`" },
          { kind: "fence", text: "```\nerror\n```" },
        ],
      );

      const result = await score(request("nguồn", "translated"));

      expect(valueOf(result.checks, "code")).toBe(1);
    });

    it("scores down a draft that translated the contents of a block", async () => {
      splitting(
        [
          { kind: "prose", text: "a" },
          { kind: "fence", text: "```\n// tải lại\n```" },
        ],
        [
          { kind: "prose", text: "b" },
          { kind: "fence", text: "```\n// reload\n```" },
        ],
      );

      const result = await score(request("nguồn", "translated"));

      expect(valueOf(result.checks, "code")).toBe(0);
    });

    it("scores down a draft that dropped one block of two", async () => {
      splitting(
        [
          { kind: "code", text: "`a`" },
          { kind: "code", text: "`b`" },
        ],
        [{ kind: "code", text: "`a`" }],
      );

      const result = await score(request("nguồn", "translated"));

      // One of the two blocks the pair of bodies has between them is agreed on.
      expect(valueOf(result.checks, "code")).toBeCloseTo(1 / 2);
    });

    it("scores down a draft that invented a block the source never had", async () => {
      // Measured against both bodies rather than only the source, so a draft
      // that added code cannot score as well as one that reproduced it.
      splitting(
        [{ kind: "code", text: "`a`" }],
        [
          { kind: "code", text: "`a`" },
          { kind: "code", text: "`b`" },
        ],
      );

      const result = await score(request("nguồn", "translated"));

      expect(valueOf(result.checks, "code")).toBeCloseTo(1 / 2);
    });

    it("scores a pair of bodies with no code at all as agreeing", async () => {
      const result = await score(request("Có lỗi", "An error"));

      expect(valueOf(result.checks, "code")).toBe(1);
    });

    it("counts the blocks it agreed on in the note", async () => {
      splitting(
        [
          { kind: "code", text: "`a`" },
          { kind: "code", text: "`b`" },
        ],
        [{ kind: "code", text: "`a`" }],
      );

      const result = await score(request("nguồn", "translated"));

      expect(result.checks.find((check) => check.name === "code")?.note).toBe(
        "1 of 2 code blocks and spans carried across unchanged",
      );
    });
  });

  describe("links left alone", () => {
    it("scores a draft that kept every destination", async () => {
      const result = await score(
        request(
          "Xem [tài liệu](https://e.co/docs) và https://e.co/x",
          "See [the docs](https://e.co/docs) and https://e.co/x",
        ),
      );

      expect(valueOf(result.checks, "links")).toBe(1);
    });

    it("scores down a draft that rewrote a destination", async () => {
      const result = await score(
        request("Xem [tài liệu](https://e.co/docs)", "See [the docs](https://e.co/vi/docs)"),
      );

      expect(valueOf(result.checks, "links")).toBe(0);
    });

    it("ignores the words a link is called, which a translation is free to change", async () => {
      const result = await score(
        request("Xem [tài liệu](https://e.co/docs)", "Read [the manual](https://e.co/docs)"),
      );

      expect(valueOf(result.checks, "links")).toBe(1);
    });

    it("does not count a bare url twice when it is also a destination", async () => {
      const result = await score(
        request("[x](https://e.co/a)", "[y](https://e.co/a) https://e.co/b"),
      );

      // One destination each side, one of them shared: two links in total.
      expect(valueOf(result.checks, "links")).toBeCloseTo(1 / 2);
    });
  });

  describe("structure held together", () => {
    it("scores a draft that kept every heading, list item and table row", async () => {
      const source = "# Lỗi\n\n- một\n- hai\n\n| a | b |\n| - | - |";
      const draft = "# Bug\n\n- one\n- two\n\n| a | b |\n| - | - |";

      const result = await score(request(source, draft));

      expect(valueOf(result.checks, "structure")).toBe(1);
    });

    it("scores down a draft that flattened a list into a paragraph", async () => {
      const result = await score(request("- một\n- hai", "one and two"));

      expect(valueOf(result.checks, "structure")).toBe(0);
    });

    it("scores down a draft that lost one heading of two", async () => {
      const result = await score(request("# một\n\n## hai", "# one\n\ntwo"));

      expect(valueOf(result.checks, "structure")).toBeCloseTo(1 / 2);
    });

    it("counts a body with no structure at all as agreeing", async () => {
      const result = await score(request("Có lỗi", "An error"));

      expect(valueOf(result.checks, "structure")).toBe(1);
    });

    it("reads a heading at the start of its own line rather than mid-sentence", async () => {
      // `#42` in prose is a reference, not a heading, and a scorer that counted
      // it would reward a draft for keeping something it never had.
      const result = await score(request("liên quan #42", "related to #42"));

      expect(valueOf(result.checks, "structure")).toBe(1);
    });
  });

  describe("length within reach of the source", () => {
    it.each([
      ["the same length", 1, 1],
      ["half as long, which some pairs are", 0.5, 1],
      ["twice as long, which others are", 2, 1],
      ["a third as long", 1 / 3, (1 / 3 - 0.2) / 0.3],
      ["three times as long", 3, 0.5],
    ])("scores a draft %s", async (_case, ratio, expected) => {
      const source = "a".repeat(300);
      const draft = "b".repeat(Math.round(300 * ratio));

      const result = await score(request(source, draft));

      expect(valueOf(result.checks, "length")).toBeCloseTo(expected);
    });

    it.each([
      ["stopped after the first sentence", 0.05],
      ["answered with an essay about the translation", 6],
    ])("scores a draft that %s at zero", async (_case, ratio) => {
      const source = "a".repeat(300);
      const draft = "b".repeat(Math.round(300 * ratio));

      const result = await score(request(source, draft));

      expect(valueOf(result.checks, "length")).toBe(0);
    });

    it("measures the prose and not the code, which is required to be identical", async () => {
      // Without this a body that is mostly a stack trace scores well however
      // little of its prose survived.
      splitting(
        [
          { kind: "prose", text: "a".repeat(100) },
          { kind: "fence", text: "x".repeat(9000) },
        ],
        [
          { kind: "prose", text: "b".repeat(10) },
          { kind: "fence", text: "x".repeat(9000) },
        ],
      );

      const result = await score(request("nguồn", "translated"));

      expect(valueOf(result.checks, "length")).toBe(0);
    });

    it("scores a source with no prose to measure as agreeing", async () => {
      splitting([{ kind: "fence", text: "```\na\n```" }], [{ kind: "fence", text: "```\na\n```" }]);

      const result = await score(request("nguồn", "translated"));

      expect(valueOf(result.checks, "length")).toBe(1);
    });

    it("scores prose invented against a source that had none at zero", async () => {
      splitting(
        [{ kind: "fence", text: "```\na\n```" }],
        [
          { kind: "prose", text: "Here is what that code does" },
          { kind: "fence", text: "```\na\n```" },
        ],
      );

      const result = await score(request("nguồn", "translated"));

      expect(valueOf(result.checks, "length")).toBe(0);
    });
  });

  describe("the value it ranks by", () => {
    it("is one when every measurement agreed", async () => {
      const result = await score(request("Có lỗi", "An error"));

      expect(result.value).toBe(1);
    });

    it("weighs code above the rest, so the damage a reader cannot repair costs most", async () => {
      splitting(
        [{ kind: "code", text: "`docker run --rm`" }],
        [{ kind: "code", text: "`docker chạy --rm`" }],
      );
      const mangledCode = await score(request("nguồn", "translated"));

      const shortProse = await score(request("a".repeat(300), "b".repeat(30)));

      expect(mangledCode.value).toBeLessThan(shortProse.value);
    });

    it("is the weighted mean of the checks it reported", async () => {
      // Pinned as arithmetic rather than a magic number: the weights are a
      // ranking decision, and a silent change to one would otherwise reorder
      // every run's drafts with no test noticing.
      const weights: Record<string, number> = { code: 4, links: 3, structure: 2, length: 1 };
      const result = await score(request("- một\n- hai", "one and two"));

      // Each check carries its own weight now, so the literals above are
      // asserted rather than assumed — a measurement whose weight moved fails
      // here instead of quietly re-ranking every draft.
      for (const check of result.checks) expect(check.weight).toBe(weights[check.name]);

      const expected =
        result.checks.reduce(
          (total, check) => total + check.value * (weights[check.name] ?? 0),
          0,
        ) / 10;
      expect(result.value).toBeCloseTo(expected);
    });

    it("reports every measurement, whatever it scored", async () => {
      const result = await score(request("Có lỗi", "An error"));

      expect(result.checks.map((check) => check.name)).toEqual([
        "code",
        "links",
        "structure",
        "length",
      ]);
    });

    it("says what it measured even when nothing was wrong", async () => {
      const result = await score(request("Có lỗi", "An error"));

      for (const check of result.checks) expect(check.note.length).toBeGreaterThan(0);
    });
  });
});
