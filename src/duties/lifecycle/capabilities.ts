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

/**
 * The full ladder this duty ever asks for — anything else a warrant names
 * for it is inert here, not an error; see `Warrant.granted`'s own doc
 * comment for why a per-duty enumeration is not this module's to validate.
 * Exported so `doctor` mode can apply the exact same narrowing a real run
 * applies, rather than a second guess at which capabilities this duty
 * actually has a use for.
 */
export const LIFECYCLE_CAPABILITIES: readonly Capability[] = ["label", "comment", "close"];
