import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectLanguage } from "../../core/detect.js";
import type { Language } from "../../core/languages.js";
import { segments, type Segment } from "../../core/markdown.js";
import { score, type Draft } from "./score.js";
import { containsScript } from "../../core/script.js";

// Every collaborator is stubbed to say as little as possible: the segmenter
// hands back one prose run, the detector hands back no answer, and no text
// carries any script. A case that needs one of them to say something says it in
// the case, which keeps every measurement below readable as the arithmetic it
// is.
vi.mock("../../core/detect.js", () => ({ detectLanguage: vi.fn() }));
vi.mock("../../core/markdown.js", () => ({ segments: vi.fn() }));
vi.mock("../../core/script.js", () => ({ containsScript: vi.fn() }));

const mockedDetect = vi.mocked(detectLanguage);
const mockedSegments = vi.mocked(segments);
const mockedContainsScript = vi.mocked(containsScript);

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const chinese: Language = { code: "zh", label: "中文", scripts: ["Han"] };

beforeEach(() => {
  vi.resetAllMocks();
  mockedSegments.mockImplementation((markdown: string) => [{ kind: "prose", text: markdown }]);
  mockedDetect.mockResolvedValue({ language: null, by: "none", candidates: [] });
  // No script is anywhere, so a case that is not about scripts is not quietly
  // about them. Unicode's own answer is `script.test.ts`'s subject.
  mockedContainsScript.mockReturnValue(false);
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

    it("refuses a draft that closes a section it never opened", async () => {
      // This action posts every translation inside a `<details>` block of its
      // own, so a stray closer does not unbalance the draft — it ends the
      // wrapper and spills whatever follows into the visible comment.
      const result = await score(request("Có lỗi", "An error.\n\n</details>\n"));

      expect(result.admissible).toBe(false);
      expect(result.reason).toBe("the draft closes a `<details>` section it never opened");
    });

    it("admits a draft that closes the section it opened itself", async () => {
      // The source is allowed a collapsible section, and reproducing it is the
      // correct answer rather than the failure above.
      const source = "<details><summary>Nhật ký</summary>\n\nCó lỗi\n\n</details>";
      const draft = "<details open><summary>Log</summary>\n\nAn error\n\n</details>";

      const result = await score(request(source, draft));

      expect(result.admissible).toBe(true);
    });

    it("refuses a closer that no later opener can make up for", async () => {
      // Counting the tags and comparing totals would admit this: one of each.
      // The order is what decides it, so the depth is refused the moment it
      // goes negative.
      const result = await score(request("Có lỗi", "</details>\n\n<details>\n\nAn error\n"));

      expect(result.admissible).toBe(false);
      expect(result.reason).toBe("the draft closes a `<details>` section it never opened");
    });

    it("reads the tags out of prose, so a code sample about HTML is not a closer", async () => {
      splitting(
        [{ kind: "prose", text: "Có lỗi" }],
        [
          { kind: "prose", text: "Write " },
          { kind: "code", text: "`</details>`" },
          { kind: "prose", text: " to close it." },
        ],
      );

      const result = await score(request("Có lỗi", "Write `</details>` to close it."));

      expect(result.admissible).toBe(true);
    });

    it("refuses a draft carrying a script neither the target nor the source has", async () => {
      // The failure a cheap model produces most visibly: a phrase of the wrong
      // language left sitting in an otherwise plausible translation. Every
      // other measurement scores it well, and the detector clears it, because
      // the draft really is mostly the language it was asked for.
      mockedContainsScript.mockImplementation(
        (text, script) => script === "Han" && text !== "Có lỗi",
      );

      const result = await score(
        request("Có lỗi", "An error 等到 while loading.", {
          languages: [vietnamese, english, chinese],
        }),
      );

      expect(result.admissible).toBe(false);
      expect(result.reason).toBe("the draft carries Han letters the source never had");
    });

    it("admits a script the source already used", async () => {
      // A thread quoting a Chinese error message wants that message carried
      // across intact, and refusing the draft for reproducing it would refuse
      // the correct answer.
      mockedContainsScript.mockImplementation((_text, script) => script === "Han");

      const result = await score(
        request("Có lỗi 等到", "An error 等到 while loading.", {
          languages: [vietnamese, english, chinese],
        }),
      );

      expect(result.admissible).toBe(true);
    });

    it("exempts the target's own scripts by handing them to the matcher", async () => {
      // Not by comparing script names: a workflow that wrote `Latn` for one
      // language and `Latin` for another would then be told its English draft
      // had leaked into Vietnamese.
      await score(request("Có lỗi", "An error."));

      expect(mockedContainsScript).toHaveBeenCalledWith("An error.", "Latin", english.scripts);
    });

    it("looks for no script the workflow did not configure", async () => {
      // There is no table of scripts in this action and there must not become
      // one — the configured languages are the whole population it can name.
      await score(request("Có lỗi", "An error.", { languages: [chinese] }));

      const asked = new Set(mockedContainsScript.mock.calls.map(([, script]) => script));
      expect([...asked]).toEqual(["Han"]);
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
