import { beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "@actions/core";

import { failIfRosterExhausted } from "./summary.js";
import type { Failure } from "./provider.js";

// Contract (matrix GAP 2): the all-capacity vs all-config-distinction must be
// observable at the boundary where a duty concludes, not only in the
// predicate. When every model on the roster failed with a PROTOCOL error the
// run fails red — a configuration problem, not capacity weather. Capacity
// failures alone never trip it. This is the exact decision every duty faces
// after a rotation comes back empty; `setFailed` is the observable boundary.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  setFailed: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function failure(model: string, kind: Failure["kind"], reason = "no"): Failure {
  return { ok: false, model, reason, kind };
}

describe("failIfRosterExhausted at the duty boundary", () => {
  it("all-protocol → red: every model failed for a configuration reason, so setFailed fires", () => {
    const models = ["a", "b"];
    const failures = [
      failure("a", "protocol", "body did not match schema"),
      failure("b", "protocol"),
    ];

    const tripped = failIfRosterExhausted(models, failures);

    expect(tripped).toBe(true);
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain(
      "no model on the roster produced a usable answer",
    );
  });

  it("all-capacity → not red: quota/weather is for the summary warning, not a configuration failure", () => {
    const models = ["a", "b"];
    const failures = [failure("a", "capacity", "quota"), failure("b", "capacity", "timeout")];

    const tripped = failIfRosterExhausted(models, failures);

    expect(tripped).toBe(false);
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });

  it("mixed kinds → not red: one degraded item must not fail a run that published the rest", () => {
    // Deliberate, and the reason is the call sites rather than the predicate.
    // Every caller sits inside a per-item loop — per candidate in `dependa`,
    // per locale in `harmonise`, per chunk in `translate`, per thread in
    // `respond` — so a predicate that fired here would redden a whole sweep
    // because one item's roster hit a rate limit and then a bad body.
    const models = ["a", "b", "c"];
    const failures = [
      failure("a", "capacity", "429"),
      failure("b", "protocol", "schema"),
      failure("c", "capacity", "5xx"),
    ];

    expect(failIfRosterExhausted(models, failures)).toBe(false);
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });

  it("all-config → red when an endpoint refused the key rather than rejecting a body", () => {
    // The multi-endpoint hole this round closed: `reckon` defers an auth
    // failure to `weather.failAuth`, and `authExhausted` stays false while any
    // other endpoint still authenticates, so `settleAuth` never throws. The
    // run saw an HTTP 401, delivered nothing, and used to exit 0 because the
    // predicate asked for `protocol` specifically.
    const models = ["a@fast", "b"];
    const failures = [failure("a@fast", "auth", "401"), failure("b", "protocol", "html")];

    expect(failIfRosterExhausted(models, failures)).toBe(true);
  });

  it("a partial roster (not every model attempted) is not exhaustion", () => {
    const failures = [failure("a", "protocol")];

    expect(failIfRosterExhausted(["a", "b"], failures)).toBe(false);
  });
});
