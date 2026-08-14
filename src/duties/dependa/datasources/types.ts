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
import type { Ecosystem, ResolutionResult } from "../model.js";

/**
 * The stable identifier for a datasource. Part of the closed set — a name
 * not registered here is refused.
 */
export type DatasourceId = "npm" | "github-tags" | "crates" | "go-proxy" | "docker-registry";

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
