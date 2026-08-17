/**
 * `triage`'s cheapest-reversible-action default, pulled out of `main.ts` so it
 * can be read without running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing triage itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/**
 * What this duty may do when the warrant says nothing about it.
 *
 * A label, and nothing else. It is the only effect that is one click to undo,
 * and the default belongs to the duty rather than to the warrant reader because
 * only this duty knows what its cheapest reversible action is.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = ["label"];

/**
 * The full ladder this duty ever asks for — anything else a warrant names
 * for it is inert here, not an error; see `Warrant.granted`'s own doc
 * comment for why a per-duty enumeration is not this module's to validate.
 * Exported so `doctor` mode can apply the exact same narrowing a real run
 * applies, rather than a second guess at which capabilities this duty
 * actually has a use for. The read-set is every `permitted.includes()`
 * `triage`'s runtime applies: `label` (apply decisions), `comment` (post the
 * rationale), `close` (duplicate verdicts), `assign` (ownership), `record`
 * (correction state), `propose` (model proposal), `open-pr` (record to a
 * state branch).
 */
export const TRIAGE_CAPABILITIES: readonly Capability[] = [
  "label",
  "comment",
  "close",
  "assign",
  "record",
  "propose",
  "open-pr",
];
