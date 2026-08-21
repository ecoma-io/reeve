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
 * The byte-order tie-break is the second half, and it is locale-independent:
 * the collator calls `1.0` and `01.0` equal under `numeric`, `Array.sort` is
 * stable, so the head fell to whatever order the registry happened to list.
 * Both parse to the same version, and `main.ts` skips a candidate only when
 * the target **string** equals the current one — so a repository pinned at
 * `1.0` could be sent a pull request moving it to `01.0`. Docker tags and git
 * tags both permit the leading zero. A total order has no such tie to leak.
 */
export function byVersionDescending(a: Release, b: Release): number {
  const collated = b.version.localeCompare(a.version, "en-US", { numeric: true });
  if (collated !== 0) return collated;
  return b.version < a.version ? -1 : b.version > a.version ? 1 : 0;
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
