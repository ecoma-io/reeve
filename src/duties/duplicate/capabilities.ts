/**
 * `duplicate`'s default, pulled out of `main.ts` so it can be read without
 * running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing duplicate itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/**
 * What this duty may do when the warrant says nothing about it: nothing.
 *
 * Unlike triage's cheapest-reversible-action default, there is no capability
 * here worth granting for free. A label a run got wrong costs one click to
 * remove; a comment naming the wrong thread as a duplicate is a claim posted
 * in public about somebody else's report, and that is not a default a duty
 * should reach for on a repository that never wrote an opinion about it.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [];
