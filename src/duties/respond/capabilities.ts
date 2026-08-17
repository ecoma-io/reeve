/**
 * `respond`'s default, pulled out of `main.ts` so it can be read without
 * running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing respond itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/**
 * What this duty may do when the warrant says nothing about it: nothing.
 *
 * Every other duty in this repository has a cheapest reversible default —
 * triage falls back to `label`, translate to `edit-body` — because the file
 * being silent about a duty a maintainer has never heard of is not the same
 * fact as the file having decided against it. A first reply has no such
 * default: there is no cheap, reversible version of "post a comment that
 * reads as this project speaking". So the fallback here is the empty list,
 * and it is what makes both the implicit warrant (no file at all) and a
 * written file that is merely silent about `respond` hand back nothing —
 * see `Warrant.granted`'s doc comment in `core/warrant.ts` for why both
 * shapes resolve through the same `fallback` argument.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [];

/**
 * The full ladder this duty ever asks for — anything else a warrant names
 * for it is inert here, not an error; see `Warrant.granted`'s own doc
 * comment for why a per-duty enumeration is not this module's to validate.
 * Exported so `doctor` mode can apply the exact same narrowing a real run
 * applies, rather than a second guess at which capabilities this duty
 * actually has a use for. The read-set is every `permitted.includes()`
 * `respond`'s runtime applies: `comment` is the whole of posting a first
 * reply.
 */
export const RESPOND_CAPABILITIES: readonly Capability[] = ["comment"];
