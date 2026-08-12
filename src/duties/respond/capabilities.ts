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
