/**
 * What this duty may do when the warrant says nothing about it.
 *
 * Nothing. `edit-file` and `open-pr` give this duty the ability to commit
 * files and open pull requests — qualitatively more authority than `label`
 * or `edit-body`. At level 0, with no warrant file at all, this must NOT be
 * granted implicitly. A maintainer who wants `dependa` to open dependency
 * update PRs must write `dependa: [edit-file, open-pr]` in the warrant's
 * `duties:` block.
 *
 * Pulled out of `main.ts` so it can be read without running the duty —
 * see `harmonise/capabilities.ts` for the same pattern and its reason.
 */
import type { Capability } from "../../core/warrant.js";

export const DEFAULT_CAPABILITIES: readonly Capability[] = [];
