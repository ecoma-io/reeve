import { describe, expect, it } from "vitest";

import type { Language } from "../../core/languages.js";
import { score } from "./score.js";

/**
 * Scoring with the real segmenter and the real detector, on a body shaped like
 * the ones this action translates.
 *
 * The unit tests hand the measurements their inputs directly, which proves the
 * arithmetic and proves nothing about what the arithmetic is fed. Here the
 * whole path runs: a Markdown body is split, a draft of it is identified, and
 * the drafts a cheap endpoint actually produces are ranked against each other.
 *
 * Nothing here reaches a model. The detector is called without a picker, which
 * is the property that makes scoring free — and the reason a run against a free
 * endpoint still gets a quality gate.
 */

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const CONFIGURED = [vietnamese, english];

const source = [
  "## Chế độ tối không được giữ lại",
  "",
  "Sau khi tải lại trang, giao diện quay về chế độ sáng. Lỗi này xảy ra trên",
  "cả Firefox và Chrome, xem [nhật ký chạy](https://e.co/runs/123).",
  "",
  "- Mở trang cài đặt",
  "- Bật chế độ tối",
  "- Tải lại trang",
  "",
  "```ts",
  "const theme = localStorage.getItem('theme');",
  "```",
  "",
  "Giá trị trả về là `null`, đáng lẽ phải là `dark`.",
].join("\n");

const faithful = [
  "## Dark mode is not kept after a reload",
  "",
  "After reloading the page, the interface returns to light mode. This happens on",
  "both Firefox and Chrome, see [the run log](https://e.co/runs/123).",
  "",
  "- Open the settings page",
  "- Turn on dark mode",
  "- Reload the page",
  "",
  "```ts",
  "const theme = localStorage.getItem('theme');",
  "```",
  "",
  "The returned value is `null`, where it should have been `dark`.",
].join("\n");

describe("scoring a draft of a real issue body", () => {
  it("admits a faithful translation and scores it at the top", async () => {
    const result = await score({
      source,
      draft: faithful,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.admissible).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.value).toBe(1);
  });

  it("refuses a draft the model returned in the language it was given", async () => {
    // The failure a free endpoint makes most often, and the one every other
    // measurement here scores perfectly: same code, same links, same structure,
    // same length. Only identifying the draft catches it.
    const result = await score({
      source,
      draft: source,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.admissible).toBe(false);
    expect(result.reason).toBe("the draft is the source, unchanged");
  });

  it("refuses a draft reworded in the source language rather than translated", async () => {
    const reworded = source.replace("Sau khi tải lại trang", "Sau khi người dùng tải lại trang");

    const result = await score({
      source,
      draft: reworded,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.admissible).toBe(false);
    expect(result.reason).toBe("the draft is still in Tiếng Việt");
  });

  it("scores down a draft that translated the inside of a code block", async () => {
    const translatedCode = faithful.replace("const theme", "const giaoDien");

    const result = await score({
      source,
      draft: translatedCode,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.admissible).toBe(true);
    expect(result.value).toBeLessThan(1);
  });

  it("scores down a draft that translated a word inside an inline span", async () => {
    // `dark` is a value the code returns, not a word — a draft that renders it
    // as `tối` has changed what the reader is told to look for.
    const translatedSpan = faithful.replace("`dark`", "`toi`");

    const result = await score({
      source,
      draft: translatedSpan,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.value).toBeLessThan(1);
  });

  it("scores down a draft that rewrote a link destination", async () => {
    const rewrittenLink = faithful.replace("https://e.co/runs/123", "https://e.co/en/runs/123");

    const result = await score({
      source,
      draft: rewrittenLink,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.value).toBeLessThan(1);
  });

  it("scores down a draft that stopped after the first paragraph", async () => {
    const truncated = faithful.split("\n").slice(0, 4).join("\n");

    const result = await score({
      source,
      draft: truncated,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.value).toBeLessThan(1);
  });

  it("ranks the faithful draft above every damaged one", async () => {
    // What the caller actually does with a score. No threshold is involved:
    // the drafts are compared, which is a question that needs no invented
    // number to answer.
    const damaged = [
      faithful.replace("const theme", "const giaoDien"),
      faithful.replace("https://e.co/runs/123", "https://e.co/en/runs/123"),
      faithful.split("\n").slice(0, 4).join("\n"),
      faithful.replaceAll("- ", ""),
    ];

    const best = await score({
      source,
      draft: faithful,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });
    const rest = await Promise.all(
      damaged.map((draft) =>
        score({ source, draft, from: vietnamese, to: english, languages: CONFIGURED }),
      ),
    );

    for (const other of rest) expect(best.value).toBeGreaterThan(other.value);
  });

  it("says which code the draft failed to carry across", async () => {
    const translatedCode = faithful.replace("const theme", "const giaoDien");

    const result = await score({
      source,
      draft: translatedCode,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.checks.find((check) => check.name === "code")?.note).toBe(
      "2 of 3 code blocks and spans carried across unchanged",
    );
  });

  it("refuses a body with nothing to translate, whose only faithful draft is itself", async () => {
    // A thread whose body is one stack trace has no prose. The detector says
    // "none" for it long before this module is reached, so the run stops
    // upstream — and if it ever did not, the honest answer here is still that a
    // draft identical to the source is not a translation.
    const trace = "```\nTypeError: undefined is not a function\n```";

    const result = await score({
      source: trace,
      draft: trace,
      from: null,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.admissible).toBe(false);
    expect(result.reason).toBe("the draft is the source, unchanged");
  });

  it("measures a body of mostly code without letting the code carry the prose", async () => {
    const trace = ["Lỗi này:", "", "```", "TypeError: x is not a function", "```"].join("\n");
    const invented = [
      "This error:",
      "",
      "```",
      "TypeError: x is not a function",
      "```",
      "",
      "The stack trace above shows that the value was undefined at the time it was",
      "called, which usually means the module finished loading after the caller ran.",
    ].join("\n");

    const result = await score({
      source: trace,
      draft: invented,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.checks.find((check) => check.name === "code")?.value).toBe(1);
    expect(result.checks.find((check) => check.name === "length")?.value).toBeLessThan(1);
  });

  it("refuses a translation that left a phrase of another configured language in it", async () => {
    // Observed, not imagined: a Vietnamese translation this action posted came
    // back reading "…等到 trang tải xong…". Every other measurement admits it —
    // the code, the links and the structure are intact, the length is
    // plausible, and the detector agrees the draft is Vietnamese, because it
    // mostly is.
    const chinese: Language = { code: "zh", label: "中文", scripts: ["Han"] };
    const leaked = faithful.replace("After reloading", "等到 After reloading");

    const result = await score({
      source,
      draft: leaked,
      from: vietnamese,
      to: english,
      languages: [...CONFIGURED, chinese],
    });

    expect(result.admissible).toBe(false);
    expect(result.reason).toBe("the draft carries Han letters the source never had");
  });

  it("admits a translation whose foreign letters came from the source", async () => {
    const chinese: Language = { code: "zh", label: "中文", scripts: ["Han"] };
    const quoted = source.replace("chế độ sáng", "chế độ sáng (报错: 构建失败)");
    const translated = faithful.replace("light mode", "light mode (报错: 构建失败)");

    const result = await score({
      source: quoted,
      draft: translated,
      from: vietnamese,
      to: english,
      languages: [...CONFIGURED, chinese],
    });

    expect(result.admissible).toBe(true);
  });

  it("admits a draft documenting a closing tag inside a code span", async () => {
    // The real segmenter is what makes this answerable. `</details>` in prose
    // ends the section this action posts the translation inside; the same
    // characters in a span are a code sample, which GitHub renders as text.
    const documented = `${faithful}\n\nClose the block with \`</details>\`.`;

    const result = await score({
      source: `${source}\n\nĐóng khối bằng \`</details>\`.`,
      draft: documented,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
    });

    expect(result.admissible).toBe(true);
  });
});
