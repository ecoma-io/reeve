/**
 * Tests for the datasource registry.
 *
 * The datasource registry maps ecosystems to datasources. Tests cover
 * registration, lookup by ID, lookup by ecosystem, and duplicate rejection.
 */
import { describe, expect, it } from "vitest";

import type { Datasource } from "./types.js";

import { DatasourceRegistry } from "./registry.js";

function stubDatasource(id: Datasource["id"], ecosystem: Datasource["ecosystem"]): Datasource {
  return {
    id,
    ecosystem,
    resolve: () => Promise.resolve({ status: "available", releases: [] }),
  };
}

describe("DatasourceRegistry", () => {
  it("registers datasources by ID", () => {
    const registry = new DatasourceRegistry([stubDatasource("npm", "npm")]);
    expect(registry.get("npm")).toBeDefined();
  });

  it("looks up by ecosystem", () => {
    const registry = new DatasourceRegistry([stubDatasource("npm", "npm")]);
    expect(registry.forEcosystem("npm")).toBeDefined();
    expect(registry.forEcosystem("cargo")).toBeUndefined();
  });

  it("rejects duplicate datasource IDs", () => {
    expect(
      () => new DatasourceRegistry([stubDatasource("npm", "npm"), stubDatasource("npm", "npm")]),
    ).toThrow("registered more than once");
  });

  it("lists all datasources", () => {
    const registry = new DatasourceRegistry([
      stubDatasource("npm", "npm"),
      stubDatasource("crates", "cargo"),
    ]);
    expect(registry.all()).toHaveLength(2);
  });

  it("maps each ecosystem to its datasource", () => {
    const registry = new DatasourceRegistry([
      stubDatasource("npm", "npm"),
      stubDatasource("github-tags", "github-actions"),
      stubDatasource("crates", "cargo"),
      stubDatasource("go-proxy", "go"),
      stubDatasource("docker-registry", "docker"),
    ]);

    expect(registry.forEcosystem("npm")?.id).toBe("npm");
    expect(registry.forEcosystem("github-actions")?.id).toBe("github-tags");
    expect(registry.forEcosystem("cargo")?.id).toBe("crates");
    expect(registry.forEcosystem("go")?.id).toBe("go-proxy");
    expect(registry.forEcosystem("docker")?.id).toBe("docker-registry");
  });
});
