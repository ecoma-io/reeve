/**
 * The datasource registry.
 *
 * Like the manager registry, this is static. Each datasource wraps one kind
 * of registry. It makes network calls (fetching available versions), and
 * those calls are subject to D12: a capacity error degrades to a partial
 * result, an auth error propagates.
 *
 * Datasource calls are metered through the same Meter every other duty uses.
 * dependa does not get a free pass on API calls.
 */
import type { Ecosystem } from "../model.js";
import type { Datasource, DatasourceId } from "./types.js";

export class DatasourceRegistry {
  private readonly datasources: ReadonlyMap<DatasourceId, Datasource>;
  /** Index from ecosystem to the datasource that serves it. */
  private readonly byEcosystem: ReadonlyMap<Ecosystem, Datasource>;

  constructor(datasources: readonly Datasource[]) {
    const map = new Map<DatasourceId, Datasource>();
    const ecoMap = new Map<Ecosystem, Datasource>();
    for (const ds of datasources) {
      if (map.has(ds.id)) {
        throw new Error(`dependa: datasource \`${ds.id}\` registered more than once.`);
      }
      map.set(ds.id, ds);
      // Last-writer-wins if multiple datasources serve the same ecosystem,
      // but in practice each ecosystem has exactly one datasource.
      ecoMap.set(ds.ecosystem, ds);
    }
    this.datasources = map;
    this.byEcosystem = ecoMap;
  }

  /** Get a datasource by its stable identifier. */
  get(id: DatasourceId): Datasource | undefined {
    return this.datasources.get(id);
  }

  /** Get the datasource that serves a given ecosystem. */
  forEcosystem(ecosystem: Ecosystem): Datasource | undefined {
    return this.byEcosystem.get(ecosystem);
  }

  /** All registered datasources. */
  all(): readonly Datasource[] {
    return Array.from(this.datasources.values());
  }
}
