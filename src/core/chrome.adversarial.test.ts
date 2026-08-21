/**
 * The chrome table against the one thing a caller passes into it: a value.
 *
 * A chrome string is published into a public thread, and one of its
 * placeholders is filled with a label name — the warrant's, or a track's
 * configured clock-hand. That value is the only part of the sentence not
 * written in this file, so it is the only part worth attacking: what happens
 * when it is spelled to be read as something other than a value?
 *
 * Two answers, both properties of filling with a replacer function rather
 * than a replacement string, and neither obvious enough to leave unpinned.
 */
import { describe, expect, it } from "vitest";

import { chrome } from "./chrome.js";

describe("a placeholder value is inserted, never interpreted", () => {
  it.each([
    ["the whole match", "$&"],
    ["everything before the match", "$`"],
    ["everything after the match", "$'"],
    ["a capture group", "$1"],
    ["an escaped dollar", "$$"],
    ["all of them at once", "$$$&$1$'"],
  ])("inserts a value spelled as %s literally", (_case, value) => {
    // `String.replace` expands every one of these when the replacement is a
    // string. The moment this is filled with a template literal instead of a
    // function, a label named `$&` publishes the placeholder back into the
    // sentence — and `$\`` publishes the half of the sentence in front of it.
    const rendered = chrome("lifecycleFooterWhenLabel", "en", { label: value });

    expect(rendered).toContain(value);
    expect(rendered).not.toContain("{label}");
  });

  it("does not fill a placeholder a value happens to spell", () => {
    // One pass, left to right: what a value contains is never rescanned, so a
    // label named `{label}` cannot make the sentence quote itself and a label
    // named after a placeholder no caller filled cannot throw the run.
    const rendered = chrome("lifecycleFooterWhenLabel", "en", { label: "{label}" });

    expect(rendered).toContain("{label}");
    expect(() => chrome("lifecycleFooterWhenLabel", "en", { label: "{unfilled}" })).not.toThrow();
  });

  it("throws rather than publishing a placeholder no caller filled", () => {
    // The other direction of the same rule: a missing param is a bug in this
    // repository, and the loud failure is the one that never reaches a public
    // thread as a literal `{label}`.
    expect(() => chrome("lifecycleFooterWhenLabel", "en", {})).toThrow(/no "label" in params/);
  });
});

describe("a language code chooses a row and can never be one", () => {
  /**
   * The English row, spelled out rather than fetched.
   *
   * Comparing a hostile code's rendering against another `chrome` call would
   * be satisfied by a `chrome` that answered `""` to everything — the two
   * sides would agree and say nothing. The sentence is pinned once here so
   * the fallback has something outside the function to be equal to.
   */
  const ENGLISH = "Removing the `stale` label also stops this track.";

  it("renders that sentence for the language it is written in", () => {
    expect(chrome("lifecycleFooterWhenLabel", "en", { label: "stale" })).toBe(ENGLISH);
  });

  it.each([
    ["a code that is not a language", "'; drop table --"],
    ["a code carrying markup", "<script>alert(1)</script>"],
    ["a code that is a chrome key", "lifecycleFooterWhenLabel"],
    ["an empty code", ""],
    ["a code with a newline", "en\nvi"],
  ])("renders the English row for %s rather than anything it says", (_case, code) => {
    const rendered = chrome("lifecycleFooterWhenLabel", code, { label: "stale" });

    expect(rendered).toBe(ENGLISH);
  });

  it("never echoes the code it was handed into the sentence it publishes", () => {
    // The code selects a row. It is not content, and a comment published into
    // a public thread must never carry it back out.
    const rendered = chrome("lifecycleFooterWhenLabel", "<script>alert(1)</script>", {
      label: "stale",
    });

    expect(rendered).not.toContain("script");
  });
});
