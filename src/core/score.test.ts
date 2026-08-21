/**
 * The admissibility gate, which had no unit suite of its own.
 *
 * Every duty's scorer is tested against its own measurements; the machinery
 * underneath them — `refused`, `measured`, `shared`, `overlap` — was reached
 * only through those, so its own rules were pinned incidentally and in one
 * duty's terms at a time.
 *
 * This is the stage that decides what a judge is even allowed to choose
 * between, on a free endpoint where "the model returned its input unchanged"
 * and "the model rewrote a code block" are the ordinary failures rather than
 * the exotic ones. Two rules carry that weight and both are asserted here:
 *
 * - **A refusal is not a low score.** `refused` is a different answer from
 *   `measured({...zeroes})`, and a candidate that is merely bad must stay
 *   eligible while a candidate that broke a rule must not.
 * - **Agreement is symmetric.** A draft that dropped one of the source's code
 *   blocks and a draft that invented a third one are both wrong, and a
 *   measure that only looked for what the source had would score the second
 *   one perfect.
 */
import { describe, expect, it } from "vitest";

import { measured, overlap, refused, shared, type Check } from "./score.js";

function check(name: string, value: number, weight = 1): Check {
  return { name, weight, value, note: `${name} measured ${String(value)}` };
}

describe("refused", () => {
  it("marks a draft inadmissible and keeps the rule that refused it", () => {
    const score = refused("the answer was returned in the source language");

    expect(score.admissible).toBe(false);
    expect(score.reason).toBe("the answer was returned in the source language");
    expect(score.value).toBe(0);
  });

  it("carries no checks, because a refusal is not a measurement", () => {
    // A refusal that shipped half-filled checks would invite a caller to rank
    // one refusal above another, which is a comparison that means nothing:
    // both are gone, and neither is available for a judge to choose.
    expect(refused("script leak").checks).toEqual([]);
  });

  it("is a different answer from a draft that merely measured badly", () => {
    // The whole design in one assertion. A zero-scoring draft is still a draft
    // — with nothing better on the roster it is what gets published — while a
    // refused one is gone and no later stage may bring it back.
    const worst = measured([check("overlap", 0), check("length", 0)]);

    expect(worst.value).toBe(0);
    expect(worst.admissible).toBe(true);
    expect(refused("provable").admissible).toBe(false);
  });
});

describe("measured", () => {
  it("ranks on the weighted mean of what was measured", () => {
    const score = measured([check("a", 1, 3), check("b", 0, 1)]);

    expect(score.value).toBe(0.75);
    expect(score.admissible).toBe(true);
    expect(score.reason).toBeNull();
  });

  it("lets a heavier check outweigh a lighter one, which is what a weight is for", () => {
    const heavy = measured([check("a", 0, 9), check("b", 1, 1)]);
    const light = measured([check("a", 0, 1), check("b", 1, 9)]);

    expect(heavy.value).toBeLessThan(light.value);
  });

  it("keeps every check, so a run can say what a draft lost", () => {
    const checks = [check("script", 0.5), check("overlap", 0.25)];

    expect(measured(checks).checks).toEqual(checks);
  });

  it("scores a draft nobody measured as admissible rather than as a division by zero", () => {
    // A duty that measures nothing has refused nothing either, so every
    // candidate is equal and the incoming order decides. The number matters
    // less than that it is finite and identical for every candidate — a `NaN`
    // here compares false against everything and would quietly pin the winner
    // to whichever candidate the caller happened to hold first.
    const score = measured([]);

    expect(score.value).toBe(1);
    expect(score.admissible).toBe(true);
    expect(Number.isNaN(score.value)).toBe(false);
  });

  it("does the same for a set of checks that all weigh nothing", () => {
    const score = measured([check("a", 0, 0), check("b", 1, 0)]);

    expect(score.value).toBe(1);
    expect(Number.isNaN(score.value)).toBe(false);
  });
});

describe("shared", () => {
  it("counts a repeat once for each time both sides have it", () => {
    // Multiset, not set. A draft that kept one of the source's two identical
    // code fences has kept one of them, and a set-based count would call that
    // a perfect match.
    expect(shared(["a", "a"], ["a"])).toBe(1);
    expect(shared(["a", "a"], ["a", "a", "a"])).toBe(2);
    expect(shared(["a", "a", "a"], ["a", "a"])).toBe(2);
  });

  it("does not care what order either side is in", () => {
    expect(shared(["a", "b", "c"], ["c", "a", "b"])).toBe(3);
  });

  it("counts nothing in common as nothing", () => {
    expect(shared(["a"], ["b"])).toBe(0);
    expect(shared([], ["a"])).toBe(0);
    expect(shared(["a"], [])).toBe(0);
  });
});

describe("overlap", () => {
  it("is symmetric, so inventing an entry is as wrong as dropping one", () => {
    // The stated reason this is not a containment measure: a draft that
    // invented a third code block would score a perfect 1 against a measure
    // that only asked how much of the source survived.
    const dropped = overlap(["a", "b"], ["a"]);
    const invented = overlap(["a"], ["a", "b"]);

    expect(dropped).toBe(invented);
    expect(dropped).toBe(0.5);
  });

  it("scores identical multisets as complete agreement", () => {
    expect(overlap(["a", "b"], ["b", "a"])).toBe(1);
  });

  it("scores multisets with nothing in common as none", () => {
    expect(overlap(["a"], ["b"])).toBe(0);
  });

  it("scores two empty sides as agreement rather than as a division by zero", () => {
    // A body with no code blocks and a draft with no code blocks agree
    // completely, and the alternative here is `NaN` propagating into the mean.
    expect(overlap([], [])).toBe(1);
  });

  it("stays between none and complete however lopsided the two sides are", () => {
    const value = overlap(["a"], ["a", "b", "c", "d", "e"]);

    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });
});
