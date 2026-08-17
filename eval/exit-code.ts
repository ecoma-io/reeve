/**
 * The eval runner's fail-closed gate, kept side-effect-free so the contract
 * suite can pin every outcome→exit-code pairing without spawning a run.
 *
 * The three outcomes stay distinct — `finding`, `failed`, `skipped` — and the
 * gate is what keeps a run full of clean stops from reading as green. Only a
 * run where every fixture was a finding, and none failed or skipped, exits 0.
 */
export type Outcome = "finding" | "failed" | "skipped";

/** One fixture's report. */
export interface Line {
  readonly fixture: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

/**
 * The process exit code a set of fixture reports earns.
 *
 * Fail-closed: 0 only when every fixture is a finding and none failed or
 * skipped. A skipped fixture means the run deliberately did nothing — a duty
 * the warrant no longer grants reads as `skipped` everywhere — and that is
 * exactly the case that must not look like a passing run. Any failed or
 * skipped fixture exits 1, and so does a duty with no fixtures at all: an
 * unevaluated duty is never mistaken for a passing one.
 */
export function exitCodeFor(lines: readonly Line[], noFixtures: readonly string[] = []): number {
  if (noFixtures.length > 0) return 1;
  const finding = lines.filter((line) => line.outcome === "finding").length;
  const failed = lines.filter((line) => line.outcome === "failed").length;
  const skipped = lines.filter((line) => line.outcome === "skipped").length;
  return finding > 0 && failed === 0 && skipped === 0 ? 0 : 1;
}
