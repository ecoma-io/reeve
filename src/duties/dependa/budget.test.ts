/**
 * Tests for the dependa budget module.
 *
 * The budget is a simple gate: once the request count exceeds maxRequests,
 * budget.denied is set to true and never unset. These tests verify
 * budget creation, exhaustion detection, and the null-maxRequests case.
 */
import { describe, expect, it } from "vitest";

import { createBudget, budgetExhausted } from "./budget.js";
import type { Meter } from "../../core/meter.js";

function stubMeter(requests: number): Meter {
  return {
    spent: () => [{ model: "test", requests, tokens: 0, retries: 0 }],
  } as unknown as Meter;
}

describe("createBudget", () => {
  it("starts with denied = false", () => {
    const budget = createBudget();
    expect(budget.denied).toBe(false);
  });
});

describe("budgetExhausted", () => {
  it("returns false when maxRequests is null (unlimited)", () => {
    const budget = createBudget();
    const meter = stubMeter(1000);
    expect(budgetExhausted(null, meter, budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("returns false when spent is below the limit", () => {
    const budget = createBudget();
    const meter = stubMeter(5);
    expect(budgetExhausted(10, meter, budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("returns true when spent meets the limit", () => {
    const budget = createBudget();
    const meter = stubMeter(10);
    expect(budgetExhausted(10, meter, budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("returns true when spent exceeds the limit", () => {
    const budget = createBudget();
    const meter = stubMeter(20);
    expect(budgetExhausted(10, meter, budget)).toBe(true);
  });

  it("denied flag is sticky — once set, always returns true", () => {
    const budget = createBudget();
    const meter = stubMeter(10);

    // First call exhausts the budget
    expect(budgetExhausted(10, meter, budget)).toBe(true);

    // Even with a new meter showing fewer requests, budget stays denied
    const freshMeter = stubMeter(0);
    expect(budgetExhausted(10, freshMeter, budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("returns true immediately when budget is already denied", () => {
    const budget = createBudget();
    budget.denied = true;
    const meter = stubMeter(0);
    expect(budgetExhausted(10, meter, budget)).toBe(true);
  });
});
