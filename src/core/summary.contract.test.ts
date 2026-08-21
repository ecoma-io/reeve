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

  it("mixed kinds → red: capacity beside a configuration error is still a run that answered nothing", () => {
    // The case that used to fall between the two predicates. `starved` is
    // false because not every model was grounded, and the old
    // `every(kind === "protocol")` was false because of the two 429s — so a
    // run that reached no usable answer at all warned about nothing and
    // exited 0, which a maintainer cannot tell from "there was nothing to do".
    // One model failing for a reason that is not weather is enough: weather
    // does not explain the run, so the run does not get to be green.
    const models = ["a", "b", "c"];
    const failures = [
      failure("a", "capacity", "429"),
      failure("b", "protocol", "schema"),
      failure("c", "capacity", "5xx"),
    ];

    expect(failIfRosterExhausted(models, failures)).toBe(true);
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledTimes(1);
  });

  it("mixed kinds → red when the non-capacity failure is an endpoint refusing the key", () => {
    // The multi-endpoint variant, and the worse half: with `endpoints`
    // configured, `reckon` defers an auth failure to `weather.failAuth`, and
    // `authExhausted` stays false while any other endpoint still
    // authenticates — so `settleAuth` never throws. An HTTP 401 was seen, the
    // run delivered nothing, and it exited 0.
    const models = ["a@fast", "b"];
    const failures = [failure("a@fast", "auth", "401"), failure("b", "protocol", "html")];

    expect(failIfRosterExhausted(models, failures)).toBe(true);
  });

  it("a partial roster (not every model attempted) is not exhaustion", () => {
    const failures = [failure("a", "protocol")];

    expect(failIfRosterExhausted(["a", "b"], failures)).toBe(false);
  });
});
