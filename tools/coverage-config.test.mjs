/**
 * Tests that pin the two rules `vitest.config.ts`'s coverage block states about
 * itself — because until this file existed, both were prose.
 *
 * The config comment says the thresholds never go down and that `exclude` never
 * grows to hide uncovered code. An adversarial review pointed out that adding
 * one glob to `exclude` raises every percentage and turns nothing red: the
 * denominator moves, the gate reports success, and the only thing standing in
 * the way is a sentence in a comment that nothing reads.
 *
 * **What this file can and cannot do.** It cannot stop anyone from editing the
 * config and this test together — nothing in a repository can, any more than
 * anything stops a coverage floor being lowered. What it does is convert a
 * silent improvement into a deliberate one: shrinking the measurement now
 * requires a second, explicit edit here, in a file whose whole subject is that
 * the first edit is suspicious. That is the same standing as `TABLE_FLOOR` in
 * `tools/mutation.mjs`, and `docs/internal/ci-gates.md` describes it in exactly
 * those terms rather than as a guarantee.
 *
 * Read as text rather than imported: `vitest.config.ts` is TypeScript that
 * `node --test` will not load, and parsing it as text keeps this file free of
 * a build step. Every extraction below asserts that it matched, so a reformat
 * that defeats a pattern fails this test rather than passing it vacuously —
 * the direction a check about hiding things has to fail in.
 */
import { match, deepStrictEqual, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");

/**
 * The globs `coverage.exclude` names, as recorded when this test was written.
 *
 * Each is justified in `docs/internal/coverage-baseline.md`, and each is an
 * entry point that calls `run()` or `core.setFailed` at import time — a file a
 * unit test cannot load without executing the action. That is the ONLY reason
 * this list is allowed to have anything in it.
 *
 * Adding a glob here is not a formatting change. It removes files from the
 * denominator of every coverage percentage in the repository, which raises all
 * four numbers while covering nothing. If a new entry point genuinely belongs,
 * add it here and say in the commit message why the file cannot be imported.
 */
const RECORDED_EXCLUSIONS = ["src/main.ts", "src/duties/*/main.ts", "src/doctor/run.ts"];

/** The floor the thresholds may never fall below. Raise it; never lower it. */
const THRESHOLD_FLOOR = 90;

describe("coverage exclusions", () => {
  it("names exactly the globs that were justified, and no more", () => {
    const block = /exclude:\s*\[([^\]]*)\]/.exec(CONFIG);
    ok(block !== null, "could not find `exclude:` in vitest.config.ts — pattern is stale");
    const globs = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    deepStrictEqual(
      globs,
      RECORDED_EXCLUSIONS,
      "coverage.exclude changed. An exclusion raises every percentage while covering " +
        "nothing, so this is never an incidental edit: justify the new entry point in " +
        "docs/internal/coverage-baseline.md and update RECORDED_EXCLUSIONS deliberately.",
    );
  });

  it("measures the whole of src/, so nothing is hidden by narrowing the include instead", () => {
    // The mirror of the exclusion trick: leave `exclude` alone and shrink
    // `include`. Same effect on the denominator, and it would not have tripped
    // the assertion above.
    match(CONFIG, /include:\s*\["src\/\*\*\/\*\.ts"\]/);
  });
});

describe("coverage thresholds", () => {
  it("holds all four metrics at or above the recorded floor", () => {
    const block = /thresholds:\s*\{([^}]*)\}/.exec(CONFIG);
    ok(block !== null, "could not find `thresholds:` in vitest.config.ts — pattern is stale");

    const found = Object.fromEntries(
      [...block[1].matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
    );
    deepStrictEqual(
      Object.keys(found).sort(),
      ["branches", "functions", "lines", "statements"],
      "a coverage threshold was removed — an absent threshold is not enforced at all",
    );
    for (const [metric, value] of Object.entries(found)) {
      ok(
        value >= THRESHOLD_FLOOR,
        `${metric} threshold is ${String(value)}, below the recorded floor of ` +
          `${String(THRESHOLD_FLOOR)}. A red threshold is a missing test; the fix is the test.`,
      );
    }
  });
});
