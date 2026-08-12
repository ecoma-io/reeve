import { describe, expect, it, vi } from "vitest";

import type { Meter, Spend } from "../../core/meter.js";

import { budgetExhausted, createBudget } from "./budget.js";
import type { Settings } from "./main.js";

function settingsWith(maxRequests: number | null): Settings {
  return { maxRequests } as unknown as Settings;
}

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
    expect(budgetExhausted(settingsWith(null), meterSpending(1_000_000), budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("is not exhausted while spend sits below the ceiling", () => {
    const budget = createBudget();
    expect(budgetExhausted(settingsWith(10), meterSpending(9), budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("is exhausted once spend reaches the ceiling, and marks the budget denied", () => {
    const budget = createBudget();
    expect(budgetExhausted(settingsWith(10), meterSpending(10), budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("is exhausted once spend passes the ceiling", () => {
    const budget = createBudget();
    expect(budgetExhausted(settingsWith(10), meterSpending(11), budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("leaves an already-denied budget denied even once spend drops back under the ceiling", () => {
    const budget = createBudget();
    budgetExhausted(settingsWith(10), meterSpending(10), budget);
    expect(budgetExhausted(settingsWith(10), meterSpending(0), budget)).toBe(false);
    expect(budget.denied).toBe(true);
  });
});
