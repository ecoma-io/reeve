import { describe, expect, it } from "vitest";
import {
  CHROME_KEYS,
  CHROME_LANGUAGES,
  chrome,
  chromeFallbackNote,
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

  it("carries exactly the languages this file commits rows for", () => {
    // Pins the language set itself — adding a language is a real
    // change to this file and should show up as a diff to this assertion,
    // not slip in silently.
    expect(CHROME_LANGUAGES).toEqual([
      "en",
      "ar",
      "cs",
      "de",
      "es",
      "fr",
      "hi",
      "id",
      "it",
      "ja",
      "ko",
      "nl",
      "pl",
      "pt",
      "ru",
      "sv",
      "th",
      "tr",
      "uk",
      "vi",
      "zh",
    ]);
  });
});

describe("chrome — fallback", () => {
  it("falls back to English for a code with no row", () => {
    for (const key of KEYS) {
      expect(chrome(key, "la", ALL_PARAMS)).toBe(chrome(key, "en", ALL_PARAMS));
    }
  });

  it("falls back to English for a null code", () => {
    for (const key of KEYS) {
      expect(chrome(key, null, ALL_PARAMS)).toBe(chrome(key, "en", ALL_PARAMS));
    }
  });

  it("reports chromeSupports true for supported languages and false for unsupported", () => {
    expect(chromeSupports("vi")).toBe(true);
    expect(chromeSupports("zh")).toBe(true);
    expect(chromeSupports("fr")).toBe(true);
    expect(chromeSupports("ja")).toBe(true);
    expect(chromeSupports("la")).toBe(false);
    expect(chromeSupports(null)).toBe(false);
  });

  it("renders a distinct string from English for every non-English language, for every key with translatable words", () => {
    for (const key of KEYS) {
      for (const language of CHROME_LANGUAGES) {
        if (language === "en") continue;
        expect(chrome(key, language, ALL_PARAMS)).not.toBe(chrome(key, "en", ALL_PARAMS));
      }
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
    const note = chromeFallbackNote(["la", "en", "la"]);
    expect(note).toContain("`la`");
    expect(note?.match(/`la`/g)).toHaveLength(1);
  });

  it("names every distinct unsupported code, sorted, in one sentence", () => {
    const note = chromeFallbackNote(["la", "eo"]);
    expect(note).toContain("`eo`, `la`");
  });

  it("says which languages this table does carry", () => {
    const note = chromeFallbackNote(["la"]);
    expect(note).toContain(
      "Chrome covers: en, ar, cs, de, es, fr, hi, id, it, ja, ko, nl, pl, pt, ru, sv, th, tr, uk, vi, zh.",
    );
  });
});
