/**
 * Unit tests for the score module — deterministic draft scoring.
 */
import { describe, expect, it } from "vitest";

import type { Language } from "../../core/languages.js";
import { scoreDraft } from "./score.js";

/** A Vietnamese language object for test use. */
const VI: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] };
/** An English language object for test use. */
const EN: Language = { code: "en", label: "English", scripts: ["Latn"] };
/** A Chinese language object for test use — lets foreignScript detect Han. */
const ZH: Language = { code: "zh", label: "中文", scripts: ["Han"] };
/** All test languages. */
const LANGUAGES: readonly Language[] = [EN, VI, ZH];

describe("scoreDraft", () => {
  const original = [
    "# Getting Started",
    "",
    "This guide helps you set up Reeve.",
    "",
    "```bash",
    "npm install reeve",
    "```",
    "",
    "See [docs](https://reeve.dev) for more.",
  ].join("\n");

  it("refuses empty drafts", () => {
    const score = scoreDraft("", original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(false);
    expect(score.value).toBe(0);
    expect(score.reason).toBe("empty draft");
  });

  it("refuses drafts identical to the original", () => {
    const score = scoreDraft(original, original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(false);
    expect(score.reason).toBe("unchanged from original");
  });

  it("refuses drafts that translate glossary terms", () => {
    const draft = original.replace("Reeve", "Quan trị");
    const score = scoreDraft(draft, original, ["Reeve"], original, VI, LANGUAGES);
    expect(score.admissible).toBe(false);
    expect(score.reason).toContain("Reeve");
  });

  it("refuses drafts in the wrong script", () => {
    // A draft full of Han characters for a Vietnamese target
    const draft = "# 开始使用\n\n本指南帮助您设置 Reeve。";
    const score = scoreDraft(draft, original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(false);
    expect(score.reason).toContain("script");
  });

  it("admits a draft with minor changes", () => {
    const draft = original.replace("set up Reeve", "thiết lập Reeve");
    const score = scoreDraft(draft, original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeGreaterThan(0);
  });

  it("penalises drafts that lose code blocks", () => {
    const draft = original
      .replace("```bash", "")
      .replace("npm install reeve", "")
      .replace("```", "")
      .replace("set up Reeve", "thiết lập Reeve");

    const score = scoreDraft(draft, original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeLessThan(1);
  });

  it("penalises drafts that change URLs", () => {
    const draft = original
      .replace("https://reeve.dev", "https://wrong.dev")
      .replace("set up Reeve", "thiết lập Reeve");

    const score = scoreDraft(draft, original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeLessThan(1);
  });

  it("scores well for drafts that preserve structure and code", () => {
    const draft = [
      "# Bắt đầu",
      "",
      "Hướng dẫn này giúp bạn thiết lập Reeve.",
      "",
      "```bash",
      "npm install reeve",
      "```",
      "",
      "Xem [tài liệu](https://reeve.dev) để biết thêm.",
    ].join("\n");

    const score = scoreDraft(draft, original, ["Reeve"], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeGreaterThan(0.5);
  });

  it("preserves glossary terms that appear in original", () => {
    const draft = original.replace("set up Reeve", "thiết lập Reeve");
    const score = scoreDraft(draft, original, ["Reeve"], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeGreaterThan(0);
  });

  it("does not penalise a draft for glossary terms absent from the original", () => {
    // "Acme" is in the glossary but not in the original target — the draft
    // cannot be expected to preserve what was never there.
    const draft = original.replace("set up Reeve", "thiết lập Reeve");
    const score = scoreDraft(draft, original, ["Reeve", "Acme"], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    // The glossary check should score 1.0: "Reeve" is present in both original
    // and draft, and "Acme" is not in the original so it is excluded.
    expect(score.value).toBeGreaterThan(0);
  });

  it("does not refuse a draft whose script matches the target", () => {
    // Vietnamese uses Latin script — a Latin draft should pass the script check
    const draft = "# Bắt đầu\n\nHướng dẫn này giúp bạn thiết lập Reeve.";
    const score = scoreDraft(draft, original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
  });

  it("does not refuse a draft for a script the source already uses", () => {
    // If the source is English (Latn) and the target is Vietnamese (Latn),
    // a draft with Latn is fine — it's the target's own script.
    const draft = original.replace("set up Reeve", "thiết lập Reeve");
    const score = scoreDraft(draft, original, [], original, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
  });
});

describe("scoreDraft on an initial translation (empty original)", () => {
  const source = [
    "# Getting Started",
    "",
    "This guide helps you set up Reeve.",
    "",
    "```bash",
    "npm install reeve",
    "```",
    "",
    "See [docs](https://reeve.dev) for more.",
  ].join("\n");

  it("anchors against the source: a faithful translation scores high", () => {
    const draft = [
      "# Bắt đầu",
      "",
      "Hướng dẫn này giúp bạn thiết lập Reeve.",
      "",
      "```bash",
      "npm install reeve",
      "```",
      "",
      "Xem [tài liệu](https://reeve.dev) để biết thêm.",
    ].join("\n");

    const score = scoreDraft(draft, "", [], source, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeGreaterThan(0.9);
  });

  it("penalises an initial draft that drops the source's code block", () => {
    const draft = "# Bắt đầu\n\nHướng dẫn này giúp bạn thiết lập Reeve.";
    const score = scoreDraft(draft, "", [], source, VI, LANGUAGES);
    expect(score.admissible).toBe(true);
    const full = scoreDraft(
      source.replace("Getting Started", "Bắt đầu"),
      "",
      [],
      source,
      VI,
      LANGUAGES,
    );
    expect(score.value).toBeLessThan(full.value);
  });

  it("refuses an initial draft identical to the source — not a translation", () => {
    const score = scoreDraft(source, "", [], source, VI, LANGUAGES);
    expect(score.admissible).toBe(false);
    expect(score.reason).toContain("identical to the source");
  });

  it("refuses an initial draft that translated a glossary term the source carries", () => {
    const draft = "# Bắt đầu\n\nHướng dẫn này giúp bạn thiết lập Quản Gia.";
    const score = scoreDraft(draft, "", ["Reeve"], source, VI, LANGUAGES);
    expect(score.admissible).toBe(false);
    expect(score.reason).toContain("glossary term");
  });
});
