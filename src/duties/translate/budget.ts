/**
 * This run's own `max-requests` ceiling, and whether it has been spent — see
 * `budgetExhausted`'s own doc comment for why this is a different kind of
 * stop than `Weather`'s starvation.
 */
import type { Meter } from "../../core/meter.js";
import { total } from "../../core/meter.js";

import type { Settings } from "./main.js";

/** Whether this run has spent `max-requests` — see `createBudget`'s doc comment for why it is one mutable object. */
export interface Budget {
  denied: boolean;
}

/**
 * Whether this run ever genuinely turned work away for `max-requests` —
 * the one thing `budget-exhausted` reports, distinct from whether the meter
 * happens to sit at or past the ceiling once the run is over.
 *
 * A single mutable object rather than a `boolean` recomputed at the end,
 * because recomputing from the final meter reading gets both directions
 * wrong: a thread that needed exactly `max-requests` requests and had
 * nothing left to ask for reads identically, at the end, to one that had a
 * language turned away — the meter sits at the ceiling either way — and a
 * sweep's last candidate can deny work inside its own per-language or
 * per-reply checkpoint with no further candidate left for the sweep's own
 * pre-thread check to ever run again and notice. `denied` is set exactly
 * once, at the moment `budgetExhausted` itself answers `true` — every call
 * site below only asks the question immediately before a real piece of work
 * it would otherwise do, so that answer is always a genuine denial.
 */
export function createBudget(): Budget {
  return { denied: false };
}

/**
 * Whether this run has already spent `max-requests`, across every purpose —
 * detection, drafting and judging combined, the same total the summary's own
 * spend table adds up to. `null` is no bound, the default, and never
 * exhausted.
 *
 * A different kind of stop than `starved`, deliberately: a roster out of
 * capacity is weather from the provider's own side, something happened to it.
 * A budget this run set for itself running out is not that — it is a ceiling
 * this run chose, working exactly as configured. Conflating the two would
 * have a maintainer watching `starved` for exactly the wrong reason once
 * `max-requests` started tripping it instead of a real outage.
 *
 * Checked at each place a fresh request is about to be spent — before
 * detection, a language, a reply, a sweep's next thread — rather than once
 * up front, because the budget can run out partway through any of those, and
 * what already happened stands: a translation already drafted and published
 * is not un-published because the next language could not be started.
 */
export function budgetExhausted(settings: Settings, meter: Meter, budget: Budget): boolean {
  const exhausted =
    settings.maxRequests !== null && total(meter.spent()).requests >= settings.maxRequests;
  if (exhausted) budget.denied = true;
  return exhausted;
}
