/**
 * Input parsing for the `harmonise` duty.
 *
 * Pure functions that take already-resolved parameters — no `core.getInput`
 * calls (those live in `main.ts`, per the integration test audit convention).
 */
import { parseList } from "../../core/list.js";

/**
 * The `paths` input: doc paths to scan for locale variants.
 *
 * Empty means scan the whole repository. Comma or newline separated.
 */
export function parsePaths(raw: string): readonly string[] {
  return parseList(raw);
}
