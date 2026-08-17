/**
 * `translate`'s default, pulled out of `main.ts` so it can be read without
 * running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing translate itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/**
 * What this duty may do when the warrant says nothing about it.
 *
 * `edit-body` and nothing else — it is the only thing this duty has ever
 * done, and the default belongs here rather than in the warrant reader
 * because only this duty knows that editing the body is the whole of its
 * work.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = ["edit-body"];

/**
 * The full ladder this duty ever asks for — anything else a warrant names
 * for it is inert here, not an error; see `Warrant.granted`'s own doc
 * comment for why a per-duty enumeration is not this module's to validate.
 * Exported so `doctor` mode can apply the exact same narrowing a real run
 * applies, rather than a second guess at which capabilities this duty
 * actually has a use for. The read-set is every `permitted.includes()`
 * `translate`'s runtime applies: `edit-body` is the one thing the duty has
 * ever done.
 */
export const TRANSLATE_CAPABILITIES: readonly Capability[] = ["edit-body"];
