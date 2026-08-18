/**
 * Cron schedule matching for the dependa duty.
 *
 * A module of its own, and not because the expression grammar is complicated.
 * `main.ts` calls `run()` at import — every duty entry point does — so a test
 * that value-imports a helper from it starts the whole duty as a side effect
 * of being loaded: a real GitHub client, a real settings read, a real
 * `core.setFailed` writing into the worker that is trying to measure it. The
 * suite stayed green while that happened, which is the reason this file
 * exists: helpers a test needs live where a test can reach them without
 * starting a run.
 *
 * `cron.test.ts` imports from here. Nothing in here imports `main.ts`.
 */

/** Named-month aliases (case-insensitive). */
const CRON_MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Named-day-of-week aliases (case-insensitive). */
const CRON_DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Resolve a cron token to its numeric equivalent using an alias table. */
function resolveCronAlias(token: string, aliases: Record<string, number>): string {
  const lower = token.toLowerCase();
  if (lower in aliases) return String(aliases[lower]);
  return token;
}

/**
 * Check whether a single cron field matches the given value.
 * Supports: *, exact match, ranges (1-5), steps (star/2, 1-15/3),
 * comma lists (1,3,5), and named months/days via the aliases map.
 */
export function cronFieldMatches(
  field: string,
  value: number,
  max: number,
  aliases: Record<string, number> = {},
): boolean {
  // Resolve any named alias at the top level (e.g. "MON" → "1")
  const resolved = resolveCronAlias(field, aliases);
  if (resolved === "*") return true;
  if (resolved === String(value)) return true;
  // Handle comma-separated lists: "1,3,5" or "MON,WED,FRI"
  if (resolved.includes(",")) {
    return resolved.split(",").some((p) => cronFieldMatches(p.trim(), value, max, aliases));
  }
  // Handle steps: star/2, "1-15/3", "MON-FRI/2"
  if (resolved.includes("/")) {
    const slashParts = resolved.split("/");
    const range = slashParts[0] ?? "*";
    const stepStr = slashParts[1] ?? "1";
    const step = Number(stepStr);
    if (!Number.isSafeInteger(step) || step <= 0) return false;
    let lo = 0;
    let hi = max;
    if (range === "*") {
      // star/N — step from 0 to max
    } else if (range.includes("-")) {
      const rangeParts = range.split("-").map((s) => Number(resolveCronAlias(s, aliases)));
      lo = rangeParts[0] ?? 0;
      hi = rangeParts[1] ?? max;
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return false;
    } else {
      const start = Number(range);
      if (!Number.isSafeInteger(start)) return false;
      lo = start;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  }
  // Handle ranges: "1-5", "MON-FRI"
  if (resolved.includes("-")) {
    const rangeParts = resolved.split("-").map((s) => Number(resolveCronAlias(s, aliases)));
    const lo = rangeParts[0] ?? 0;
    const hi = rangeParts[1] ?? 0;
    return value >= lo && value <= hi;
  }
  return false;
}

/**
 * Check whether a 5-field cron expression matches the given date.
 * Returns true if the expression matches, false otherwise.
 * Returns true (degrades gracefully) for malformed expressions.
 */
export function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return true; // degrade gracefully

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  const minuteMatch = cronFieldMatches(minute, date.getMinutes(), 59);
  const hourMatch = cronFieldMatches(hour, date.getHours(), 23);
  // Month check (1-indexed in cron, 0-indexed in JS)
  const monthMatch = cronFieldMatches(month, date.getMonth() + 1, 12, CRON_MONTH_NAMES);
  // Day-of-month check
  const domMatch = cronFieldMatches(dom, date.getDate(), 31);
  // Day-of-week check (0 = Sunday in cron, 0 = Sunday in JS)
  const dowMatch = cronFieldMatches(dow, date.getDay(), 6, CRON_DOW_NAMES);

  // Standard cron DOM/DOW semantics:
  // - Both unrestricted (*) → always true
  // - Only DOM restricted → use domMatch only
  // - Only DOW restricted → use dowMatch only
  // - Both restricted → either match is sufficient (OR)
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const dayMatch =
    !domRestricted && !dowRestricted
      ? true
      : domRestricted && !dowRestricted
        ? domMatch
        : !domRestricted && dowRestricted
          ? dowMatch
          : domMatch || dowMatch;

  return minuteMatch && hourMatch && monthMatch && dayMatch;
}
