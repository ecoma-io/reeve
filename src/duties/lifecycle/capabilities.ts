/**
 * `lifecycle`'s default, pulled out of `main.ts` so it can be read without
 * running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing lifecycle itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/** `lifecycle`'s own default, once a `lifecycle:` policy exists and no `capabilities:` block says otherwise. */
export const DEFAULT_CAPABILITIES: readonly Capability[] = ["label", "comment"];
