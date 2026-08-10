import { describe, expect, it } from "vitest";

import { containsScript, isScriptName } from "./script.js";

describe("isScriptName", () => {
  it("accepts Unicode script long names and their four-letter aliases", () => {
    for (const name of [
      "Latin",
      "Latn",
      "Han",
      "Hani",
      "Cyrillic",
      "Cyrl",
      "Hiragana",
      "Old_Italic",
    ]) {
      expect(isScriptName(name)).toBe(true);
    }
  });

  it("rejects a name Unicode does not define", () => {
    // `Japanese` is the tempting one: it is a language, and Unicode has no such
    // script — a workflow that writes it must be told so rather than silently
    // matching nothing.
    expect(isScriptName("Japanese")).toBe(false);
    expect(isScriptName("Vietnamese")).toBe(false);
    expect(isScriptName("Emoji")).toBe(false);
  });

  it("rejects a name that could close the property escape and continue the pattern", () => {
    // The name reaches a `RegExp` constructor and arrives from a workflow file
    // in someone else's repository. Anything that could turn `\p{Script=X}`
    // into a pattern of the author's choosing has to be refused on shape,
    // before the runtime ever sees it.
    expect(isScriptName("Latin}|(?:")).toBe(false);
    expect(isScriptName("Latin}.*{")).toBe(false);
    expect(isScriptName("Latin}")).toBe(false);
    expect(isScriptName("")).toBe(false);
    expect(isScriptName("Latin Han")).toBe(false);
    expect(isScriptName("_Latin")).toBe(false);
  });
});

describe("containsScript", () => {
  it("finds a script present anywhere in the text, not only as its majority", () => {
    expect(containsScript("Fix the 构建 failure", "Han")).toBe(true);
    expect(containsScript("Fix the 构建 failure", "Latin")).toBe(true);
  });

  it("reports a script that is absent", () => {
    expect(containsScript("Build fails on Windows", "Han")).toBe(false);
    expect(containsScript("Build fails on Windows", "Cyrillic")).toBe(false);
  });

  it("treats Latin letters carrying diacritics as Latin", () => {
    // Vietnamese and Turkish are Latin-script languages whose text is mostly
    // outside ASCII. A check that reached for `A-Za-z` would decide they use no
    // configured script at all and skip the thread.
    expect(containsScript("Không cài được trên Node", "Latin")).toBe(true);
    expect(containsScript("Yol bir boşluk içerdiğinde", "Latin")).toBe(true);
    expect(containsScript("Der Dunkelmodus bleibt nicht erhalten", "Latin")).toBe(true);
  });

  it("does not count digits, punctuation, spaces or emoji as belonging to any script", () => {
    // This is what makes "no candidate survived" a meaningful answer: a body
    // that is only a stack trace and a version number has no prose to identify.
    const noProse = "  1.2.3 — [#42] (2026-08-05) 🎉 {}; ";
    for (const script of ["Latin", "Han", "Cyrillic", "Arabic"]) {
      expect(containsScript(noProse, script)).toBe(false);
    }
  });

  it("reports false for a script name Unicode does not define", () => {
    expect(containsScript("anything at all", "Japanese")).toBe(false);
  });

  it("ignores characters belonging to an exempted script", () => {
    // The question scoring asks: does this draft carry letters of a script its
    // target language does not use? A plain `containsScript` would answer yes
    // to Latin for every English draft ever written.
    expect(containsScript("Fix the 构建 failure", "Latin", ["Latin"])).toBe(false);
    expect(containsScript("Fix the 构建 failure", "Han", ["Latin"])).toBe(true);
  });

  it("exempts a script however the workflow spelled it", () => {
    // A consumer is free to write `Latn` for one language and `Latin` for
    // another, and both name the same set of characters. Comparing the names
    // would call the second one foreign; asking Unicode which characters they
    // cover cannot.
    expect(containsScript("Fix the failure", "Latin", ["Latn"])).toBe(false);
    expect(containsScript("修复构建", "Hani", ["Han"])).toBe(false);
  });

  it("exempts every script it is given, not only the first", () => {
    const japanese = "パスに空白が含まれるとビルドが失敗する";
    expect(containsScript(japanese, "Katakana", ["Han", "Hiragana"])).toBe(true);
    expect(containsScript(japanese, "Katakana", ["Han", "Hiragana", "Katakana"])).toBe(false);
  });

  it("reports false when an exempted name is not a script the runtime knows", () => {
    // Same refusal as an unknown script asked about directly: the name reaches
    // a `RegExp` constructor, so nothing outside the allowed shape may pass,
    // and a name Unicode does not define cannot be compiled into a guard.
    expect(containsScript("Fix the 构建 failure", "Han", ["Japanese"])).toBe(false);
    expect(containsScript("Fix the 构建 failure", "Han", ["Latin}|(?:"])).toBe(false);
  });

  it("keeps an exempted answer apart from an unexempted one of the same words", () => {
    // The two calls differ only in where the argument boundary falls, and the
    // compiled matchers are cached by name — a key that ran them together would
    // hand the second call the first one's answer.
    expect(containsScript("Fix the 构建 failure", "Han Latin")).toBe(false);
    expect(containsScript("Fix the 构建 failure", "Han", ["Latin"])).toBe(true);
  });

  it("distinguishes the scripts a Han-using language shares from those it does not", () => {
    // Japanese and Chinese both use Han; only Japanese uses kana. That
    // asymmetry is what a workflow encodes as `ja:日本語:Han+Hiragana+Katakana`,
    // and it is the reason narrowing eliminates rather than selects.
    const japanese = "パスに空白が含まれるとビルドが失敗する";
    const chinese = "路径中包含空格时构建失败";
    expect(containsScript(japanese, "Hiragana")).toBe(true);
    expect(containsScript(chinese, "Hiragana")).toBe(false);
    expect(containsScript(chinese, "Han")).toBe(true);
  });
});
