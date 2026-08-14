/**
 * Request budget for the `dependa` duty.
 *
 * Same pattern as `harmonise/budget.ts`: a mutable object with a single
 * `denied` flag, because the budget is checked at clean-cut boundaries
 * (before each group, before each datasource query) and a recomputed
 * boolean on every check would be noisy without being more correct.
 */
import { total, type Meter } from "../../core/meter.js";

export interface Budget {
  /** Set once when the budget is exceeded. Never unset. */
  denied: boolean;
}

export function createBudget(): Budget {
  return { denied: false };
}

/**
 * Check whether the request budget is exhausted.
 * Sets `budget.denied` and returns true when the ceiling is reached.
 */
export function budgetExhausted(maxRequests: number | null, meter: Meter, budget: Budget): boolean {
  if (maxRequests === null) return false;
  if (budget.denied) return true;

  const spent = total(meter.spent());
  if (spent.requests >= maxRequests) {
    budget.denied = true;
    return true;
  }

  return false;
}
