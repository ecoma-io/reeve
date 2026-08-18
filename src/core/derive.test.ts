import { describe, expect, it } from "vitest";

import { deriveLanguage } from "./derive.js";

// `script.js` is a real collaborator here rather than a mock, and deliberately:
// what this module owes is that every name it produces is one Unicode accepts,
// and a stubbed `isScriptName` returning `true` would assert nothing. It is
// pure, has no I/O, and is the runtime's own tables — the same category as
// `Intl` itself, which is the thing under test.

describe("deriveLanguage", () => {
  it("reads a language's own name rather than its English one", () => {
    // The label is read by the person the translation is for. A Vietnamese
    // reader finds `Tiếng Việt` faster than a word in the language they came
    // here to avoid reading.
    expect(deriveLanguage("vi")?.label).toBe("Tiếng Việt");
    expect(deriveLanguage("ja")?.label).toBe("日本語");
  });

  it("derives the script a language is written in", () => {
    expect(deriveLanguage("en")?.scripts).toEqual(["Latn"]);
    expect(deriveLanguage("ru")?.scripts).toEqual(["Cyrl"]);
    expect(deriveLanguage("ar")?.scripts).toEqual(["Arab"]);
    expect(deriveLanguage("th")?.scripts).toEqual(["Thai"]);
  });

  it("produces only script names Unicode itself accepts", () => {
    // The whole point of deriving: a name that does not compile matches nothing
    // and would silently make the language an impossible detection candidate.
    for (const code of ["en", "vi", "zh", "ja", "ko", "ru", "ar", "he", "hi", "th", "el", "ka"]) {
      for (const script of deriveLanguage(code)?.scripts ?? []) {
        expect(() => new RegExp(`\\p{Script=${script}}`, "u")).not.toThrow();
      }
    }
  });

  it("turns the composite codes CLDR answers with into real Unicode scripts", () => {
    // `Jpan`, `Kore`, `Hans` and `Hant` are ISO 15924 codes for writing systems
    // rather than scripts, and `\p{Script=}` rejects all four.
    expect(deriveLanguage("ja")?.scripts).toEqual(["Hani", "Hiragana", "Katakana"]);
    expect(deriveLanguage("ko")?.scripts).toEqual(["Hani", "Hangul"]);
    expect(deriveLanguage("zh")?.scripts).toEqual(["Hani"]);
  });

  it("gives simplified and traditional Chinese the same script", () => {
    // The distinction is real and is not one the `Script` property draws:
    // simplified and traditional characters are all Han. Telling `zh` from `ja`
    // was always the job of the two detection steps behind the script step.
    expect(deriveLanguage("zh-Hans")?.scripts).toEqual(["Hani"]);
    expect(deriveLanguage("zh-Hant")?.scripts).toEqual(["Hani"]);
  });

  it("derives a regional code from the language behind it", () => {
    const derived = deriveLanguage("pt-BR");
    expect(derived?.scripts).toEqual(["Latn"]);
    expect(derived?.label).toContain("português");
  });

  it("reads the script off the tag when the tag names one", () => {
    // `sr` is Cyrillic by default and `sr-Latn` is not, and a project
    // configuring the latter means it.
    expect(deriveLanguage("sr")?.scripts).toEqual(["Cyrl"]);
    expect(deriveLanguage("sr-Latn")?.scripts).toEqual(["Latn"]);
  });

  it("is indifferent to how a code was cased", () => {
    expect(deriveLanguage("VI")).toEqual(deriveLanguage("vi"));
    expect(deriveLanguage("zh-HANT")).toEqual(deriveLanguage("zh-Hant"));
  });

  it("refuses a tag that is not well-formed rather than throwing", () => {
    // A language list arrives from a workflow file, so malformed is ordinary
    // input. `Intl` answers these with a `RangeError`.
    for (const malformed of ["", "  ", "a", "en_US", "en--us", "vi:", "日本語", "toolongsubtag"]) {
      expect(deriveLanguage(malformed)).toBeNull();
    }
  });

  it("refuses a well-formed code CLDR has no name for", () => {
    // `DisplayNames` answers with the code itself for a code it does not know,
    // which is the absence of a label wearing the input's clothes.
    expect(deriveLanguage("xx")).toBeNull();
    expect(deriveLanguage("qqq")).toBeNull();
  });

  it("refuses a code CLDR assigns a script to but knows no name for", () => {
    // `aaa` (Ghotuo) maximizes to `Latn`, so the script half of the derivation
    // succeeds and the label half does not — `DisplayNames` answers with the
    // code itself. Deriving a "language" whose name is its own code would put
    // `aaa` in a heading a reader was supposed to find their language by.
    expect(deriveLanguage("aaa")).toBeNull();
    expect(deriveLanguage("aab")).toBeNull();
  });

  it("refuses a code CLDR knows but assigns no script to", () => {
    // `mul` is "multiple languages" and `zxx` is "no linguistic content".
    // Neither is something a thread can be written in.
    expect(deriveLanguage("mul")).toBeNull();
    expect(deriveLanguage("zxx")).toBeNull();
  });
});
