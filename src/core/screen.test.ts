import { describe, expect, it } from "vitest";

import { screen } from "./screen.js";

// Nothing is mocked. Every rule here is a pure function of two strings and a
// number, which is the point of the stage: it reaches an answer with no
// provider constructed.

const MINIMUM = 24;

function screened(title: string, body: string, minimum = MINIMUM) {
  return screen({ title, body, minimum });
}

describe("a thread with nothing in it", () => {
  it("stops a thread whose title and body are both empty", () => {
    expect(screened("", "")).toEqual({
      reason: "empty",
      note: "the thread carries no text to work from",
    });
  });

  it("stops a thread that is only whitespace", () => {
    expect(screened("   ", "\n\n\t\n")?.reason).toBe("empty");
  });
});

describe("a title with no body", () => {
  it("lets a substantive title through, because a title is authored text", () => {
    // The contract says "an empty body", and an empty body is not an empty
    // thread. A maintainer labels this one in a second, and a duty that skipped
    // it would skip a large share of a real tracker.
    expect(screened("Export produces an empty file for single-row tables", "")).toBeNull();
  });

  it("stops a title too short to conclude anything from", () => {
    expect(screened("help", "")?.reason).toBe("too-short");
  });
});

describe("an issue template nobody filled in", () => {
  const FORM = [
    "### What happened?",
    "",
    "_No response_",
    "",
    "### Version",
    "",
    "_No response_",
  ].join("\n");

  it("stops a form submitted empty, and says it was a form", () => {
    // The same absence as an empty thread, with different advice attached.
    expect(screened("Bug", FORM)).toEqual({
      reason: "template",
      note: "the issue template came back with nothing filled in",
    });
  });

  it("stops a Markdown template whose instructions are all HTML comments", () => {
    const body = "<!-- Describe the bug here -->\n\n<!-- Steps to reproduce -->";
    expect(screened("Bug", body)?.reason).toBe("template");
  });

  it("stops a template that is only headings and rules", () => {
    expect(screened("Bug", "## Steps\n\n---\n\n## Expected\n")?.reason).toBe("template");
  });

  it("lets a form through once one field is answered", () => {
    const body = FORM.replace(
      "_No response_\n\n### Version",
      "The export writes a zero-byte file whenever the table has exactly one row.\n\n### Version",
    );
    expect(screened("Bug", body)).toBeNull();
  });

  it("keeps a ticked box, because ticking one is the reporter answering", () => {
    const body =
      "### Checks\n\n- [ ] I searched\n- [x] This reproduces on the latest release build";
    expect(screened("Bug", body)).toBeNull();
  });

  it("drops an unticked box, because the words beside it are the template's", () => {
    const body = "### Checks\n\n- [ ] I have searched the existing issues for a duplicate";
    expect(screened("Bug", body)?.reason).toBe("template");
  });
});

describe("too little to reach a verdict", () => {
  it("stops a short body with no code, link or error in it", () => {
    const result = screened("It broke", "please fix");

    expect(result?.reason).toBe("too-short");
    expect(result?.note).toContain("under the 24");
  });

  it("counts the title and the body together", () => {
    // Either one alone is under the floor; together they are a report.
    expect(screened("Export is empty", "for one-row tables")).toBeNull();
  });

  it("lets a short thread through when it carries a link", () => {
    // A one-line report with a reproduction is a better report than three
    // paragraphs of apology, and character count has that backwards.
    expect(screened("Fails", "see https://example.com/repro")).toBeNull();
  });

  it("lets a short thread through when it carries code", () => {
    expect(screened("Fails", "`reeve --help`")).toBeNull();
  });

  it("lets a short thread through when it carries a fenced block", () => {
    expect(screened("Fails", "```\nnpm run build\n```")).toBeNull();
  });

  it.each([
    ["TypeError: x is not a function"],
    ["Traceback (most recent call last):"],
    ["    at Object.<anonymous> (index.js:3)"],
    ["exited with code 137"],
    ["Segmentation fault"],
  ])("lets a short thread through when it carries `%s`", (evidence) => {
    expect(screened("Fails", evidence)).toBeNull();
  });

  it("is turned off entirely by a minimum of zero", () => {
    // The right setting for a tracker whose reports are routinely terse. The
    // consumer decides, because a screen that drops genuine reports is much
    // worse than one that passes junk through.
    expect(screened("hi", "no", 0)).toBeNull();
  });

  it("still stops an empty thread when the length rule is off", () => {
    expect(screened("", "", 0)?.reason).toBe("empty");
  });

  it("respects a raised minimum", () => {
    expect(screened("Export is empty", "for one-row tables", 200)?.reason).toBe("too-short");
  });
});

describe("what it never does", () => {
  it("passes a long thread it understands nothing about", () => {
    // This stage measures how much was written and never what it says. A screen
    // that judged content would drop a blunt real report and pass polite spam.
    expect(
      screened("Câu hỏi", "Tôi không hiểu tại sao ứng dụng lại chạy chậm như vậy."),
    ).toBeNull();
  });

  it("passes a thread written in a script with no spaces in it", () => {
    expect(
      screened("导出功能有问题", "导出的文件在表格只有一行时是空的，这是一个错误。"),
    ).toBeNull();
  });
});
