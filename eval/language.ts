/**
 * The language dimension of one fixture, decided apart from the effect checks.
 *
 * A multilingual fixture declares the language its run must have identified —
 * `expected.language`, the label the run must have written to its `language`
 * output. When a fixture declares one and the run named something else, the
 * run is `failed`: a thread whose language the pipeline misidentified must not
 * wear the `skipped` outcome a clean stop earns, because a misidentified
 * language is not a deliberate no-op — it is the pipeline handling the thread
 * wrong, and the gate has to tell the two apart. A skipped run exits 1 either
 * way, but the report a maintainer reads is different, and the contract suite
 * pins the pairing (see the `languageLine` cases in `multilingual.test.ts`).
 *
 * Undeclared, or declared and matched, contributes nothing.
 */
import type { Line } from "./exit-code.ts";

/** The label a run must have identified a thread as, or null when the fixture does not care. */
export function languageLine(
  fixture: string,
  expected: string | undefined,
  actual: string,
): Line | null {
  if (expected === undefined) return null;
  if (actual === expected) return null;
  return {
    fixture,
    outcome: "failed",
    detail: `identified the thread as \`${actual}\`; fixture expects \`${expected}\``,
  };
}
