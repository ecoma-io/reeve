/**
 * This run's own `max-requests` ceiling, and whether it has been spent.
 *
 * **A different kind of stop than `starved`, deliberately.** A roster out of
 * capacity is weather from the provider's own side: something happened to it,
 * and [D12](../../docs/doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)
 * says a run does not fail red for it. A budget this run set for itself running
 * out is not that — it is a ceiling this run chose, working exactly as
 * configured. Conflating the two would have a maintainer watching `starved` for
 * exactly the wrong reason once `max-requests` started tripping it instead of a
 * real outage. That distinction is why this lives beside `starvedWarning` and
 * `warnIfStarved` in the core rather than inside whichever duty needed it
 * first.
 *
 * It arrived here from three duties at once. `translate/budget.ts`,
 * `harmonise/budget.ts` and `dependa/budget.ts` were the same twelve lines of
 * code three times — the first two byte-identical below their doc comments, and
 * their two test files byte-identical across all five cases. Nothing in any of
 * them was a policy about translating, harmonising or bumping a dependency: the
 * meter is core, `max-requests` is a shared input, and the doctrine above is a
 * core distinction. The only real difference was that `dependa` passed the
 * ceiling directly while the other two passed a whole `Settings`, which is what
 * had made one copy into three.
 */
import { total, type Meter } from "./meter.js";

/** Whether this run has spent `max-requests` — see {@link createBudget} for why it is one mutable object. */
export interface Budget {
  /** Set once when the budget is exceeded. Never unset. */
  denied: boolean;
}

/**
 * Whether this run ever genuinely turned work away for `max-requests` — the one
 * thing `budget-exhausted` reports, distinct from whether the meter happens to
 * sit at or past the ceiling once the run is over.
 *
 * A single mutable object rather than a `boolean` recomputed at the end,
 * because recomputing from the final meter reading gets both directions wrong:
 * a thread that needed exactly `max-requests` requests and had nothing left to
 * ask for reads identically, at the end, to one that had a language turned away
 * — the meter sits at the ceiling either way — and a sweep's last candidate can
 * deny work inside its own per-language or per-reply checkpoint with no further
 * candidate left for the sweep's own pre-thread check to ever run again and
 * notice. `denied` is set exactly once, at the moment {@link budgetExhausted}
 * itself answers `true` — every call site only asks the question immediately
 * before a real piece of work it would otherwise do, so that answer is always a
 * genuine denial.
 */
export function createBudget(): Budget {
  return { denied: false };
}

/**
 * Whether this run has already spent `max-requests`, across every purpose —
 * detection, drafting and judging combined, the same total the summary's own
 * spend table adds up to. `null` is no bound, the default, and never exhausted.
 *
 * Checked at each place a fresh request is about to be spent — before
 * detection, a language, a reply, a group, a sweep's next thread — rather than
 * once up front, because the budget can run out partway through any of those,
 * and what already happened stands: a translation already drafted and published
 * is not un-published because the next language could not be started.
 *
 * ── The one behavioural fork the merge had to settle ────────────────────────
 *
 * The three copies disagreed about a case none of them can reach, and both
 * sides had pinned their answer. `dependa`'s short-circuited on `budget.denied`
 * and so answered `true` for ever after the first denial; `translate`'s and
 * `harmonise`'s recomputed, so if the meter's reading ever *fell* back below
 * the ceiling they answered `false` again while leaving `denied` set. Their
 * tests said so in as many words — "denied flag is sticky — once set, always
 * returns true" against "leaves an already-denied budget denied even once spend
 * drops back under the ceiling".
 *
 * A `Meter` only ever accumulates, so no production run can distinguish them.
 * This keeps the sticky answer, for one reason: it is the direction that fails
 * closed. If a meter ever did reset — a per-thread meter is an obvious future
 * shape — the recomputing version would quietly let a run resume spending after
 * it had already turned work away, exceeding across the run the ceiling the
 * maintainer set. The sticky version refuses. A returned `false` from a
 * function that has already set `denied` is also the harder of the two for a
 * reader to trust.
 */
export function budgetExhausted(maxRequests: number | null, meter: Meter, budget: Budget): boolean {
  if (maxRequests === null) return false;
  if (budget.denied) return true;
  if (total(meter.spent()).requests < maxRequests) return false;

  budget.denied = true;
  return true;
}
