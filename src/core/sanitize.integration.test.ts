import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sanitize } from "./sanitize.js";

/**
 * Sanitising with the real segmenter, on text shaped like the bodies this
 * action reposts.
 *
 * The unit tests stub the segmenter flat, which proves the rules and proves
 * nothing about where they stop. Where they stop *is* the behaviour: every
 * defang below is correct in prose and a corrupted code sample one character
 * to the left.
 */

describe("sanitizing a real issue body", () => {
  it("defangs the mention in the prose and leaves the package name in the code span", () => {
    // The case that decides the whole design. Both are `@` followed by a name;
    // only one of them notifies anybody.
    expect(sanitize("cc @johnitvn — bumping `@types/node` broke the build")).toBe(
      "cc @<!---->johnitvn — bumping `@types/node` broke the build",
    );
  });

  it("leaves a fenced block entirely alone, however much of it looks like a reference", () => {
    const body = [
      "Lỗi này bắt đầu từ #42, cc @johnitvn:",
      "",
      "```c",
      "#include <stdio.h>",
      "#define MAX 42",
      "// see GH-7 and @author",
      "```",
      "",
      "Chi tiết ở #43.",
    ].join("\n");

    expect(sanitize(body)).toBe(
      [
        "Lỗi này bắt đầu từ #<!---->42, cc @<!---->johnitvn:",
        "",
        "```c",
        "#include <stdio.h>",
        "#define MAX 42",
        "// see GH-7 and @author",
        "```",
        "",
        "Chi tiết ở #<!---->43.",
      ].join("\n"),
    );
  });

  it("protects everything after a fence the model forgot to close", () => {
    // Which is what a reader sees too: GitHub renders the rest as code. A
    // defang here would show up as literal `<!---->` inside a code block.
    const body = "Xem log:\n\n```\nerror at #42 by @johnitvn";

    expect(sanitize(body)).toBe(body);
  });

  it("keeps an html comment that is part of a code sample", () => {
    const body = [
      "Thẻ này bị bỏ qua, cc @johnitvn:",
      "",
      "```html",
      "<!-- ignored -->",
      "```",
    ].join("\n");

    expect(sanitize(body)).toBe(
      ["Thẻ này bị bỏ qua, cc @<!---->johnitvn:", "", "```html", "<!-- ignored -->", "```"].join(
        "\n",
      ),
    );
  });

  it("handles a body that mixes a table, a link and a mention", () => {
    const body = [
      "| Nguyên nhân | Liên quan |",
      "| --- | --- |",
      "| Đường dẫn có dấu cách | #42 |",
      "",
      "Xem [lần chạy](https://github.com/ecoma-io/reeve/actions/runs/123#step:4:1), cc @johnitvn.",
    ].join("\n");

    expect(sanitize(body)).toBe(
      [
        "| Nguyên nhân | Liên quan |",
        "| --- | --- |",
        "| Đường dẫn có dấu cách | #<!---->42 |",
        "",
        "Xem [lần chạy](https://github.com/ecoma-io/reeve/actions/runs/123#step:4:1), cc @<!---->johnitvn.",
      ].join("\n"),
    );
  });

  it("changes nothing a reader can see", () => {
    // Removing the inert markers has to give back the words that went in.
    // A defang that altered the text would be a translation the duty
    // rewrote rather than posted.
    const body = "cc @johnitvn về #42 và GH-7, xem `@types/node` và ```#1```";

    expect(sanitize(body).replaceAll("<!---->", "")).toBe(body);
  });

  describe("a body written by whoever opened the issue", () => {
    // GitHub caps an issue body here, so this is the largest text this module
    // can be handed and the worst case is reachable by typing it.
    const CAP = 65536;

    it.each([
      ["openers nothing closes", "<!--".repeat(CAP / 4)],
      ["closers nothing opened", "-->".repeat(CAP / 3)],
      ["openers before the one closer that ends them", "<!--".repeat((CAP - 3) / 4) + "-->"],
      ["a closer before openers that will never reach it", "-->" + "<!--".repeat((CAP - 3) / 4)],
      ["comments and nothing else", "<!-- x -->".repeat(CAP / 10)],
      ["references and nothing else", "cc @a về #1. ".repeat(CAP / 13)],
    ])("sanitizes %s at the size limit without stalling the job", (_case, body) => {
      // A bound, not a benchmark: each of these runs in around 10 ms, and the
      // first two took 1.5 s when finding a comment's end was a regex — one
      // scan to the end of the body per opener. The number below is two orders
      // of magnitude of slack and still fails that shape outright.
      const started = performance.now();
      sanitize(body);

      expect(performance.now() - started).toBeLessThan(200);
    });
  });

  describe("running over its own output", () => {
    // The action edits its own comment on later runs, so it sanitizes text it
    // already sanitized. Every case below came out of the property at the end
    // and is kept as its own test: the property proves there is no such input
    // left, and these say what the ones that existed were.

    it("does not let an emptied comment join the runs that surrounded it", () => {
      // The stray backtick and the span behind it are one run of four once the
      // comment between them is gone — a run that closes nowhere, so the code
      // the first pass protected reads as prose on the second.
      const once = sanitize("`<!-- x -->```GH-2```");

      expect(once).toBe("`<!-- - -->```GH-2```");
      expect(sanitize(once)).toBe(once);
    });

    it("does not leave an opener that closes over the marker written after it", () => {
      // `GH-2` is defanged to the right of an opener nothing closes, and the
      // marker's own `-->` becomes that opener's closer.
      const once = sanitize("``<!--GH-2");

      expect(once).toBe("``<<!---->!--G<!---->H-2");
      expect(sanitize(once)).toBe(once);
    });

    it("does not free a backtick an escape was holding down", () => {
      // The backslash is inside the comment and the backtick just past it.
      // Delete the backslash while emptying and the backtick is live, pairs
      // with the one after the comment, and turns the comment's own `-->` into
      // a code span.
      const once = sanitize("<!--\\`<!---->`");

      expect(sanitize(once)).toBe(once);
    });

    it("does not promote a backtick run to a fence opener by emptying the line behind it", () => {
      // The two runs of four backticks are a code span, so the second line's
      // ````` ````<!--`--> ````` is inside code and the segmenter never offers
      // it. It is also not a fence opener, because a backtick fence may not
      // carry a backtick in its info string — and the only backtick in that
      // info string is the one inside the comment. Empty that comment down to
      // nothing and the line becomes a valid opener, so the second run reads
      // the span as a fence, hands the first line's comment over as prose, and
      // empties a comment the first run had left inside code.
      const once = sanitize("<!--````<!-- x -->\n````<!--`-->");

      expect(sanitize(once)).toBe(once);
    });

    it("does not find a second reference inside the first one it defanged", () => {
      // `@u-GH-2` is one whole mention — GitHub links neither half of it. Mark
      // it and the mention no longer matches its own text, leaving `GH-2` at
      // the front of a hyphen, which GitHub does link and the next run does
      // defang.
      const once = sanitize("cc @u-GH-2");

      expect(once).toBe("cc @<!---->u-GH-2");
      expect(sanitize(once)).toBe(once);
    });

    it("is idempotent, so a comment edited in place does not accumulate markers", () => {
      // A translation that grew another `<!---->` per reference per run would
      // be unreadable in the raw body within a handful of edits.
      //
      // The alphabet is the delimiters broken into single units, so that shapes
      // no well-formed body contains — an opener with no closer, a lone
      // backslash before a fence — are reachable at all. Every counterexample
      // above came from one of them. The seed is fixed because a property that
      // draws a new sample each run turns any change red for a defect it did
      // not introduce, which is a report nobody can act on; the exploring is
      // done here, by raising `numRuns` and running it, and what it finds gets
      // pinned above.
      const markdownish = fc.string({
        unit: fc.constantFrom(
          "`",
          "``",
          "```",
          "````",
          "~",
          "~~~",
          "\n",
          "\r\n",
          " ",
          "   ",
          "a",
          "_",
          "-",
          "<",
          ">",
          "@u",
          "@o/t",
          "#1",
          "GH-2",
          "<!--",
          "-->",
          "<!-- x -->",
          "<!---->",
          "<!--`-->",
          "<!--\\-->",
          "https://e.co/#3",
          "](x)",
          "\\",
        ),
        maxLength: 60,
      });

      fc.assert(
        fc.property(markdownish, (text) => {
          const once = sanitize(text);
          expect(sanitize(once)).toBe(once);
        }),
        { numRuns: 20000, seed: 20260805 },
      );
    });
  });
});
