/**
 * `harmonise`'s empty default, pulled out of `main.ts` so it can be read
 * without running the duty.
 *
 * `main.ts` calls `run()` at import time — see `vitest.config.ts`'s coverage
 * exclusion for why — so it cannot be the module doctor mode imports this
 * from without executing harmonise itself. This file has no such side effect.
 */
import type { Capability } from "../../core/warrant.js";

/**
 * What this duty may do when the warrant says nothing about it.
 *
 * Nothing. `edit-file` and `open-pr` give this duty the ability to commit
 * files and open pull requests — qualitatively more authority than `label`
 * or `edit-body`. At level 0, with no warrant file at all, this must NOT be
 * granted implicitly. A maintainer who wants `harmonise` to open sync PRs
 * must write `harmonise: [edit-file, open-pr]` in the warrant's
 * `capabilities:` block.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [];
