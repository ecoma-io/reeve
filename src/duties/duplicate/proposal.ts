/**
 * The last pure step of a verdict: checking it against the exact shortlist
 * the judge was shown, and — only once that holds — computing the fingerprint
 * and assembling the proposal a confident verdict would publish.
 *
 * Pure and `@actions/core`-free, the same house rule every other pipeline
 * module in this duty follows: `decide` in `main.ts` owns the warning and the
 * info line this module's answer implies, this module owns only the
 * computation those lines report on.
 */
import { sanitize } from "../../core/sanitize.js";

import { proposalFingerprint, type Attribution, type Proposal } from "./publish.js";
import type { Ranked } from "./rank.js";

/** What checking a verdict's `duplicateOf` against the shortlist settled. */
export type ShortlistMatch =
  /**
   * The verdict named a thread outside the shortlist it was shown.
   * `parseVerdict` already refuses a `duplicate_of` that does not name one of
   * the `candidates` it was given — that is what makes an injected "this
   * duplicates #999" in a thread body unable to steer a verdict at a thread
   * the ranking never surfaced. This re-checks the same fact against
   * `ranked` — the exact shortlist the call passed as those `candidates` —
   * on purpose: the number that reaches `Outcome`, an output, or a published
   * comment must be traceable to a candidate this run's own ranking
   * offered, not merely to a candidate `verdict.ts` was trusted to have
   * checked. A miss here can only mean that invariant broke somewhere
   * upstream, and the right response to that is the same as an unparseable
   * answer — discard, never best-effort — not to fall back to a `0` score
   * and publish anyway.
   */
  | { readonly ok: false }
  | {
      readonly ok: true;
      /** The BM25 score that put the matched candidate in front of the judge. */
      readonly lexicalScore: number;
      /** The verdict's own rationale, already sanitised. */
      readonly rationale: string;
      /** Whether `confidence` clears the floor — `proposal` is null when it does not. */
      readonly eligible: boolean;
      /** The fingerprint `proposal` was computed against. Null whenever `proposal` is. */
      readonly fingerprint: string | null;
      readonly proposal: Proposal | null;
    };

/**
 * Re-validates `duplicateOf` against `ranked`, then — only for a match —
 * computes the fingerprint and assembles the proposal a confident verdict
 * would publish. See `ShortlistMatch`'s own doc comment for why the
 * re-validation exists at all.
 */
export function matchShortlist(
  duplicateOf: number,
  confidence: number,
  rawRationale: string,
  ranked: readonly Ranked[],
  query: string,
  confidenceFloor: number,
  attribution: Attribution,
  model: string,
  language: string | null,
): ShortlistMatch {
  const matched = ranked.find((entry) => entry.candidate.number === duplicateOf);
  if (matched === undefined) return { ok: false };

  const lexicalScore = matched.score;
  // Sanitised once, used both by `proposal` below (only when eligible) and by
  // `Outcome.rationale` (always, once a verdict named a candidate the
  // shortlist actually offered) — a report-only run under the floor still
  // owes a reader *why*, which `proposal` alone cannot answer since it is
  // null there.
  const rationale = sanitize(rawRationale);
  const eligible = confidence >= confidenceFloor;

  // Over the thread's own text and the shortlist the judge was actually
  // shown — see `proposalFingerprint`'s own doc comment for why that, and not
  // the static config knobs that produced the shortlist, is what makes a
  // grown corpus re-ask and an identical rerun stop.
  const fp = proposalFingerprint(
    query,
    ranked.map((entry) => entry.candidate.number),
  );

  const proposal: Proposal | null = eligible
    ? {
        duplicateOf,
        confidence,
        lexicalScore,
        rationale,
        model,
        attribution,
        // The judge writes `rationale` in the thread's own language (see
        // `verdict.ts`'s `prompt`), so this comment's fixed lines follow the
        // same code — not the pivot language cross-language corpus matching
        // uses.
        language,
      }
    : null;

  return {
    ok: true,
    lexicalScore,
    rationale,
    eligible,
    // Under the floor, `duplicate-of`/`score` still answer, but there is
    // nothing eligible to fingerprint against a write that will never happen.
    fingerprint: eligible ? fp : null,
    proposal,
  };
}
