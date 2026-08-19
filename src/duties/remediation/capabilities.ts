/**
 * `remediation`'s default, pulled out of `main.ts` so it can be read without
 * running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing remediation itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/**
 * What this duty may do when the warrant says nothing about it: nothing.
 *
 * Every remediation proposal this duty derives is a public record of what
 * `review` claimed, and `review` itself is granted nothing on any default —
 * the same reasoning lands here, one rung down: a run proposes only where the
 * warrant's `duties:` block explicitly grants `propose`, and a run denied the
 * grant still decides and reports on the job summary and its outputs.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [];

/**
 * The full ladder this duty ever asks for — anything else a warrant names
 * for it is inert here, or refused red; see `Warrant.granted`'s own doc
 * comment for why a per-duty enumeration is not this module's to validate.
 * Exported so `doctor` mode can apply the exact same narrowing a real run
 * applies, rather than a second guess at which capabilities this duty
 * actually has a use for. `propose` is the one capability deriving a
 * remediation proposal uses; `edit-file` and `open-pr` are deliberately
 * absent — they are the future fixing-PR stage, and a run granted them fails
 * red (see `main.ts`).
 */
export const REMEDIATION_CAPABILITIES: readonly Capability[] = ["propose"];
