/**
 * The separator convention every list-shaped input shares.
 *
 * `languages`, `models` and `judge-models` are all written the same way, and
 * they are written that way because a workflow file makes a one-line value easy
 * and a multi-line value readable, and consumers reach for both. One function
 * so the three inputs cannot drift into three conventions.
 */

/**
 * Splits a newline- or comma-separated input into trimmed, non-empty entries.
 *
 * Blank lines and trailing separators are dropped rather than refused: a YAML
 * block scalar ends with a newline, and `a,` is what an editor leaves behind
 * mid-edit. Neither is an error worth failing a run over.
 */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
