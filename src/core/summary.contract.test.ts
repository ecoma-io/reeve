import { beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "@actions/core";

import { failIfProtocolExhausted } from "./summary.js";
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

describe("failIfProtocolExhausted at the duty boundary", () => {
  it("all-protocol → red: every model failed for a configuration reason, so setFailed fires", () => {
    const models = ["a", "b"];
    const failures = [
      failure("a", "protocol", "body did not match schema"),
      failure("b", "protocol"),
    ];

    const tripped = failIfProtocolExhausted(models, failures);

    expect(tripped).toBe(true);
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain(
      "every model on the roster failed with a protocol error",
    );
  });

  it("all-capacity → not red: quota/weather is for the summary warning, not a configuration failure", () => {
    const models = ["a", "b"];
    const failures = [failure("a", "capacity", "quota"), failure("b", "capacity", "timeout")];

    const tripped = failIfProtocolExhausted(models, failures);

    expect(tripped).toBe(false);
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });

  it("mixed kinds with some recoverable capacity are not protocol-exhaustion", () => {
    const models = ["a", "b", "c"];
    const failures = [
      failure("a", "capacity", "429"),
      failure("b", "protocol", "schema"),
      failure("c", "capacity", "5xx"),
    ];

    expect(failIfProtocolExhausted(models, failures)).toBe(false);
  });

  it("a partial roster (not every model attempted) is not exhaustion", () => {
    const failures = [failure("a", "protocol")];

    expect(failIfProtocolExhausted(["a", "b"], failures)).toBe(false);
  });
});
