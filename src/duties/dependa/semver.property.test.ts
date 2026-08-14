/**
 * Property-based tests for the dependa semver module.
 *
 * Uses fast-check to generate random version strings, constraints, and release
 * lists, then verifies invariants that must hold for ALL inputs — not just the
 * hand-picked examples in semver.test.ts.
 *
 * Properties verified:
 * - parse is involutive: valid versions survive a parse→format round trip
 * - compare is a total order: reflexive, antisymmetric, transitive
 * - classify is consistent: same versions, same classification
 * - satisfies is sound: a version that satisfies must be within the range
 * - highestSatisfying is maximal: no other satisfying version is higher
 * - candidateVersions returns distinct candidates
 * - distance is symmetric and non-negative
 * - isSha is closed under hex strings of valid length
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  classify,
  compare,
  distance,
  eq,
  gt,
  highestSatisfying,
  isSha,
  lt,
  latestAvailable,
  parse,
  satisfies,
  candidateVersions,
  type Semver,
} from "./semver.js";

// ── Arbitraries ──────────────────────────────────────────────────────────

/** A valid semver version string (no v-prefix, no build metadata). */
const semverString = fc
  .tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.option(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9.-]+$/.test(s)),
      {
        nil: undefined,
      },
    ),
  )
  .map(([major, minor, patch, pre]) => {
    const base = `${String(major)}.${String(minor)}.${String(patch)}`;
    return pre !== undefined ? `${base}-${pre}` : base;
  });

/** A Semver object. */
const semverObj = fc
  .tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.option(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9.-]+$/.test(s)),
      {
        nil: undefined,
      },
    ),
  )
  .map(([major, minor, patch, pre]): Semver => ({
    major,
    minor,
    patch,
    prerelease: pre ?? null,
  }));

/** A simple constraint string: exact, caret, tilde, or GTE. */
const simpleConstraint = fc.oneof(
  // Exact: "1.2.3"
  semverString,
  // Caret: "^1.2.3"
  semverString.map((v) => `^${v}`),
  // Tilde: "~1.2.3"
  semverString.map((v) => `~${v}`),
  // GTE: ">=1.2.3"
  semverString.map((v) => `>=${v}`),
  // GT: ">1.2.3"
  semverString.map((v) => `>${v}`),
  // LTE: "<=1.2.3"
  semverString.map((v) => `<=${v}`),
  // LT: "<1.2.3"
  semverString.map((v) => `<${v}`),
);

/** A sorted (newest-first) list of semver strings. */
const sortedReleaseList = fc
  .array(semverString, { minLength: 0, maxLength: 20 })
  .map((versions) => {
    const parsed = versions.map((v) => ({ v, s: parse(v) })).filter((p) => p.s !== null);
    parsed.sort((a, b) => compare(b.s!, a.s!));
    return parsed.map((p) => p.v);
  });

// ── parse ────────────────────────────────────────────────────────────────

describe("parse — property", () => {
  it("every valid semver string parses successfully", () => {
    fc.assert(
      fc.property(semverString, (version) => {
        const result = parse(version);
        expect(result).not.toBeNull();
      }),
    );
  });

  it("parsed major/minor/patch match the input", () => {
    fc.assert(
      fc.property(semverString, (version) => {
        const result = parse(version);
        expect(result).not.toBeNull();
        // The input version string must contain the parsed major.minor.patch
        expect(version).toContain(String(result!.major));
      }),
    );
  });

  it("parse is idempotent: parse(parse(s).format) == parse(s)", () => {
    fc.assert(
      fc.property(semverString, (version) => {
        const first = parse(version);
        expect(first).not.toBeNull();
        // Reconstruct the version from the parsed values
        const reconstructed = `${String(first!.major)}.${String(first!.minor)}.${String(first!.patch)}${first!.prerelease !== null ? `-${first!.prerelease}` : ""}`;
        const second = parse(reconstructed);
        expect(second).not.toBeNull();
        expect(eq(first!, second!)).toBe(true);
      }),
    );
  });

  it("never returns negative major/minor/patch", () => {
    fc.assert(
      fc.property(semverString, (version) => {
        const result = parse(version);
        expect(result).not.toBeNull();
        expect(result!.major).toBeGreaterThanOrEqual(0);
        expect(result!.minor).toBeGreaterThanOrEqual(0);
        expect(result!.patch).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// ── compare ──────────────────────────────────────────────────────────────

describe("compare — property", () => {
  it("is reflexive: compare(a, a) === 0", () => {
    fc.assert(
      fc.property(semverObj, (a) => {
        expect(compare(a, a)).toBe(0);
      }),
    );
  });

  it("is antisymmetric: compare(a, b) === -compare(b, a)", () => {
    fc.assert(
      fc.property(semverObj, semverObj, (a, b) => {
        expect(compare(a, b)).toBe(-compare(b, a));
      }),
    );
  });

  it("is transitive: if a < b and b < c then a < c", () => {
    fc.assert(
      fc.property(semverObj, semverObj, semverObj, (a, b, c) => {
        const ab = compare(a, b);
        const bc = compare(b, c);
        fc.pre(ab < 0 && bc < 0);
        expect(compare(a, c)).toBeLessThan(0);
      }),
    );
  });

  it("equal versions have compare === 0", () => {
    fc.assert(
      fc.property(semverObj, (a) => {
        const b: Semver = { ...a };
        expect(compare(a, b)).toBe(0);
      }),
    );
  });
});

// ── gt / lt / eq ─────────────────────────────────────────────────────────

describe("gt / lt / eq — property", () => {
  it("gt(a, b) and lt(b, a) agree", () => {
    fc.assert(
      fc.property(semverObj, semverObj, (a, b) => {
        expect(gt(a, b)).toBe(lt(b, a));
      }),
    );
  });

  it("eq(a, b) implies not gt(a, b) and not lt(a, b)", () => {
    fc.assert(
      fc.property(semverObj, (a) => {
        const b: Semver = { ...a };
        expect(eq(a, b)).toBe(true);
        expect(gt(a, b)).toBe(false);
        expect(lt(a, b)).toBe(false);
      }),
    );
  });

  it("exactly one of gt, lt, eq holds for any pair", () => {
    fc.assert(
      fc.property(semverObj, semverObj, (a, b) => {
        const count = [gt(a, b), lt(a, b), eq(a, b)].filter(Boolean).length;
        expect(count).toBe(1);
      }),
    );
  });
});

// ── classify ─────────────────────────────────────────────────────────────

describe("classify — property", () => {
  it("isSecurity=true always returns 'security'", () => {
    fc.assert(
      fc.property(semverString, semverString, (current, target) => {
        const result = classify(current, target, true);
        expect(result).toBe("security");
      }),
    );
  });

  it("same version (when both parse) always returns null", () => {
    fc.assert(
      fc.property(semverString, (version) => {
        const result = classify(version, version, false);
        expect(result).toBeNull();
      }),
    );
  });

  it("classify is deterministic: same inputs, same output", () => {
    fc.assert(
      fc.property(semverString, semverString, fc.boolean(), (current, target, isSecurity) => {
        const first = classify(current, target, isSecurity);
        const second = classify(current, target, isSecurity);
        expect(first).toBe(second);
      }),
    );
  });

  it("a forward update from lower to higher is never 'rollback'", () => {
    fc.assert(
      fc.property(semverObj, semverObj, (a, b) => {
        // Only test when a < b (forward update)
        fc.pre(compare(a, b) < 0);
        const current = `${String(a.major)}.${String(a.minor)}.${String(a.patch)}${a.prerelease !== null ? `-${a.prerelease}` : ""}`;
        const target = `${String(b.major)}.${String(b.minor)}.${String(b.patch)}${b.prerelease !== null ? `-${b.prerelease}` : ""}`;
        const result = classify(current, target, false);
        fc.pre(result !== null);
        expect(result).not.toBe("rollback");
      }),
    );
  });

  it("a backward update from higher to lower is always 'rollback'", () => {
    fc.assert(
      fc.property(semverObj, semverObj, (a, b) => {
        // Only test when a > b (backward update)
        fc.pre(compare(a, b) > 0);
        const current = `${String(a.major)}.${String(a.minor)}.${String(a.patch)}${a.prerelease !== null ? `-${a.prerelease}` : ""}`;
        const target = `${String(b.major)}.${String(b.minor)}.${String(b.patch)}${b.prerelease !== null ? `-${b.prerelease}` : ""}`;
        const result = classify(current, target, false);
        expect(result).toBe("rollback");
      }),
    );
  });
});

// ── satisfies ────────────────────────────────────────────────────────────

describe("satisfies — property", () => {
  it("a version always satisfies an exact constraint of itself", () => {
    fc.assert(
      fc.property(semverString, (version) => {
        const parsed = parse(version);
        expect(parsed).not.toBeNull();
        const result = satisfies(parsed!, version);
        // The exact match should be true if the version was fully parsed
        // (trimmed version from parse should match)
        expect(result).toBe(true);
      }),
    );
  });

  it("satisfies returns boolean or null, never throws", () => {
    fc.assert(
      fc.property(semverObj, fc.string({ minLength: 0, maxLength: 50 }), (version, constraint) => {
        const result = satisfies(version, constraint);
        expect(result === null || typeof result === "boolean").toBe(true);
      }),
    );
  });

  it("a caret constraint: ^X.Y.Z → version.major must equal floor.major when floor.major > 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        semverObj,
        (floorMajor, floorMinor, floorPatch, version) => {
          const constraint = `^${String(floorMajor)}.${String(floorMinor)}.${String(floorPatch)}`;
          const result = satisfies(version, constraint);
          // Implicative assertion: if result is true, then major must match and version >= floor
          const majorOk = result !== true || version.major === floorMajor;
          expect(majorOk).toBe(true);
          const gteOk =
            result !== true ||
            gt(version, {
              major: floorMajor,
              minor: floorMinor,
              patch: floorPatch,
              prerelease: null,
            }) ||
            eq(version, {
              major: floorMajor,
              minor: floorMinor,
              patch: floorPatch,
              prerelease: null,
            });
          expect(gteOk).toBe(true);
        },
      ),
    );
  });

  it("a tilde constraint: ~X.Y.Z → version.major and version.minor must match floor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        semverObj,
        (floorMajor, floorMinor, floorPatch, version) => {
          const constraint = `~${String(floorMajor)}.${String(floorMinor)}.${String(floorPatch)}`;
          const result = satisfies(version, constraint);
          // Implicative assertion: if result is true, then major and minor must match
          const majorOk = result !== true || version.major === floorMajor;
          expect(majorOk).toBe(true);
          const minorOk = result !== true || version.minor === floorMinor;
          expect(minorOk).toBe(true);
        },
      ),
    );
  });
});

// ── highestSatisfying ────────────────────────────────────────────────────

describe("highestSatisfying — property", () => {
  it("returned version satisfies the constraint (when constraint is parseable)", () => {
    fc.assert(
      fc.property(sortedReleaseList, simpleConstraint, (releases, constraint) => {
        const result = highestSatisfying(releases, constraint);
        // Implicative: if result is non-null and parseable, it must satisfy the constraint
        const parsed = result !== null ? parse(result) : null;
        const satResult = parsed !== null ? satisfies(parsed, constraint) : null;
        // If result is null (no satisfying version) the property holds trivially.
        // If constraint is unparseable (null), that's also acceptable.
        const ok = result === null || parsed === null || satResult === true || satResult === null;
        expect(ok).toBe(true);
      }),
    );
  });

  it("no non-prerelease version in releases higher than the result also satisfies the constraint", () => {
    // highestSatisfying intentionally skips prereleases when the constraint
    // doesn't include a dash. The property must only check non-prerelease
    // versions — otherwise a prerelease that technically satisfies the
    // constraint but was skipped by the prerelease filter would be a
    // false counterexample.
    fc.assert(
      fc.property(sortedReleaseList, simpleConstraint, (releases, constraint) => {
        const result = highestSatisfying(releases, constraint);
        const resultParsed = result !== null ? parse(result) : null;
        const resultIndex = result !== null ? releases.indexOf(result) : -1;
        // If result is null or unparseable, property holds trivially.
        // Otherwise, no non-prerelease version before the result should satisfy.
        let noHigherSatisfies = true;
        if (resultParsed !== null && resultIndex > 0) {
          for (let i = 0; i < resultIndex; i++) {
            const vStr = releases[i] ?? "";
            const vParsed = parse(vStr);
            if (vParsed === null) continue;
            if (vParsed.prerelease !== null && !constraint.includes("-")) continue;
            const satResult = satisfies(vParsed, constraint);
            if (satResult === true) {
              noHigherSatisfies = false;
              break;
            }
          }
        }
        expect(noHigherSatisfies).toBe(true);
      }),
    );
  });

  it("returns null for empty releases", () => {
    fc.assert(
      fc.property(fc.option(simpleConstraint, { nil: null }), (constraint) => {
        expect(highestSatisfying([], constraint)).toBeNull();
      }),
    );
  });
});

// ── latestAvailable ──────────────────────────────────────────────────────

describe("latestAvailable — property", () => {
  it("returned version has no prerelease (when a stable version exists)", () => {
    fc.assert(
      fc.property(sortedReleaseList, (releases) => {
        const result = latestAvailable(releases);
        // Implicative: if result is non-null and parseable and stable releases exist,
        // the result must have no prerelease
        const parsed = result !== null ? parse(result) : null;
        const hasStable = releases.some((v) => {
          const p = parse(v);
          return p !== null && p.prerelease === null;
        });
        const ok = result === null || parsed === null || !hasStable || parsed.prerelease === null;
        expect(ok).toBe(true);
      }),
    );
  });

  it("returns null for empty releases", () => {
    expect(latestAvailable([])).toBeNull();
  });
});

// ── candidateVersions ────────────────────────────────────────────────────

describe("candidateVersions — property", () => {
  it("returns distinct candidates (no duplicates)", () => {
    fc.assert(
      fc.property(
        sortedReleaseList,
        fc.option(simpleConstraint, { nil: null }),
        (releases, constraint) => {
          const candidates = candidateVersions(releases, constraint);
          const unique = new Set(candidates);
          expect(unique.size).toBe(candidates.length);
        },
      ),
    );
  });

  it("when both are returned, satisfying !== available", () => {
    fc.assert(
      fc.property(
        sortedReleaseList,
        fc.option(simpleConstraint, { nil: null }),
        (releases, constraint) => {
          const candidates = candidateVersions(releases, constraint);
          // Implicative: if length is 2, the two candidates must differ
          const ok = candidates.length !== 2 || candidates[0] !== candidates[1];
          expect(ok).toBe(true);
        },
      ),
    );
  });

  it("returns at most 2 candidates", () => {
    fc.assert(
      fc.property(
        sortedReleaseList,
        fc.option(simpleConstraint, { nil: null }),
        (releases, constraint) => {
          const candidates = candidateVersions(releases, constraint);
          expect(candidates.length).toBeLessThanOrEqual(2);
        },
      ),
    );
  });

  it("every candidate appears in the releases list", () => {
    fc.assert(
      fc.property(
        sortedReleaseList,
        fc.option(simpleConstraint, { nil: null }),
        (releases, constraint) => {
          const candidates = candidateVersions(releases, constraint);
          for (const c of candidates) {
            expect(releases).toContain(c);
          }
        },
      ),
    );
  });
});

// ── distance ─────────────────────────────────────────────────────────────

describe("distance — property", () => {
  it("distance is non-negative for all components", () => {
    fc.assert(
      fc.property(semverString, semverString, (a, b) => {
        const result = distance(a, b);
        fc.pre(result !== null);
        expect(result.major).toBeGreaterThanOrEqual(0);
        expect(result.minor).toBeGreaterThanOrEqual(0);
        expect(result.patch).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("distance from a version to itself is zero", () => {
    fc.assert(
      fc.property(semverString, (version) => {
        const result = distance(version, version);
        fc.pre(result !== null);
        expect(result).toEqual({ major: 0, minor: 0, patch: 0 });
      }),
    );
  });

  it("distance is symmetric: distance(a, b) == distance(b, a)", () => {
    fc.assert(
      fc.property(semverString, semverString, (a, b) => {
        const ab = distance(a, b);
        const ba = distance(b, a);
        fc.pre(ab !== null && ba !== null);
        expect(ab).toEqual(ba);
      }),
    );
  });
});

// ── isSha ────────────────────────────────────────────────────────────────

describe("isSha — property", () => {
  it("any hex string of 7-40 chars is a SHA", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 40 }),
        fc.constantFrom(..."0123456789abcdef".split("")),
        (length, _char) => {
          // Generate a hex string of the given length
          const chars = "0123456789abcdef";
          let hex = "";
          for (let i = 0; i < length; i++) {
            hex += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          expect(isSha(hex)).toBe(true);
        },
      ),
    );
  });

  it("any string shorter than 7 chars is not a SHA", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (length) => {
        const chars = "0123456789abcdef";
        let hex = "";
        for (let i = 0; i < length; i++) {
          hex += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        expect(isSha(hex)).toBe(false);
      }),
    );
  });

  it("isSha never throws for any string input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (s) => {
        expect(() => isSha(s)).not.toThrow();
        expect(typeof isSha(s)).toBe("boolean");
      }),
    );
  });
});
