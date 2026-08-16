/**
 * The fail-closed gate in `eval/exit-code.ts`, pinned outright: finding-only
 * exits 0, and any skipped or failed fixture, or a duty with no fixtures,
 * exits 1. The integration test (`exit-code.integration.mjs`) drives the same
 * gate through the real `pnpm eval` process — this suite pins the pairing the
 * process cannot reach cheaply (a run full of failures) plus the pure table.
 */
import { describe, expect, it } from "vitest";

import { exitCodeFor } from "../exit-code.ts";
import type { Line } from "../exit-code.ts";

const line = (outcome: Line["outcome"]): Line => ({
  fixture: "f",
  outcome,
  detail: "",
});

describe("the eval runner's fail-closed exit code", () => {
  it("exits 0 only when every fixture was a finding", () => {
    expect(exitCodeFor([line("finding"), line("finding")])).toBe(0);
  });

  it("exits 1 the moment any fixture failed", () => {
    expect(exitCodeFor([line("failed")])).toBe(1);
    expect(exitCodeFor([line("finding"), line("failed")])).toBe(1);
  });

  it("exits 1 the moment any fixture skipped — the clean-stop collapse", () => {
    expect(exitCodeFor([line("skipped")])).toBe(1);
    expect(exitCodeFor([line("finding"), line("skipped")])).toBe(1);
  });

  it("exits 1 when nothing was a finding, even with no failures", () => {
    expect(exitCodeFor([])).toBe(1);
    expect(exitCodeFor([line("skipped"), line("skipped")])).toBe(1);
  });

  it("exits 1 for a duty with no fixtures, named or empty", () => {
    expect(exitCodeFor([], ["dependa"])).toBe(1);
    expect(exitCodeFor([line("finding")], ["triage"])).toBe(1);
  });
});
