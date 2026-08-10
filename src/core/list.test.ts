import { describe, expect, it } from "vitest";

import { parseList } from "./list.js";

describe("parseList", () => {
  it("splits a one-line, comma-separated value", () => {
    expect(parseList("gpt-4o-mini, llama-3.3-70b")).toEqual(["gpt-4o-mini", "llama-3.3-70b"]);
  });

  it("splits a multi-line value", () => {
    expect(parseList("gpt-4o-mini\nllama-3.3-70b")).toEqual(["gpt-4o-mini", "llama-3.3-70b"]);
  });

  it("accepts both separators in one value", () => {
    // A workflow that started as one line and grew. Refusing the mix would be a
    // rule with nothing behind it.
    expect(parseList("a, b\nc")).toEqual(["a", "b", "c"]);
  });

  it("drops the empty entry a YAML block scalar's trailing newline leaves", () => {
    expect(parseList("en:English:Latin\nvi:Tiếng Việt:Latin\n")).toEqual([
      "en:English:Latin",
      "vi:Tiếng Việt:Latin",
    ]);
  });

  it("drops blank lines and a trailing separator", () => {
    expect(parseList("a,\n\n  \nb")).toEqual(["a", "b"]);
  });

  it("returns nothing for a value that is only whitespace and separators", () => {
    // The caller decides whether that is an error: it is for `models`, it is
    // not for `judge-models`, whose default is empty.
    expect(parseList("")).toEqual([]);
    expect(parseList("  \n , \n ")).toEqual([]);
  });

  it("keeps whitespace that is inside an entry", () => {
    // A language label is a human-readable name and may contain spaces.
    expect(parseList("  pt-BR:Português do Brasil:Latin  ")).toEqual([
      "pt-BR:Português do Brasil:Latin",
    ]);
  });
});
