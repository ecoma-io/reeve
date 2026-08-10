/**
 * The scoring machinery every duty shares. The measurements themselves belong
 * to the duty.
 *
 * Scoring is not the optional quality tier — it is the part that makes a free
 * endpoint usable. A consumer pointing `base-url` at whatever they can run for
 * nothing gets a model that sometimes answers in the wrong language, sometimes
 * rewrites the contents of a code block, and sometimes returns its input
 * unchanged. None of those need a model to spot, and a pipeline that only
 * catches them by spending a second request has priced quality out of exactly
 * the setup Reeve is built for.
 *
 * **Admissibility and rank are different answers, and keeping them apart is the
 * whole design.** A draft is inadmissible only for something provable. Anything
 * short of provable lowers the rank instead. There is deliberately no minimum
 * score a draft must clear, because that number would be invented rather than
 * derived — a caller has the real question (is there a better draft than this
 * one?) and answers it by comparing, which needs no threshold at all.
 *
 * A judge only ever ranks what this stage admitted. A candidate refused here is
 * gone, and no later stage may bring it back.
 */

/** One measurement, kept nameable so a run can say what a draft lost. */
export interface Check {
  /** What was measured. Named by the duty, and shown in a log. */
  readonly name: string;
  /**
   * How much this measurement moves the rank, relative to the others in the
   * same set. Carried on the check rather than looked up in a table, so a duty
   * that adds a measurement cannot add it without deciding what it is worth.
   */
  readonly weight: number;
  /** 0 to 1. */
  readonly value: number;
  /** What was measured, in words, whatever the value. */
  readonly note: string;
}

export interface Score {
  /** The weighted mean of the checks, or 0 when the draft is inadmissible. */
  readonly value: number;
  /** False only for a failure that is provable rather than measured. */
  readonly admissible: boolean;
  /** Which rule refused it, or null when none did. */
  readonly reason: string | null;
  readonly checks: readonly Check[];
}

/** A draft that broke a rule rather than merely scoring badly. */
export function refused(reason: string): Score {
  return { value: 0, admissible: false, reason, checks: [] };
}

/** A draft that survived every refusal, ranked on what was measured. */
export function measured(checks: readonly Check[]): Score {
  let weighted = 0;
  let total = 0;
  for (const check of checks) {
    weighted += check.value * check.weight;
    total += check.weight;
  }
  // No checks is a perfect score rather than a division by zero: a duty that
  // measures nothing has refused nothing either, and every candidate is equal.
  return { value: total === 0 ? 1 : weighted / total, admissible: true, reason: null, checks };
}

/** How many of `before`'s entries `after` also has, counting duplicates once each. */
export function shared(before: readonly string[], after: readonly string[]): number {
  const remaining = new Map<string, number>();
  for (const entry of after) remaining.set(entry, (remaining.get(entry) ?? 0) + 1);

  let matched = 0;
  for (const entry of before) {
    const left = remaining.get(entry) ?? 0;
    if (left === 0) continue;
    remaining.set(entry, left - 1);
    matched += 1;
  }
  return matched;
}

/**
 * Agreement between two multisets, counted against everything either side has.
 *
 * Symmetric on purpose: a draft that dropped one of the source's two code
 * blocks and a draft that invented a third are both wrong, and a measure that
 * only looked for what the source had would score the second one perfect.
 */
export function overlap(before: readonly string[], after: readonly string[]): number {
  const both = shared(before, after);
  const either = before.length + after.length - both;
  return either === 0 ? 1 : both / either;
}
