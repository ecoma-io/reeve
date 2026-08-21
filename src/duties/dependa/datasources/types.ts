/**
 * The datasource interface — how `dependa` resolves available versions.
 *
 * Each datasource wraps one kind of registry. It makes network calls
 * (fetching available versions), and those calls are subject to D12:
 * a capacity error degrades to `temporarily-unavailable`, an auth error
 * propagates. A datasource that cannot reach its registry returns a
 * degraded result, not an error — D12: capacity is weather.
 *
 * A new ecosystem adds one datasource file and registers it in `registry.ts`.
 * No other module changes.
 */
import type { Ecosystem, Release, ResolutionResult } from "../model.js";

/**
 * Newest first, and the same answer on every runner.
 *
 * This ordering is not presentation. `semver.ts`'s `highestSatisfying` and
 * `latestAvailable` do not compute a maximum — they take the first entry that
 * fits, and say so — so the order a datasource returns **is** the version
 * dependa proposes in somebody's pull request.
 *
 * Every datasource used to spell this as
 * `b.version.localeCompare(a.version, undefined, { numeric: true })`, six
 * identical copies, and the `undefined` was a bug in all six. It means the
 * process default locale, which Node reads from `LC_ALL`/`LANG` — and Reeve
 * runs inside other people's workflows, where a job-level `env: LANG:` is
 * ordinary. Measured, same input, same commit, same warrant:
 *
 * - `cs_CZ` collates `ch` after `h`, so `21-chiselled` sorts above `21-cs`
 *   where `en_US` puts `21-cs` first;
 * - `da_DK` collates `aa` as `å`, which sorts `1.0.0-aardvark` newest;
 * - `et_EE` collates `z` between `t` and `u`.
 *
 * So the locale is named. `en-US` is the invariant this repository already
 * uses for the same reason in `core/summary.ts`, and it is what an unset
 * `LANG` resolves to on a runner — which is why naming it changes no answer
 * on the ordinary configuration and removes the variance on the rest.
 *
 * The tie-break is the second half, and it is locale-independent. The collator
 * calls `1.0` and `01.0` equal under `numeric`, `Array.sort` is stable, so the
 * head fell to whatever order the registry happened to list. Both parse to the
 * same version, and `main.ts` skips a candidate only when the target **string**
 * equals the current one — so a repository pinned at `1.0` could be sent a pull
 * request moving it to `01.0`, which changes nothing and has to be reviewed
 * and closed by a human. Docker tags and git tags both permit the padding.
 *
 * **Which side the tie breaks toward is the whole of it, and byte order is the
 * wrong answer.** Descending byte order puts `1.0` above `01.0` — the leading
 * zero the paragraph above complains about — and `1.00` above `1.0`, so it
 * fixes one spelling of the padding and guarantees the other. Trailing zeros
 * are at least as common as leading ones in both tag grammars, so that trades
 * a bug that happened when the registry listed unluckily for one that happens
 * every time.
 *
 * So the tie breaks toward the **shortest** spelling, which is the canonical
 * one: `1.0` sorts above `01.0`, `1.00` and `1.000` alike. Length first, then
 * byte order among equal lengths so the comparator stays a total order — with
 * no unbroken tie there is nothing left for the registry's listing to decide.
 */
export function byVersionDescending(a: Release, b: Release): number {
  const collated = b.version.localeCompare(a.version, "en-US", { numeric: true });
  if (collated !== 0) return collated;
  if (a.version.length !== b.version.length) return a.version.length - b.version.length;
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

/**
 * Parse a release date out of whatever a registry put in its date field.
 *
 * Every datasource needs this and every datasource spelled it the same way:
 * `new Date(value)`, rejected when it comes out `Invalid Date`. The `unknown`
 * parameter and the `typeof` guard are npm's — a registry response is parsed
 * JSON, so a field the schema says is a string can arrive as a number, a null
 * or an object, and `new Date(null)` is the epoch rather than a failure. The
 * guard is the safe superset: for a string it does nothing at all, so the four
 * datasources that hand-checked the type before calling get the same answer.
 *
 * Returns `null` when the value is not a date, never a `Date` that lies.
 */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;

  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date;
  } catch {
    // Not a valid date
  }

  return null;
}

/**
 * Convert a fetch error to a `temporarily-unavailable` result.
 *
 * D12: capacity is weather. A registry that cannot be reached is a degraded
 * result carrying the reason, not a thrown error — the run continues and says
 * what it could not see. `source` names the registry in the reason, which is
 * the only thing that ever differed between the five copies of this.
 */
export function temporarilyUnavailable(source: string, error: unknown): ResolutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "temporarily-unavailable",
    reason: `${source} unreachable: ${message}`,
  };
}

/**
 * The stable identifier for a datasource. Part of the closed set — a name
 * not registered here is refused.
 */
export type DatasourceId =
  "npm" | "github-tags" | "crates" | "go-proxy" | "docker-registry" | "node-version";

/**
 * The abstraction for version resolution.
 *
 * Each datasource knows how to fetch available versions for one kind of
 * registry. The interface is intentionally narrow: it resolves versions, it
 * does not install them, test them, or decide about them. Those are later
 * pipeline stages.
 *
 * No network call is made during registration. A datasource is called only
 * when dependa has a concrete Dependency whose `ecosystem` field names it.
 */
export interface Datasource {
  /** The stable identifier for this datasource. */
  readonly id: DatasourceId;
  /** The ecosystem this datasource serves. */
  readonly ecosystem: Ecosystem;
  /**
   * Resolves available versions for `packageName`.
   *
   * Returns `ResolutionResult` — either available releases, or one of the
   * explicit failure states. A datasource that cannot reach its registry
   * returns `{ status: "temporarily-unavailable", reason }` rather than
   * throwing — D12: capacity is weather, not a failure.
   */
  resolve(packageName: string): Promise<ResolutionResult>;
}
