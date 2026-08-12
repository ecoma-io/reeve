import { describe, expect, it } from "vitest";
import {
  CHROME_KEYS,
  CHROME_LANGUAGES,
  chrome,
  chromeFallbackNote,
  chromeLines,
  chromeSupports,
} from "./chrome.js";

// Read straight off the table's own export rather than a hand-maintained
// list here — a key added to `CHROME` without a row for every language would
// otherwise ship silently if this list forgot to grow with it.
const KEYS = CHROME_KEYS;

// Every placeholder any key uses, so a completeness pass can fill whichever
// ones a given key needs without maintaining a second parallel key->params map.
const ALL_PARAMS: Readonly<Record<string, string>> = {
  label: "Tiếng Việt",
  list: "one item, another item",
  number: "42",
};

describe("chrome — completeness", () => {
  it("has a non-empty row for every key, in every configured language", () => {
    for (const key of KEYS) {
      for (const language of CHROME_LANGUAGES) {
        const rendered = chrome(key, language, ALL_PARAMS);
        expect(rendered.length).toBeGreaterThan(0);
      }
    }
  });

  it("carries exactly the three languages this file commits rows for", () => {
    // Pins the language set itself — adding a fourth language is a real
    // change to this file and should show up as a diff to this assertion,
    // not slip in silently.
    expect(CHROME_LANGUAGES).toEqual(["en", "vi", "zh"]);
  });
});

describe("chrome — fallback", () => {
  it("falls back to English for a code with no row", () => {
    for (const key of KEYS) {
      expect(chrome(key, "fr", ALL_PARAMS)).toBe(chrome(key, "en", ALL_PARAMS));
    }
  });

  it("falls back to English for a null code", () => {
    for (const key of KEYS) {
      expect(chrome(key, null, ALL_PARAMS)).toBe(chrome(key, "en", ALL_PARAMS));
    }
  });

  it("reports chromeSupports(vi) and chromeSupports(zh) true, chromeSupports(fr) false", () => {
    expect(chromeSupports("vi")).toBe(true);
    expect(chromeSupports("zh")).toBe(true);
    expect(chromeSupports("fr")).toBe(false);
    expect(chromeSupports(null)).toBe(false);
  });

  it("renders a distinct string for vi and for zh than for en, for every key with translatable words", () => {
    for (const key of KEYS) {
      expect(chrome(key, "vi", ALL_PARAMS)).not.toBe(chrome(key, "en", ALL_PARAMS));
      expect(chrome(key, "zh", ALL_PARAMS)).not.toBe(chrome(key, "en", ALL_PARAMS));
    }
  });
});

describe("chrome — interpolation", () => {
  it("throws on a template with an unfilled placeholder rather than publishing it literally", () => {
    expect(() => chrome("translateFooterFrom", "en", {})).toThrow(/label/);
  });

  it("substitutes every placeholder a template declares", () => {
    expect(chrome("translateFooterFrom", "en", { label: "Español" })).toBe(
      "Translated from Español.",
    );
    expect(chrome("duplicatePossible", "en", { number: "7" })).toBe("Possible duplicate of #7.");
  });

  it("leaves a key with no placeholders unaffected by an empty params object", () => {
    expect(chrome("respondFooterRecord", "en")).toBe(
      "Reeve answers a thread once. This comment is the record of it.",
    );
  });
});

describe("chromeFallbackNote", () => {
  it("is null when every code has its own row", () => {
    expect(chromeFallbackNote(["en", "vi", "en"])).toBeNull();
  });

  it("is null when every code is null", () => {
    expect(chromeFallbackNote([null, null])).toBeNull();
  });

  it("is null for an empty list", () => {
    expect(chromeFallbackNote([])).toBeNull();
  });

  it("names one unsupported code once, even seen twice", () => {
    const note = chromeFallbackNote(["fr", "en", "fr"]);
    expect(note).toContain("`fr`");
    expect(note?.match(/`fr`/g)).toHaveLength(1);
  });

  it("names every distinct unsupported code, sorted, in one sentence", () => {
    const note = chromeFallbackNote(["ja", "de"]);
    expect(note).toContain("`de`, `ja`");
  });

  it("says which languages this table does carry", () => {
    expect(chromeFallbackNote(["fr"])).toContain("Chrome covers: en, vi, zh.");
  });
});

describe("chromeLines", () => {
  it("renders English first when multiple languages are present, deduplicated", () => {
    const lines = chromeLines("translateBoundary", ["vi", "en", "vi", "en"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(chrome("translateBoundary", "en"));
    expect(lines[1]).toBe(chrome("translateBoundary", "vi"));
  });

  it("renders a single line when only one language is present", () => {
    const lines = chromeLines("translateBoundary", ["vi"]);
    expect(lines).toEqual([chrome("translateBoundary", "vi")]);
  });

  it("collapses unsupported languages into a single English line, not one per unsupported code", () => {
    const lines = chromeLines("translateBoundary", ["fr", "de", "ja"]);
    expect(lines).toEqual([chrome("translateBoundary", "en")]);
  });

  it("falls back to a single English line for an empty language list", () => {
    const lines = chromeLines("translateBoundary", []);
    expect(lines).toEqual([chrome("translateBoundary", "en")]);
  });

  it("passes params through to every rendered line", () => {
    const lines = chromeLines("translateFooterFrom", ["en", "vi"], { label: "Deutsch" });
    expect(lines).toEqual(["Translated from Deutsch.", "Được dịch từ Deutsch."]);
  });
});
