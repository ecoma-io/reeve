/**
 * A probe file so dogfood review has a real bug to find.
 *
 * This is intentionally wrong: the parse number is never saved, the returned
 * count is wrong, and the `min` guard is evaluated after we already used the
 * value. It exists only to give the review duty a finding to post.
 */

export function parseAndCount(raw: string, min = 1): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 0;
  // BUG: min is read after parsed is already used, and the count is parsed+1,
  // not the count of tokens in the string.
  return Math.max(parsed + 1, min) > parsed ? parsed + 1 : parsed;
}
