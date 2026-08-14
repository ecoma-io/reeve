/**
 * Tests for the dependa semver module.
 *
 * Every function in semver.ts is pure — same inputs, same outputs.
 * These tests verify the classification, comparison, constraint satisfaction,
 * and utility functions that gate enforcement decisions.
 */
import { describe, expect, it } from "vitest";

import {
  classify,
  compare,
  distance,
  eq,
  gt,
  highestSatisfying,
  isSha,
  lt,
  parse,
  satisfies,
  type Semver,
} from "./semver.js";

// ── parse ────────────────────────────────────────────────────────────────

describe("parse", () => {
  it("parses a full semver", () => {
    expect(parse("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it("parses major.minor (patch defaults to 0)", () => {
    expect(parse("2.1")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: null });
  });

  it("parses major only (minor and patch default to 0)", () => {
    expect(parse("5")).toEqual({ major: 5, minor: 0, patch: 0, prerelease: null });
  });

  it("parses with v prefix", () => {
    expect(parse("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it("parses pre-release identifier", () => {
    expect(parse("1.2.3-beta.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "beta.1",
    });
  });

  it("parses pre-release with + build metadata (ignores build)", () => {
    expect(parse("1.2.3-beta.1+build")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "beta.1+build",
    });
  });

  it("returns null for non-version strings", () => {
    expect(parse("latest")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("x")).toBeNull();
  });

  it("returns null for strings that start with a letter", () => {
    expect(parse("abc")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parse("  1.2.3  ")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it("handles zero versions", () => {
    expect(parse("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0, prerelease: null });
    expect(parse("0.0.1")).toEqual({ major: 0, minor: 0, patch: 1, prerelease: null });
    expect(parse("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: null });
  });
});

// ── compare ──────────────────────────────────────────────────────────────

describe("compare", () => {
  it("orders by major version", () => {
    expect(
      compare(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 2, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(-1);
    expect(
      compare(
        { major: 2, minor: 0, patch: 0, prerelease: null },
        { major: 1, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(1);
  });

  it("orders by minor when major is equal", () => {
    expect(
      compare(
        { major: 1, minor: 1, patch: 0, prerelease: null },
        { major: 1, minor: 2, patch: 0, prerelease: null },
      ),
    ).toBe(-1);
  });

  it("orders by patch when major.minor are equal", () => {
    expect(
      compare(
        { major: 1, minor: 2, patch: 1, prerelease: null },
        { major: 1, minor: 2, patch: 3, prerelease: null },
      ),
    ).toBe(-1);
  });

  it("returns 0 for equal versions", () => {
    expect(
      compare(
        { major: 1, minor: 2, patch: 3, prerelease: null },
        { major: 1, minor: 2, patch: 3, prerelease: null },
      ),
    ).toBe(0);
  });

  it("pre-release is lower than release", () => {
    const release: Semver = { major: 1, minor: 2, patch: 3, prerelease: null };
    const pre: Semver = { major: 1, minor: 2, patch: 3, prerelease: "beta.1" };
    expect(compare(pre, release)).toBe(-1);
    expect(compare(release, pre)).toBe(1);
  });

  it("compares pre-release identifiers lexicographically", () => {
    const alpha: Semver = { major: 1, minor: 0, patch: 0, prerelease: "alpha" };
    const beta: Semver = { major: 1, minor: 0, patch: 0, prerelease: "beta" };
    expect(compare(alpha, beta)).toBe(-1);
    expect(compare(beta, alpha)).toBe(1);
  });

  it("equal pre-release identifiers compare as equal", () => {
    const a: Semver = { major: 1, minor: 0, patch: 0, prerelease: "rc.1" };
    const b: Semver = { major: 1, minor: 0, patch: 0, prerelease: "rc.1" };
    expect(compare(a, b)).toBe(0);
  });
});

// ── gt / lt / eq ─────────────────────────────────────────────────────────

describe("gt", () => {
  it("true when version is greater", () => {
    expect(
      gt(
        { major: 2, minor: 0, patch: 0, prerelease: null },
        { major: 1, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(true);
  });

  it("false when version is equal", () => {
    expect(
      gt(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 1, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(false);
  });

  it("false when version is less", () => {
    expect(
      gt(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 2, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(false);
  });
});

describe("lt", () => {
  it("true when version is less", () => {
    expect(
      lt(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 2, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(true);
  });

  it("false when equal", () => {
    expect(
      lt(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 1, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(false);
  });
});

describe("eq", () => {
  it("true when equal", () => {
    expect(
      eq(
        { major: 1, minor: 2, patch: 3, prerelease: null },
        { major: 1, minor: 2, patch: 3, prerelease: null },
      ),
    ).toBe(true);
  });

  it("false when different", () => {
    expect(
      eq(
        { major: 1, minor: 2, patch: 3, prerelease: null },
        { major: 1, minor: 2, patch: 4, prerelease: null },
      ),
    ).toBe(false);
  });
});

// ── classify ─────────────────────────────────────────────────────────────

describe("classify", () => {
  it("classifies major update", () => {
    expect(classify("1.2.3", "2.0.0", false)).toBe("major");
  });

  it("classifies minor update", () => {
    expect(classify("1.2.3", "1.3.0", false)).toBe("minor");
  });

  it("classifies patch update", () => {
    expect(classify("1.2.3", "1.2.4", false)).toBe("patch");
  });

  it("classifies rollback when target is older", () => {
    expect(classify("2.0.0", "1.0.0", false)).toBe("rollback");
  });

  it("returns null when versions are equal", () => {
    expect(classify("1.2.3", "1.2.3", false)).toBeNull();
  });

  it("returns security when isSecurity is true regardless of version change", () => {
    expect(classify("1.2.3", "1.2.4", true)).toBe("security");
  });

  it("returns null when current cannot be parsed", () => {
    expect(classify("latest", "1.2.3", false)).toBeNull();
  });

  it("returns null when target cannot be parsed", () => {
    expect(classify("1.2.3", "xyz", false)).toBeNull();
  });

  it("classifies major bump from 0.x to 1.x as major", () => {
    expect(classify("0.9.0", "1.0.0", false)).toBe("major");
  });

  it("classifies minor bump within 0.x as minor", () => {
    expect(classify("0.1.0", "0.2.0", false)).toBe("minor");
  });

  it("classifies patch-only bump as patch", () => {
    expect(classify("1.0.0", "1.0.1", false)).toBe("patch");
  });

  it("major takes priority over minor distance", () => {
    // 1.2.3 → 2.1.0 is major (2 > 1), not minor
    expect(classify("1.2.3", "2.1.0", false)).toBe("major");
  });
});

// ── satisfies ────────────────────────────────────────────────────────────

describe("satisfies", () => {
  it("exact version: matches exactly", () => {
    const v = parse("1.2.3")!;
    expect(satisfies(v, "1.2.3")).toBe(true);
    expect(satisfies(v, "1.2.4")).toBe(false);
  });

  it("caret range: ^1.2.3 matches within major", () => {
    const v = parse("1.5.0")!;
    expect(satisfies(v, "^1.2.3")).toBe(true);
  });

  it("caret range: ^1.2.3 rejects next major", () => {
    const v = parse("2.0.0")!;
    expect(satisfies(v, "^1.2.3")).toBe(false);
  });

  it("caret range: ^0.2.3 locks minor when major is 0", () => {
    const v030 = parse("0.3.0")!;
    const v024 = parse("0.2.4")!;
    expect(satisfies(v030, "^0.2.3")).toBe(false);
    expect(satisfies(v024, "^0.2.3")).toBe(true);
  });

  it("tilde range: ~1.2.3 matches within minor", () => {
    const v = parse("1.2.9")!;
    expect(satisfies(v, "~1.2.3")).toBe(true);
  });

  it("tilde range: ~1.2.3 rejects next minor", () => {
    const v = parse("1.3.0")!;
    expect(satisfies(v, "~1.2.3")).toBe(false);
  });

  it("GTE: >=1.2.3 matches equal and above", () => {
    const v = parse("1.2.3")!;
    expect(satisfies(v, ">=1.2.3")).toBe(true);
    const vHigher = parse("2.0.0")!;
    expect(satisfies(vHigher, ">=1.2.3")).toBe(true);
  });

  it("GTE: >=1.2.3 rejects below", () => {
    const v = parse("1.2.2")!;
    expect(satisfies(v, ">=1.2.3")).toBe(false);
  });

  it("GT: >1.2.3 rejects equal", () => {
    const v = parse("1.2.3")!;
    expect(satisfies(v, ">1.2.3")).toBe(false);
  });

  it("GT: >1.2.3 accepts above", () => {
    const v = parse("1.2.4")!;
    expect(satisfies(v, ">1.2.3")).toBe(true);
  });

  it("LTE: <=1.2.3 matches equal and below", () => {
    const v = parse("1.2.3")!;
    expect(satisfies(v, "<=1.2.3")).toBe(true);
    const vLower = parse("1.2.2")!;
    expect(satisfies(vLower, "<=1.2.3")).toBe(true);
  });

  it("LT: <1.2.3 rejects equal", () => {
    const v = parse("1.2.3")!;
    expect(satisfies(v, "<1.2.3")).toBe(false);
  });

  it("space-separated range: both conditions must hold", () => {
    const v = parse("1.5.0")!;
    expect(satisfies(v, ">=1.2.3 <2.0.0")).toBe(true);
  });

  it("space-separated range: fails when outside ceiling", () => {
    const v = parse("2.0.0")!;
    expect(satisfies(v, ">=1.2.3 <2.0.0")).toBe(false);
  });

  it("returns null for unparseable constraint", () => {
    const v = parse("1.2.3")!;
    expect(satisfies(v, "xyz")).toBeNull();
  });
});

// ── highestSatisfying ────────────────────────────────────────────────────

describe("highestSatisfying", () => {
  it("picks the highest version that satisfies the constraint", () => {
    const releases = ["2.0.0", "1.5.0", "1.2.3", "1.0.0"];
    expect(highestSatisfying(releases, "^1.0.0")).toBe("1.5.0");
  });

  it("returns null when no version satisfies", () => {
    const releases = ["2.0.0", "3.0.0"];
    expect(highestSatisfying(releases, "^1.0.0")).toBeNull();
  });

  it("when constraint is null, returns first non-prerelease release", () => {
    const releases = ["3.0.0-beta.1", "2.0.0", "1.0.0"];
    expect(highestSatisfying(releases, null)).toBe("2.0.0");
  });

  it("when constraint is null and all are prerelease, returns first", () => {
    const releases = ["2.0.0-beta.1", "1.0.0-alpha.1"];
    expect(highestSatisfying(releases, null)).toBe("2.0.0-beta.1");
  });

  it("skips prereleases unless the constraint explicitly includes them", () => {
    const releases = ["2.0.0-beta.1", "1.5.0", "1.0.0"];
    expect(highestSatisfying(releases, "^1.0.0")).toBe("1.5.0");
  });

  it("includes prereleases when constraint contains a hyphen", () => {
    const releases = ["2.0.0-beta.1", "1.5.0", "1.0.0"];
    // A constraint like "2.0.0-beta.1" explicitly references a prerelease
    expect(highestSatisfying(releases, "2.0.0-beta.1")).toBe("2.0.0-beta.1");
  });

  it("returns null for empty releases", () => {
    expect(highestSatisfying([], "^1.0.0")).toBeNull();
    expect(highestSatisfying([], null)).toBeNull();
  });

  it("returns null when all versions fail to parse", () => {
    expect(highestSatisfying(["latest", "next"], "^1.0.0")).toBeNull();
  });
});

// ── distance ─────────────────────────────────────────────────────────────

describe("distance", () => {
  it("computes distance between versions", () => {
    expect(distance("1.2.3", "2.5.7")).toEqual({ major: 1, minor: 3, patch: 4 });
  });

  it("zero distance when equal", () => {
    expect(distance("1.2.3", "1.2.3")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it("returns null for unparseable versions", () => {
    expect(distance("latest", "1.2.3")).toBeNull();
    expect(distance("1.2.3", "next")).toBeNull();
  });
});

// ── isSha ────────────────────────────────────────────────────────────────

describe("isSha", () => {
  it("recognises 40-char SHA", () => {
    expect(isSha("a81bbbf8298c0fa03ea29cdc473d45769f953675")).toBe(true);
  });

  it("recognises short SHA (7+ chars)", () => {
    expect(isSha("a81bbbf")).toBe(true);
  });

  it("recognises SHA with uppercase", () => {
    expect(isSha("A81BBBF")).toBe(true);
  });

  it("rejects version strings", () => {
    expect(isSha("v1.2.3")).toBe(false);
    expect(isSha("1.2.3")).toBe(false);
  });

  it("rejects too-short hex strings (<7 chars)", () => {
    expect(isSha("abc123")).toBe(false);
  });

  it("rejects non-hex strings", () => {
    expect(isSha("ghijklmnop")).toBe(false);
  });
});
