/**
 * What a run spent, kept as it is spent.
 *
 * A duty that had to remember to report its own tokens would report them for
 * the stages somebody remembered. So nothing reports: the meter wraps the
 * provider, and every request that goes through it is counted by the fact of
 * having been made. A stage that forgets to be metered still works and simply
 * does not appear, which is a visible hole rather than a wrong total.
 *
 * Counted per model **and** per purpose, because those are the two questions a
 * bill answers. "Which model is costing this" decides what to configure next;
 * "what is detection costing me" decides whether a stage is worth keeping. One
 * number for the run answers neither.
 *
 * Nothing here is an estimate. A provider that reports no usage is recorded as
 * a request with no numbers, and the summary says how many of those there were
 * — a total assembled out of guesses is worse than a total with a hole in it,
 * because only one of them can be checked against the invoice.
 */
import type { Completion, Message, Provider, Usage } from "./provider.js";

/**
 * Which stage of the pipeline asked.
 *
 * A closed set rather than a free string, and the reason is the table: a run
 * that spelled a purpose two ways would report two rows for one stage, and the
 * question the split exists to answer — "what is screening costing me" — would
 * quietly get half an answer. Adding a stage means adding a name here, which is
 * a line in a diff rather than a typo in a call site.
 *
 * `screen` and `triage` are separate for the reason the tiers are separate.
 * Screening runs the cheap roster over everything that arrives; triage runs the
 * expensive one over what got through. One number covering both would hide
 * exactly the ratio a maintainer tunes.
 */
export type Purpose = "detect" | "draft" | "judge" | "screen" | "triage" | "pivot" | "duplicate";

/**
 * The stage names a reader of the documentation already knows.
 *
 * Here rather than in each duty's summary, because two duties are two chances
 * to call the same stage two things, and a maintainer comparing one run's table
 * against another's should not have to work out that "Judging" and "Judge" are
 * the same row. A duty spending nothing on a purpose simply has no row for it.
 */
export const STAGE: Record<Purpose, string> = {
  detect: "Detection",
  draft: "Drafting",
  judge: "Judging",
  screen: "Screening",
  triage: "Triage",
  pivot: "Pivot translation",
  duplicate: "Duplicate check",
};

/** One model's spend on one purpose. */
export interface Spend {
  readonly purpose: Purpose;
  readonly model: string;
  /**
   * Which endpoint carried this spend: the alias an `endpoints` line
   * declared, or null for the default `base-url`/`api-key` pair. Every
   * request against one `purpose`/`model` pair routes to the same endpoint by
   * construction — the id is the routing — so one field on the row is enough,
   * never a second breakdown underneath it.
   */
  readonly endpoint: string | null;
  /** How many requests were made, whatever they answered. */
  readonly requests: number;
  /** How many of them Reeve could not use. Rotation's cost, made visible. */
  readonly failed: number;
  /** How many answered without saying what they cost. */
  readonly unreported: number;
  readonly prompt: number;
  readonly completion: number;
}

/**
 * The ledger. `record` is what `metered` calls; `spent` is what the summary
 * reads. One object rather than two, because a run has one bill.
 */
export interface Meter {
  record(purpose: Purpose, completion: Completion): void;
  /** Every purpose and model that was asked, in the order each was first asked. */
  spent(): readonly Spend[];
}

export function createMeter(): Meter {
  // Insertion-ordered, which is the order the pipeline asked in — detection
  // first, then the model that drafted, then the seat that judged. A table
  // sorted by cost would put the run's story in an order it did not happen in.
  const spends = new Map<string, Spend>();

  const meter: Meter = {
    record(purpose, completion) {
      // Keyed on both, and the purposes are a closed set with no `::` in
      // them, so no model id can collide its way into another stage's row.
      const key = `${purpose}::${completion.model}`;
      const kept = spends.get(key) ?? {
        purpose,
        model: completion.model,
        endpoint: completion.endpoint ?? null,
        requests: 0,
        failed: 0,
        unreported: 0,
        prompt: 0,
        completion: 0,
      };
      const usage: Usage | null = completion.usage ?? null;

      spends.set(key, {
        ...kept,
        requests: kept.requests + 1,
        failed: kept.failed + (completion.ok ? 0 : 1),
        unreported: kept.unreported + (usage === null ? 1 : 0),
        prompt: kept.prompt + (usage?.prompt ?? 0),
        completion: kept.completion + (usage?.completion ?? 0),
      });
    },
    spent: () => [...spends.values()],
  };

  return meter;
}

/**
 * The same provider, with every request through it counted against one purpose.
 *
 * A decorator rather than a parameter on `complete`, because a purpose is a
 * property of the caller and not of the request: `draft` calls one provider and
 * every call it makes is drafting. Threading it through each call site would
 * put the same constant in three places and let one of them be wrong.
 */
export function metered(provider: Provider, meter: Meter, purpose: Purpose): Provider {
  return {
    async complete(model: string, messages: readonly Message[], options) {
      const completion = await provider.complete(model, messages, options);
      meter.record(purpose, completion);
      return completion;
    },
  };
}

export interface Totals {
  readonly requests: number;
  readonly failed: number;
  readonly unreported: number;
  readonly prompt: number;
  readonly completion: number;
}

/** The run's whole spend, for a reader who wants one number before the table. */
export function total(spent: readonly Spend[]): Totals {
  return {
    requests: spent.reduce((sum, entry) => sum + entry.requests, 0),
    failed: spent.reduce((sum, entry) => sum + entry.failed, 0),
    unreported: spent.reduce((sum, entry) => sum + entry.unreported, 0),
    prompt: spent.reduce((sum, entry) => sum + entry.prompt, 0),
    completion: spent.reduce((sum, entry) => sum + entry.completion, 0),
  };
}
