import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MarkdownModule from "./markdown.js";
import { mapProse } from "./markdown.js";
import { sanitize } from "./sanitize.js";

// Which spans of a document are code is `markdown.ts`'s question, tested there
// against CommonMark's rules. The stub here is deliberately blunt — everything
// is prose — so a case that passes cannot be passing because the stub happened
// to classify something the way the real segmenter would. The two cases that
// are *about* the code boundary set their own implementation.
// `importOriginal` rather than a bare factory: a module gains exports over
// time, and a factory that replaces the whole module goes red the moment the
// code under test uses one it does not list.
vi.mock("./markdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MarkdownModule>()),
  mapProse: vi.fn((markdown: string, rewrite: (prose: string) => string) => rewrite(markdown)),
}));

const mockedMapProse = vi.mocked(mapProse);

beforeEach(() => {
  mockedMapProse.mockReset();
  mockedMapProse.mockImplementation((markdown, rewrite) => rewrite(markdown));
});

describe("sanitize", () => {
  it("leaves prose with nothing to defang exactly as it was", () => {
    const prose = "Chế độ tối không được giữ lại sau khi tải lại trang.";

    expect(sanitize(prose)).toBe(prose);
  });

  it("returns empty input unchanged", () => {
    expect(sanitize("")).toBe("");
  });

  describe("references that would notify or cross-reference a second time", () => {
    it.each([
      ["a user mention", "cc @johnitvn please", "cc @<!---->johnitvn please"],
      ["a team mention", "cc @ecoma-io/maintainers", "cc @<!---->ecoma-io/maintainers"],
      ["an issue reference", "same as #42", "same as #<!---->42"],
      ["a cross-repo reference", "see ecoma-io/loom#7", "see ecoma-io/loom#<!---->7"],
      ["the GH- spelling", "fixed by GH-42", "fixed by G<!---->H-42"],
      // GitHub links this one, so the guard below deliberately allows a hyphen
      // in front where it refuses a letter, digit or underscore.
      ["the GH- spelling after a hyphen", "fixed by x-GH-42", "fixed by x-G<!---->H-42"],
      ["a reference at the very start", "#42 is the cause", "#<!---->42 is the cause"],
      ["several in one line", "@a and @b on #1", "@<!---->a and @<!---->b on #<!---->1"],
    ])("defangs %s", (_case, source, expected) => {
      expect(sanitize(source)).toBe(expected);
    });

    it("defangs the GH- spelling however it is cased", () => {
      expect(sanitize("gh-42")).toBe("g<!---->h-42");
    });

    it("keeps the words the reader sees, changing only what the renderer does", () => {
      // The whole point of this defang over wrapping the reference in
      // backticks: GitHub strips the empty comment before autolinking, so the
      // reader gets the same characters with no link behind them.
      const defanged = sanitize("cc @johnitvn about #42");

      expect(defanged.replaceAll("<!---->", "")).toBe("cc @johnitvn about #42");
    });
  });

  describe("references it must not touch", () => {
    it.each([
      ["an email address", "write to john@example.com"],
      ["a mention-shaped word after a hyphen-joined word", "co-@lition"],
      ["a url whose fragment looks like an issue reference", "https://example.com/docs#42"],
      ["a url carrying a mention-shaped path", "https://example.com/@johnitvn/repo"],
      ["a markdown link destination", "[the run](/actions/runs/123#step:4:1)"],
      ["a bare hash with no digits", "# Tiêu đề"],
      // Neither renders as a link, so defanging either would put a marker in
      // front of a word for nothing.
      ["a GH- spelling glued to the word before it", "the xGH-42 build"],
      ["a GH- spelling after an underscore", "the _GH-42 build"],
      ["a commit sha", "introduced in fca3701ff268dda4c5a2a8faba7538c84ea1e5f9"],
    ])("leaves %s alone", (_case, source) => {
      expect(sanitize(source)).toBe(source);
    });

    it("still defangs a reference that follows a url on the same line", () => {
      // The url is passed over, not switched off: what comes after it is prose
      // again.
      expect(sanitize("see https://example.com/x and #42")).toBe(
        "see https://example.com/x and #<!---->42",
      );
    });
  });

  describe("html comments", () => {
    it("empties one in prose, leaving its delimiters where they were", () => {
      expect(sanitize("before <!-- hidden --> after")).toBe("before <!-- ------ --> after");
    });

    it("empties one spanning several lines", () => {
      expect(sanitize("a\n<!-- one\ntwo -->\nb")).toBe("a\n<!-- ---\n--- -->\nb");
    });

    it("empties each of several rather than everything between the first and last", () => {
      expect(sanitize("<!-- a -->keep<!-- b -->")).toBe("<!-- - -->keep<!-- - -->");
    });

    it("empties a forged copy of a comment marker", () => {
      // The marker's safety comes from its fixed position in the comment, not
      // from this. Emptying it anyway costs nothing and closes the shape of the
      // attack rather than one spelling of it.
      expect(sanitize("Xin chào <!-- reeve:translate -->")).toBe(
        "Xin chào <!-- --------------- -->",
      );
    });

    it("empties a comment before defanging, so it cannot eat the defang", () => {
      expect(sanitize("<!-- x -->cc @johnitvn")).toBe("<!-- - -->cc @<!---->johnitvn");
    });

    it("overwrites the interior in place rather than deleting it", () => {
      // The interior is the same length it was, and every character the
      // segmenter reads is still where it was: a backtick, a tilde, a
      // backslash, a space and a line break. Deleting any of them moves a code
      // boundary on the next run over the same text, which is how prose the
      // first run protected gets defanged by the second.
      expect(sanitize("a <!-- x`y~z\\w -->")).toBe("a <!-- -`-~-\\- -->");
    });

    it("leaves nothing of the interior a reader could have read", () => {
      // What survives is punctuation with no word in it, and a comment renders
      // as nothing whatever is between its delimiters anyway.
      expect(sanitize("<!-- reeve:translate -->")).toMatch(/^<!--[-`~\\\r\n ]*-->$/);
    });

    it("defangs an opener that nothing closes", () => {
      // Left alone it would close over the marker written to its right, and
      // GitHub would show the reader the marker instead of hiding it.
      expect(sanitize("a <!--cc @johnitvn")).toBe("a <<!---->!--cc @<!---->johnitvn");
    });

    it("leaves an opener alone once it has a closer of its own", () => {
      // The emptied comment's own delimiters must survive the dangling-opener
      // pass, or emptying would tear every comment open again.
      expect(sanitize("<!-- x -->")).toBe("<!-- - -->");
    });

    it("keeps the characters a dangling opener showed the reader", () => {
      const defanged = sanitize("a <!--cc @johnitvn");

      expect(defanged.replaceAll("<!---->", "")).toBe("a <!--cc @johnitvn");
    });
  });

  describe("the code boundary", () => {
    it("rewrites only what the segmenter hands over as prose", () => {
      mockedMapProse.mockImplementation((_markdown, rewrite) => `${rewrite("cc @a ")}\`@types/b\``);

      expect(sanitize("cc @a `@types/b`")).toBe("cc @<!---->a `@types/b`");
    });

    it("asks the segmenter rather than scanning the document itself", () => {
      // If this ever stopped going through `mapProse`, every rule above would
      // start applying inside code samples.
      sanitize("anything");

      expect(mockedMapProse).toHaveBeenCalledOnce();
      expect(mockedMapProse.mock.calls[0]?.[0]).toBe("anything");
    });
  });
});
