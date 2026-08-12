import { describe, expect, it } from "vitest";
import {
  CHROME_LANGUAGES,
  chrome,
  chromeFallbackNote,
  chromeLines,
  chromeSupports,
  type ChromeKey,
} from "./chrome.js";

// The table itself is not exported — reach every key through `chrome()` with
// each configured language, which is exactly what a completeness test needs
// and does not require poking at module internals to get.
const KEYS: readonly ChromeKey[] = [
  "translateBoundary",
  "translateFooterFrom",
  "translateFooterTruncated",
  "translateFooterSkipped",
  "translateFooterEditable",
  "lifecycleFooterResetsAuthor",
  "lifecycleFooterResetsAny",
  "lifecycleFooterWhenLabel",
  "lifecycleFooterEscape",
  "lifecycleFooterAttribution",
  "respondBoundaryDrafted",
  "respondBoundaryCaveat",
  "respondFooterUnknown",
  "respondFooterKnown",
  "respondFooterRecord",
  "duplicatePossible",
  "duplicateFooterFloor",
  "duplicateFooterEditable",
];

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

  it("carries exactly the two languages this pull request commits", () => {
    // Pins the language set itself — adding a third language is a real
    // change to this file and should show up as a diff to this assertion,
    // not slip in silently.
    expect(CHROME_LANGUAGES).toEqual(["en", "vi"]);
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

  it("reports chromeSupports(vi) true and chromeSupports(fr) false", () => {
    expect(chromeSupports("vi")).toBe(true);
    expect(chromeSupports("fr")).toBe(false);
    expect(chromeSupports(null)).toBe(false);
  });

  it("renders a distinct string for vi than for en, for every key that has translatable words", () => {
    for (const key of KEYS) {
      expect(chrome(key, "vi", ALL_PARAMS)).not.toBe(chrome(key, "en", ALL_PARAMS));
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
    expect(chromeFallbackNote(["fr"])).toContain("Configured: en, vi.");
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
