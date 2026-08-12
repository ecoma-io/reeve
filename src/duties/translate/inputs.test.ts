import { describe, expect, it } from "vitest";

import type { Language } from "../../core/languages.js";

import { parseChunkChars, readBody, targets } from "./inputs.js";
import { marker } from "./publish.js";

const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const chinese: Language = { code: "zh", label: "中文", scripts: ["Han"] };

describe("readBody", () => {
  it("returns the whole body as the source when there is no limit", () => {
    const result = readBody("hello world", null);
    expect(result).toEqual({
      official: "hello world",
      source: "hello world",
      truncated: false,
      published: null,
    });
  });

  it("truncates the source to the limit and says so", () => {
    const result = readBody("hello world", 5);
    expect(result).toEqual({
      official: "hello world",
      source: "hello",
      truncated: true,
      published: null,
    });
  });

  it("is not truncated when the body is already within the limit", () => {
    const result = readBody("hi", 5);
    expect(result.truncated).toBe(false);
  });

  it("splits the author's half from an already-published block, and reads its fingerprint", () => {
    const body = `hello world\n${marker.render("abc123")}`;
    const result = readBody(body, null);
    expect(result.official).toBe("hello world");
    expect(result.published).toBe("abc123");
  });
});

describe("targets", () => {
  const languages = [english, vietnamese, chinese];

  it("returns every configured language when the source is unrecognised", () => {
    expect(targets(languages, null)).toEqual(languages);
  });

  it("drops the source language, case-insensitively", () => {
    expect(targets(languages, { ...english, code: "EN" })).toEqual([vietnamese, chinese]);
  });
});

describe("parseChunkChars", () => {
  it("accepts a whole number at or above the floor", () => {
    expect(parseChunkChars("500")).toBe(500);
    expect(parseChunkChars("6000")).toBe(6000);
  });

  it("refuses below the floor", () => {
    expect(() => parseChunkChars("499")).toThrow(/chunk-chars/);
  });

  it("refuses a non-integer", () => {
    expect(() => parseChunkChars("500.5")).toThrow(/chunk-chars/);
  });

  it("refuses an empty value", () => {
    expect(() => parseChunkChars("")).toThrow(/chunk-chars/);
  });
});
