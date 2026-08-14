/**
 * Deterministic semver operations for `dependa`.
 *
 * Every function here is pure: same inputs, same outputs, no network, no
 * model, no side effects. This is the module that classifies an update as
 * major/minor/patch/pin/digest/rollback/security — a classification that
 * enforcement gates on, and that must never depend on a model's opinion.
 *
 * The semver grammar handled here is deliberately narrower than the full
 * semver specification. dependa only needs to classify what manifests
 * actually contain — not to validate every possible version string. A
 * version that does not parse is not classified, and the dependency that
 * carries it is not proposed for update.
 */

import type { UpdateType } from "./model.js";

/**
 * A parsed semantic version. All fields are integers; a version that does
 * not fully parse produces `null`.
 */
export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-release identifier (e.g. "beta.1"), or null. */
  readonly prerelease: string | null;
}

/** The regex that matches a loose semver core. */
const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/;

/**
 * Parse a version string into a Semver, or return null when it does not
 * resemble one. The grammar is intentionally permissive at the edges —
 * `1`, `1.2`, and `1.2.3` all parse, because ecosystems actually write
 * all three — but the major version must be a number, because `"latest"`
 * is not a version.
 */
export function parse(version: string): Semver | null {
  const match = SEMVER_RE.exec(version.trim());
  if (match === null) return null;

  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  const prerelease = match[4] ?? null;

  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }

  return { major, minor, patch, prerelease };
}

/**
 * Compare two semver versions. Returns -1, 0, or 1.
 * Pre-release versions are lower than their release counterpart.
 */
export function compare(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A version without pre-release is higher than one with it
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease === null && b.prerelease === null) return 0;

  // Both have pre-release: compare lexicographically
  const ap = a.prerelease ?? "";
  const bp = b.prerelease ?? "";
  if (ap < bp) return -1;
  if (ap > bp) return 1;
  return 0;
}

/** Whether `version` is greater than `baseline`. */
export function gt(version: Semver, baseline: Semver): boolean {
  return compare(version, baseline) > 0;
}

/** Whether `version` is less than `baseline`. */
export function lt(version: Semver, baseline: Semver): boolean {
  return compare(version, baseline) < 0;
}

/** Whether two versions are equal (ignoring build metadata). */
export function eq(a: Semver, b: Semver): boolean {
  return compare(a, b) === 0;
}

/**
 * Classify the update from `current` to `target`.
 *
 * Deterministic. No model. The classification depends only on the version
 * strings. `isSecurity` is a separate parameter because it comes from the
 * datasource (a registry flag, not a version number) and overrides the
 * semver-based classification.
 *
 * Returns `null` when either version cannot be parsed — a dependency whose
 * version does not parse is not proposed for update.
 */
export function classify(current: string, target: string, isSecurity: boolean): UpdateType | null {
  if (isSecurity) return "security";

  const cur = parse(current);
  const tgt = parse(target);
  if (cur === null || tgt === null) return null;

  // Target must be newer than current for a forward update
  const cmp = compare(tgt, cur);
  if (cmp < 0) return "rollback";
  if (cmp === 0) return null; // Same version — nothing to update

  if (tgt.major > cur.major) return "major";
  if (tgt.minor > cur.minor) return "minor";
  return "patch";
}

/**
 * Whether a version satisfies a simple semver range.
 *
 * Supports the most common constraint grammars:
 * - Exact: `"1.2.3"` → only 1.2.3
 * - Caret: `"^1.2.3"` → >=1.2.3, <2.0.0
 * - Tilde: `"~1.2.3"` → >=1.2.3, <1.3.0
 * - GTE: `">=1.2.3"` → >=1.2.3
 * - GT: `">1.2.3"` → >1.2.3
 * - Range: `">=1.2.3 <2.0.0"` → both conditions
 *
 * This is NOT a full npm/cargo/go constraint solver. It handles the
 * patterns that actually appear in manifests. A constraint it cannot
 * parse returns `null`, and the caller decides what that means.
 */
export function satisfies(version: Semver, constraint: string): boolean | null {
  const trimmed = constraint.trim();

  // Exact version match
  if (/^\d/.test(trimmed)) {
    const pinned = parse(trimmed);
    if (pinned === null) return null;
    return eq(version, pinned);
  }

  // Caret range: ^1.2.3 → >=1.2.3, <2.0.0
  if (trimmed.startsWith("^")) {
    const floor = parse(trimmed.slice(1));
    if (floor === null) return null;
    if (lt(version, floor)) return false;
    if (floor.major === 0) {
      // ^0.2.3 → >=0.2.3, <0.3.0
      return version.major === 0 && version.minor === floor.minor;
    }
    return version.major === floor.major;
  }

  // Tilde range: ~1.2.3 → >=1.2.3, <1.3.0
  if (trimmed.startsWith("~")) {
    const floor = parse(trimmed.slice(1));
    if (floor === null) return null;
    if (lt(version, floor)) return false;
    return version.major === floor.major && version.minor === floor.minor;
  }

  // Space-separated range: ">=1.2.3 <2.0.0"
  // Must be checked before comparison operators — otherwise the leading
  // ">=" in ">=1.2.3 <2.0.0" would match the comparison branch and
  // fail to parse the whole string as a single constraint.
  if (trimmed.includes(" ")) {
    const parts = trimmed.split(/\s+/).filter((s) => s.length > 0);
    for (const part of parts) {
      const result = satisfies(version, part);
      if (result !== true) return result;
    }
    return true;
  }

  // Comparison operators
  if (trimmed.startsWith(">=")) {
    const floor = parse(trimmed.slice(2));
    if (floor === null) return null;
    return gt(version, floor) || eq(version, floor);
  }
  if (trimmed.startsWith(">")) {
    const floor = parse(trimmed.slice(1));
    if (floor === null) return null;
    return gt(version, floor);
  }
  if (trimmed.startsWith("<=")) {
    const ceiling = parse(trimmed.slice(2));
    if (ceiling === null) return null;
    return lt(version, ceiling) || eq(version, ceiling);
  }
  if (trimmed.startsWith("<")) {
    const ceiling = parse(trimmed.slice(1));
    if (ceiling === null) return null;
    return lt(version, ceiling);
  }

  // Cannot parse this constraint
  return null;
}

/**
 * Compute the highest version from `releases` that satisfies `constraint`.
 *
 * Returns null when no release satisfies the constraint, or when the
 * constraint cannot be parsed. Releases are assumed to be in newest-first
 * order from the datasource.
 */
export function highestSatisfying(
  releases: readonly string[],
  constraint: string | null,
): string | null {
  if (constraint === null) {
    // No constraint — return the first (newest) non-prerelease release
    for (const version of releases) {
      const parsed = parse(version);
      if (parsed !== null && parsed.prerelease === null) return version;
    }
    return releases[0] ?? null;
  }

  for (const version of releases) {
    const parsed = parse(version);
    if (parsed === null) continue;
    // Skip pre-releases unless the constraint explicitly includes them
    if (parsed.prerelease !== null && !constraint.includes("-")) continue;
    const result = satisfies(parsed, constraint);
    if (result === true) return version;
  }

  return null;
}

/**
 * Compute version distance between current and target.
 *
 * Returns the distance in major/minor/patch components, or null when
 * either version cannot be parsed.
 */
export function distance(
  current: string,
  target: string,
): {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
} | null {
  const cur = parse(current);
  const tgt = parse(target);
  if (cur === null || tgt === null) return null;

  return {
    major: Math.abs(tgt.major - cur.major),
    minor: Math.abs(tgt.minor - cur.minor),
    patch: Math.abs(tgt.patch - cur.patch),
  };
}

/**
 * Whether a version string looks like a pinned SHA (hex string) rather
 * than a semver version. Used for GitHub Actions `uses:` lines where
 * the version can be a tag or a commit SHA.
 */
export function isSha(version: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(version.trim());
}
