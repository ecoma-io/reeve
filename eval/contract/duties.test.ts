/**
 * The eval runner's duty list cannot drift from the duties that ship.
 *
 * `pnpm eval all` is the fail-closed dogfood gate, and for `dependa` and
 * `triage` an eval fixture is the ONLY end-to-end evidence that exists. So the
 * question "which duties does `all` actually run" is load-bearing, and until
 * this file existed nothing answered it: deleting one line from
 * `eval/runner.ts`'s `DUTIES` made `pnpm eval all` skip that duty entirely and
 * still exit 0. The runner's own unevaluated-duty guard does not catch it —
 * `exitCodeFor` is called at `runner.ts:1315` without the `noFixtures`
 * argument that guard reads, so it never fires. A duty can therefore fall out
 * of the gate silently, which is the same failure shape as a mutation row
 * going stale or a coverage `exclude` growing.
 *
 * The list is read as **text** rather than imported, because `eval/runner.ts`
 * calls `main()` at import time: importing it here would run the evaluation
 * inside the test worker. That is the same reason `src/refusal.test.ts` reads
 * `action.yml` with a regular expression instead of parsing YAML, and the same
 * shape as its "names exactly the directories that ship their own action.yml"
 * case — compare a hand-maintained list against ground truth rather than
 * against a second hand-maintained list.
 *
 * Reading source text is only safe if it fails closed, so the extraction below
 * asserts that it matched and that it found something. A reformat that defeats
 * the pattern turns this test red rather than letting it pass vacuously on an
 * empty match — which for a check about things going missing is the only
 * acceptable direction to fail in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DUTIES as SHIPPED } from "../../src/refusal.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * The `DUTIES` array as `eval/runner.ts` literally spells it.
 *
 * Anchored on `const DUTIES = [` so it cannot accidentally match some other
 * array in the file, and bounded by the first `]` because the list is a flat
 * array of string literals and nothing else.
 */
function runnerDuties(): readonly string[] {
  const source = readFileSync(join(ROOT, "eval", "runner.ts"), "utf8");
  const block = /const DUTIES = \[([^\]]*)\]/.exec(source);
  expect(
    block,
    "could not find `const DUTIES = [` in eval/runner.ts — this pattern has gone stale and " +
      "is no longer checking anything. Re-point it before trusting a green run.",
  ).not.toBeNull();
  const names = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
  expect(
    names.length,
    "matched `const DUTIES = [` but read no duty names out of it",
  ).toBeGreaterThan(0);
  return names;
}

describe("eval runner — the duty list is ground truth, not a second copy", () => {
  it("drives exactly the duties this ref ships", () => {
    // The drift this guards against, in the direction that matters: a duty is
    // removed from the runner (or never added) and `pnpm eval all` goes green
    // having silently evaluated less than it claims to. `src/refusal.ts` is the
    // right thing to compare against because it is itself pinned to the
    // directories that carry an `action.yml` (`src/refusal.test.ts`), so this
    // chains to the filesystem rather than to another list somebody maintains.
    expect([...runnerDuties()].sort()).toEqual([...SHIPPED].sort());
  });

  it("names every duty exactly once", () => {
    const names = runnerDuties();
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });
});
