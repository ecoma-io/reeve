/**
 * The `max-requests` ceiling, and the one behavioural fork the merge settled.
 *
 * This file is `translate/budget.test.ts`, moved. `harmonise/budget.test.ts`
 * was byte-identical to it across all five cases and is gone;
 * `dependa/budget.test.ts` covered the same five plus the sticky pair below.
 * The `Settings` fixture each of them built — forty lines of a duty's whole
 * configuration, to reach one number — is gone with them: the function takes
 * the ceiling.
 */
import { describe, expect, it, vi } from "vitest";

import { budgetExhausted, createBudget } from "./budget.js";
import type { Meter, Spend } from "./meter.js";

function meterSpending(requests: number): Meter {
  const spend: Spend = {
    purpose: "draft",
    model: "model-a",
    endpoint: null,
    requests,
    failed: 0,
    unreported: 0,
    prompt: 0,
    completion: 0,
  };
  return { record: vi.fn(), spent: () => [spend] };
}

describe("createBudget", () => {
  it("starts undenied", () => {
    expect(createBudget()).toEqual({ denied: false });
  });
});

describe("budgetExhausted", () => {
  it("is never exhausted when max-requests is unset", () => {
    const budget = createBudget();
    expect(budgetExhausted(null, meterSpending(1_000_000), budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("is not exhausted while spend sits below the ceiling", () => {
    const budget = createBudget();
    expect(budgetExhausted(10, meterSpending(9), budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("is exhausted once spend reaches the ceiling, and marks the budget denied", () => {
    const budget = createBudget();
    expect(budgetExhausted(10, meterSpending(10), budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("is exhausted once spend passes the ceiling", () => {
    const budget = createBudget();
    expect(budgetExhausted(10, meterSpending(11), budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("keeps answering exhausted once denied, even if the meter reads lower", () => {
    // The fork the three copies disagreed about, and the only case where they
    // could have. `dependa`'s short-circuited on `denied` and answered `true`
    // for ever after; `translate`'s and `harmonise`'s recomputed and answered
    // `false` again while leaving `denied` set.
    //
    // A `Meter` only accumulates, so no production run reaches this. The
    // sticky answer is kept because it is the direction that fails closed: if
    // a meter ever did reset — a per-thread meter is an obvious future shape —
    // recomputing would let a run resume spending after it had already turned
    // work away, exceeding across the run the ceiling the maintainer set.
    const budget = createBudget();
    expect(budgetExhausted(10, meterSpending(10), budget)).toBe(true);
    expect(budgetExhausted(10, meterSpending(0), budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("never spends a meter read on a run with no ceiling", () => {
    // `null` short-circuits before `spent()`. Cheap to state, and it is the
    // default configuration, so it is the path almost every run takes.
    const meter: Meter = {
      record: vi.fn(),
      spent: vi.fn(() => {
        throw new Error("spent() must not be called when max-requests is unset");
      }),
    };
    expect(budgetExhausted(null, meter, createBudget())).toBe(false);
    expect(vi.mocked(meter.spent)).not.toHaveBeenCalled();
  });
});
