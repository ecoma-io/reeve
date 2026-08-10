import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mapProse, segments, type Segment } from "./markdown.js";

/** The kinds in order, which is what most cases are actually asserting. */
function shape(markdown: string): SegmentKindWithText[] {
  return segments(markdown).map(({ kind, text }) => [kind, text]);
}
type SegmentKindWithText = [Segment["kind"], string];

function rejoined(markdown: string): string {
  return segments(markdown)
    .map((segment) => segment.text)
    .join("");
}

describe("segments", () => {
  it("returns nothing for empty input", () => {
    expect(segments("")).toEqual([]);
  });

  it("returns prose that contains no code as one segment", () => {
    expect(shape("Build fails on Windows\nwhen the path has a space")).toEqual([
      ["prose", "Build fails on Windows\nwhen the path has a space"],
    ]);
  });

  describe("fenced blocks", () => {
    it("separates a fenced block from the prose around it", () => {
      expect(shape("before\n```\ncode\n```\nafter")).toEqual([
        ["prose", "before\n"],
        ["fence", "```\ncode\n```\n"],
        ["prose", "after"],
      ]);
    });

    it("keeps the info string with the block", () => {
      expect(shape("```ts\nconst a = 1;\n```")).toEqual([["fence", "```ts\nconst a = 1;\n```"]]);
    });

    it("closes on a longer run than the one that opened it", () => {
      // CommonMark's rule, and the reason a block containing ``` is written
      // with four backticks.
      expect(shape("````\n```\n````\n")).toEqual([["fence", "````\n```\n````\n"]]);
    });

    it("does not close on a shorter run", () => {
      expect(shape("````\n```\nstill code\n````")).toEqual([
        ["fence", "````\n```\nstill code\n````"],
      ]);
    });

    it("treats tilde fences the same way, and does not let one close a backtick fence", () => {
      expect(shape("~~~\ncode\n~~~")).toEqual([["fence", "~~~\ncode\n~~~"]]);
      expect(shape("```\ncode\n~~~\nmore\n```")).toEqual([["fence", "```\ncode\n~~~\nmore\n```"]]);
    });

    it("allows the up-to-three-space indent Markdown allows", () => {
      expect(shape("   ```\n   code\n   ```")).toEqual([["fence", "   ```\n   code\n   ```"]]);
    });

    it("runs an unclosed fence to the end, the way GitHub renders it", () => {
      // A model that opens a block and forgets to close it turns the rest of
      // the comment into code. Disagreeing with the renderer here would let
      // prose rules run over text a reader sees as code.
      expect(shape("intro\n```\nnever closed")).toEqual([
        ["prose", "intro\n"],
        ["fence", "```\nnever closed"],
      ]);
    });

    it("does not read a paragraph's inline span as a block opener", () => {
      // ``` `a` ``` on one line is a code span, not a fence: a backtick fence's
      // info string may not contain a backtick.
      expect(shape("``` `a` ```")).toEqual([["code", "``` `a` ```"]]);
    });

    it("separates two blocks that share a paragraph between them", () => {
      expect(shape("```\na\n```\nmid\n```\nb\n```")).toEqual([
        ["fence", "```\na\n```\n"],
        ["prose", "mid\n"],
        ["fence", "```\nb\n```"],
      ]);
    });
  });

  describe("inline code spans", () => {
    it("separates a span from the prose around it", () => {
      expect(shape("install `@types/node` first")).toEqual([
        ["prose", "install "],
        ["code", "`@types/node`"],
        ["prose", " first"],
      ]);
    });

    it("closes only on a run of exactly the same length", () => {
      expect(shape("a ``b ` c`` d")).toEqual([
        ["prose", "a "],
        ["code", "``b ` c``"],
        ["prose", " d"],
      ]);
    });

    it("treats an unterminated backtick run as literal text", () => {
      // A stray backtick in an issue body is common, and reading the rest of
      // the paragraph as code would exempt it from every prose rule.
      expect(shape("a ` b @user")).toEqual([["prose", "a ` b @user"]]);
    });

    it("does not open a span on an escaped backtick", () => {
      expect(shape("a \\` b")).toEqual([["prose", "a \\` b"]]);
    });

    it("ignores a backslash inside a span, because escapes do not apply there", () => {
      expect(shape("a `b \\` c")).toEqual([
        ["prose", "a "],
        ["code", "`b \\`"],
        ["prose", " c"],
      ]);
    });

    it("lets a span cross a line break inside a paragraph", () => {
      expect(shape("see `one\ntwo` here")).toEqual([
        ["prose", "see "],
        ["code", "`one\ntwo`"],
        ["prose", " here"],
      ]);
    });

    it("finds several spans in one paragraph", () => {
      expect(shape("`a` and `b`")).toEqual([
        ["code", "`a`"],
        ["prose", " and "],
        ["code", "`b`"],
      ]);
    });

    it("does not look for spans inside a fenced block", () => {
      expect(shape("```\n`a` and `b`\n```")).toEqual([["fence", "```\n`a` and `b`\n```"]]);
    });
  });

  it("reassembles to the input exactly, for any text", () => {
    // The invariant both consumers depend on. `sanitize` rebuilds a comment
    // from these pieces, so a segmenter that dropped or duplicated a byte would
    // corrupt somebody's issue body rather than fail.
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(rejoined(text)).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it("reassembles to the input exactly, for text made of the characters that decide the split", () => {
    // Unconstrained strings almost never contain a fence. This alphabet makes
    // openers, closers and near-misses common enough to actually explore.
    const markdownish = fc.string({
      unit: fc.constantFrom("`", "~", "\n", " ", "a", "\\", "ts", "```", "``", "@u"),
      maxLength: 40,
    });
    fc.assert(
      fc.property(markdownish, (text) => {
        expect(rejoined(text)).toBe(text);
      }),
      { numRuns: 500 },
    );
  });
});

describe("mapProse", () => {
  it("rewrites prose and leaves code untouched", () => {
    const shout = (prose: string): string => prose.toUpperCase();

    expect(mapProse("see `keep me` now\n```\nkeep me too\n```", shout)).toBe(
      "SEE `keep me` NOW\n```\nkeep me too\n```",
    );
  });

  it("returns the input unchanged when the rewrite is the identity", () => {
    const source = "a `b` c\n```ts\nd\n```\ne ``f`` g";

    expect(mapProse(source, (prose) => prose)).toBe(source);
  });

  it("passes each prose run separately rather than as one joined string", () => {
    // A rewrite that matched across a code span would be matching text the
    // reader never sees as adjacent.
    const seen: string[] = [];
    mapProse("one `x` two", (prose) => {
      seen.push(prose);
      return prose;
    });

    expect(seen).toEqual(["one ", " two"]);
  });
});
