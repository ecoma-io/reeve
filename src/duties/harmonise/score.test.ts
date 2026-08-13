/**
 * Unit tests for the score module — deterministic draft scoring.
 */
import { describe, expect, it } from "vitest";

import { scoreDraft } from "./score.js";

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
    const score = scoreDraft("", original, []);
    expect(score.admissible).toBe(false);
    expect(score.value).toBe(0);
    expect(score.reason).toBe("empty draft");
  });

  it("refuses drafts identical to the original", () => {
    const score = scoreDraft(original, original, []);
    expect(score.admissible).toBe(false);
    expect(score.reason).toBe("unchanged from original");
  });

  it("refuses drafts that translate glossary terms", () => {
    const draft = original.replace("Reeve", "Quan trị");
    const score = scoreDraft(draft, original, ["Reeve"]);
    expect(score.admissible).toBe(false);
    expect(score.reason).toContain("Reeve");
  });

  it("admits a draft with minor changes", () => {
    const draft = original.replace("set up Reeve", "thiết lập Reeve");
    const score = scoreDraft(draft, original, []);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeGreaterThan(0);
  });

  it("penalises drafts that lose code blocks", () => {
    const draft = original
      .replace("```bash", "")
      .replace("npm install reeve", "")
      .replace("```", "")
      .replace("set up Reeve", "thiết lập Reeve");

    const score = scoreDraft(draft, original, []);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeLessThan(1);
  });

  it("penalises drafts that change URLs", () => {
    const draft = original
      .replace("https://reeve.dev", "https://wrong.dev")
      .replace("set up Reeve", "thiết lập Reeve");

    const score = scoreDraft(draft, original, []);
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

    const score = scoreDraft(draft, original, ["Reeve"]);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeGreaterThan(0.5);
  });

  it("preserves glossary terms that appear in original", () => {
    const draft = original.replace("set up Reeve", "thiết lập Reeve");
    const score = scoreDraft(draft, original, ["Reeve"]);
    expect(score.admissible).toBe(true);
    expect(score.value).toBeGreaterThan(0);
  });
});
