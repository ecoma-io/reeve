/**
 * The comment scan the screen runs over a stranger's issue body, pinned for
 * what it removes and for what it costs.
 *
 * `strip` used to remove a template's instructions with
 * `body.replace(/<!--[\s\S]*?-->/g, "\n")`, which is the shape `sanitize.ts`
 * documents having fixed for exactly this reason: an opener with no closer
 * makes the engine scan to the end of the body once per opener, so a body of
 * nothing but openers is quadratic. At the 65536 characters GitHub allows,
 * that measured 574ms here — per thread, and the screen runs on the raw body
 * of every item in a sweep before any model is asked.
 *
 * The replacement is a one-pass scan bounded by where the last closer sits.
 * Two claims travel with it and both are below: it removes exactly what the
 * regex removed, and it costs the body's length rather than its square.
 *
 * The removal cases are stated as the character count of what survives,
 * because that count is what the length rule then judges and what the
 * `too-short` note reports — the number a maintainer reads. Each was computed
 * against the regex this replaced, so the file is a comparison with the old
 * behaviour rather than a description of the new one.
 */
import { describe, expect, it } from "vitest";

import { screen } from "./screen.js";

/**
 * High enough that any surviving text is `too-short`, which is the only
 * outcome that reports its character count. The bodies below carry no link,
 * no error and no code, so nothing here reaches the evidence exemption.
 */
const ALWAYS_SHORT = 1_000_000;

/** The count of authored characters `screen` measured, from its own note. */
function authoredCount(body: string): number {
  const screened = screen({ title: "", body, minimum: ALWAYS_SHORT });
  if (screened === null) throw new Error("expected the screen to stop this body");
  if (screened.reason !== "too-short") return 0;
  const count = /^there are (\d+) characters/.exec(screened.note)?.[1];
  if (count === undefined) throw new Error(`could not read a count from: ${screened.note}`);
  return Number(count);
}

describe("removing a template's comments", () => {
  it.each([
    ["a closed comment, and the text after it", "<!-- t -->alpha", 5],
    // The two that make the difference: a comment needs a closer to be a
    // comment, so an opener without one is the literal text GitHub renders and
    // counts as the author's — in both directions of the ordering.
    ["an opener with nothing to close it", "alpha<!--beta", 13],
    ["a closer that sits before the opener", "-->alpha<!--beta", 16],
    ["an opener closed much later", "alpha<!--beta-->gamma", 11],
    ["two comments in one body", "a<!--x-->b<!--y-->c", 5],
    ["a comment carrying nothing", "<!---->x", 1],
    // The inner opener is text inside the first comment, not a comment of its
    // own: the first closer ends the first opener.
    ["an opener inside a comment", "a<!--b<!--c-->d", 3],
  ])("keeps %s", (_case, body, expected) => {
    expect(authoredCount(body)).toBe(expected);
  });

  it("reports a body that is only openers as the author's own text, not as a template", () => {
    // Nothing was removed, so nothing was scaffolding — and the whole body
    // survives as authored text rather than being counted as instructions
    // somebody else wrote.
    const body = "<!--".repeat(16);
    expect(authoredCount(body)).toBe(body.length);
  });
});

describe("what the scan costs", () => {
  // GitHub's own limit on a body, so this is the largest input the screen can
  // be handed and the worst case is reachable by typing it.
  const CAP = 65536;

  it.each([
    ["openers nothing closes", "<!--".repeat(CAP / 4)],
    ["closers nothing opened", "-->".repeat(CAP / 3)],
    ["openers before the one closer that ends them", "<!--".repeat((CAP - 3) / 4) + "-->"],
    ["a closer before openers that will never reach it", "-->" + "<!--".repeat((CAP - 3) / 4)],
    ["comments and nothing else", "<!-- x -->".repeat(CAP / 10)],
  ])("screens %s at the size limit without stalling the job", (_case, body) => {
    // A bound, not a benchmark — the same one and the same slack
    // `sanitize.integration.test.ts` uses for the identical shape. Each of
    // these runs in single-digit milliseconds; the first took 574ms when
    // finding a comment's end was a regex. Two orders of magnitude of room,
    // and it still fails that shape outright.
    const started = performance.now();
    screen({ title: "t", body, minimum: 40 });

    expect(performance.now() - started).toBeLessThan(200);
  });
});
