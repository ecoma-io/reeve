/**
 * `review`'s default, pulled out of `main.ts` so it can be read without
 * running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing review itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/**
 * What this duty may do when the warrant says nothing about it: nothing.
 *
 * Every review comment a model produces is a public claim about a pull
 * request, read by everybody who reads the thread, and there is no cheap,
 * reversible version of publishing one as though the project reviewed it. So
 * the fallback here is the empty list, the same reasoning `respond`'s own
 * `DEFAULT_CAPABILITIES` rests on — review decides and reports on the job
 * summary and its outputs, and writes a comment only when the warrant's
 * `duties:` block explicitly grants `comment`.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [];
