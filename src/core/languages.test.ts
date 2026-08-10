import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveLanguage } from "./derive.js";
import { findLanguage, parseLanguages } from "./languages.js";
import { isScriptName } from "./script.js";

// Whether `Latin` is a real Unicode script is `script.ts`'s question, answered
// against Unicode's own tables and tested there. What a bare code implies is
// `derive.ts`'s, answered against CLDR and tested there. Which separators an
// input accepts is `list.ts`'s, shared with the two model inputs and tested
// there. What this module owes is the entry: which form it is, fields,
// duplicates, and refusing one rather than carrying a half-understood language
// forward.
//
// The list stub splits on newlines only — deliberately less than the real one,
// so a test that passes here cannot be passing because the stub reimplemented
// the thing it stands in for.
vi.mock("./script.js", () => ({ isScriptName: vi.fn(() => true) }));
vi.mock("./derive.js", () => ({ deriveLanguage: vi.fn() }));
vi.mock("./list.js", () => ({
  parseList: vi.fn((raw: string) => raw.split("\n").filter((entry) => entry.trim().length > 0)),
}));

const mockedIsScriptName = vi.mocked(isScriptName);
const mockedDeriveLanguage = vi.mocked(deriveLanguage);

beforeEach(() => {
  mockedIsScriptName.mockReset();
  mockedIsScriptName.mockReturnValue(true);
  mockedDeriveLanguage.mockReset();
  mockedDeriveLanguage.mockImplementation((code) => ({
    label: `Label for ${code}`,
    scripts: ["Derived"],
  }));
});

describe("parseLanguages", () => {
  it("takes a bare code and derives what the long form would have stated", () => {
    expect(parseLanguages("vi")).toEqual([
      { code: "vi", label: "Label for vi", scripts: ["Derived"] },
    ]);
    expect(mockedDeriveLanguage).toHaveBeenCalledWith("vi");
  });

  it("parses the long form into code, label and scripts", () => {
    expect(parseLanguages("en:English:Latin\nvi:Tiếng Việt:Latin\nzh:中文:Han")).toEqual([
      { code: "en", label: "English", scripts: ["Latin"] },
      { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] },
      { code: "zh", label: "中文", scripts: ["Han"] },
    ]);
  });

  it("takes both forms in one list, so one awkward language does not spell out the rest", () => {
    expect(parseLanguages("en\nja:日本語:Han+Hiragana")).toEqual([
      { code: "en", label: "Label for en", scripts: ["Derived"] },
      { code: "ja", label: "日本語", scripts: ["Han", "Hiragana"] },
    ]);
  });

  it("lets the long form state what derivation would have answered differently", () => {
    // Not an override of a default — a consumer who knows their language better
    // than CLDR does is stating a fact this parser never asked about.
    mockedDeriveLanguage.mockReturnValue({ label: "Chinese", scripts: ["Hani"] });
    expect(parseLanguages("zh:中文:Han")).toEqual([
      { code: "zh", label: "中文", scripts: ["Han"] },
    ]);
    expect(mockedDeriveLanguage).not.toHaveBeenCalled();
  });

  it("refuses a bare code the runtime knows no name or script for, naming the way out", () => {
    mockedDeriveLanguage.mockReturnValue(null);
    expect(() => parseLanguages("xx")).toThrow(/`xx` is not a language code/);
    expect(() => parseLanguages("xx")).toThrow(/code:Label:Script/);
  });

  it("accepts several scripts for one language, joined by a plus", () => {
    const [japanese] = parseLanguages("ja:日本語:Han+Hiragana+Katakana");
    expect(japanese?.scripts).toEqual(["Han", "Hiragana", "Katakana"]);
  });

  it("trims whitespace around each field and around each script", () => {
    expect(parseLanguages("  en : English : Latin \nja:日本語: Han + Hiragana ")).toEqual([
      { code: "en", label: "English", scripts: ["Latin"] },
      { code: "ja", label: "日本語", scripts: ["Han", "Hiragana"] },
    ]);
  });

  it("preserves the code exactly as configured", () => {
    // It is echoed in the `source-language` output and in the published block.
    // A consumer who wrote `pt-BR` should not be handed back `pt-br`.
    const [regional] = parseLanguages("pt-BR:Português do Brasil:Latin");
    expect(regional?.code).toBe("pt-BR");
  });

  it("preserves a bare code exactly as configured too", () => {
    expect(parseLanguages("pt-BR")[0]?.code).toBe("pt-BR");
  });

  it("refuses an entry that is not three colon-separated fields", () => {
    expect(() => parseLanguages("en:English")).toThrow(/2 colon-separated fields/);
    expect(() => parseLanguages("en:English:Latin:extra")).toThrow(/4 colon-separated fields/);
  });

  it("refuses an empty code or an empty label", () => {
    expect(() => parseLanguages(":English:Latin")).toThrow(/empty code/);
    expect(() => parseLanguages("en::Latin")).toThrow(/empty label/);
  });

  it("refuses an entry naming no script", () => {
    expect(() => parseLanguages("en:English:")).toThrow(/names no script/);
    expect(() => parseLanguages("en:English:+")).toThrow(/names no script/);
  });

  it("refuses a duplicate code however it is cased, naming both spellings", () => {
    // Two entries for one language would translate the same thread twice and
    // publish both, and the second would silently win every lookup.
    expect(() => parseLanguages("en:English:Latin\nEN:Englisch:Latin")).toThrow(
      /`EN` is listed twice/,
    );
    expect(() => parseLanguages("en:English:Latin\nEN:Englisch:Latin")).toThrow(
      /already seen as `en`/,
    );
  });

  it("catches a duplicate written once bare and once spelled out", () => {
    // The likeliest way to write one by accident, and the one a check on the
    // raw entry rather than the parsed code would miss.
    expect(() => parseLanguages("en\nen:English:Latin")).toThrow(/`en` is listed twice/);
  });

  it("refuses a script the script module does not recognise, quoting it back", () => {
    mockedIsScriptName.mockImplementation((script) => script !== "Japanese");
    expect(() => parseLanguages("ja:日本語:Japanese")).toThrow(
      /names `Japanese`, which is not a Unicode script/,
    );
  });

  it("checks every script of a multi-script entry, not only the first", () => {
    mockedIsScriptName.mockImplementation((script) => script !== "Katakana");
    expect(() => parseLanguages("ja:日本語:Han+Hiragana+Katakana")).toThrow(/names `Katakana`/);
  });

  it("refuses an empty list rather than treating it as no languages to translate", () => {
    expect(() => parseLanguages("")).toThrow(/no entries/);
    expect(() => parseLanguages("   \n\n  ")).toThrow(/no entries/);
  });
});

describe("findLanguage", () => {
  const languages = parseLanguages("en:English:Latin\npt-BR:Português do Brasil:Latin");

  it("finds a language by its code", () => {
    expect(findLanguage(languages, "en")?.label).toBe("English");
  });

  it("finds a language whatever the case of the code it is given", () => {
    // The code being matched often comes from a model, which is not obliged to
    // echo the spelling it was shown.
    expect(findLanguage(languages, "PT-br")?.code).toBe("pt-BR");
  });

  it("returns undefined for a code that is not configured", () => {
    expect(findLanguage(languages, "de")).toBeUndefined();
  });
});
