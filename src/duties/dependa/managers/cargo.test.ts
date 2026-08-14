/**
 * Tests for the Cargo manager — dependency discovery from Cargo.toml.
 *
 * Deterministic: same Cargo.toml content produces the same Dependency list.
 * Tests cover TOML table extraction, constraint resolution (simple, detailed,
 * git, path), lockfile resolution, and applyUpdate.
 */
import { describe, expect, it } from "vitest";

import { createCargoManager } from "./cargo.js";

const manager = createCargoManager();

// ── parse: basic discovery ───────────────────────────────────────────────

describe("cargo parse", () => {
  it("discovers dependencies from [dependencies]", () => {
    const content = `
[package]
name = "my-app"
version = "0.1.0"

[dependencies]
serde = "1.0"
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("serde");
    expect(result.dependencies[0]?.constraint).toBe("1.0");
    expect(result.dependencies[0]?.dev).toBe(false);
    expect(result.dependencies[0]?.ecosystem).toBe("cargo");
  });

  it("discovers dev-dependencies", () => {
    const content = `
[dev-dependencies]
tokio-test = "0.4"
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.dev).toBe(true);
  });

  it("discovers build-dependencies", () => {
    const content = `
[build-dependencies]
cc = "1.0"
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.dev).toBe(false);
  });

  it('handles detailed table syntax { version = "..." }', () => {
    const content = `
[dependencies]
serde = { version = "1.0", features = ["derive"] }
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBe("1.0");
  });

  it("marks git dependencies as null constraint", () => {
    const content = `
[dependencies]
my-lib = { git = "https://github.com/owner/my-lib" }
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBeNull();
    expect(result.dependencies[0]?.currentVersion).toBe("");
  });

  it("marks path dependencies as null constraint", () => {
    const content = `
[dependencies]
my-lib = { path = "../my-lib" }
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBeNull();
  });

  it("resolves from Cargo.lock", () => {
    const content = `
[dependencies]
serde = "1.0"
`;

    const lockfile = `
[[package]]
name = "serde"
version = "1.0.195"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

    const result = manager.parse("Cargo.toml", content, lockfile);
    expect(result.dependencies[0]?.currentVersion).toBe("1.0.195");
  });

  it("marks partial when lockfile is present but cannot be parsed", () => {
    const content = `
[dependencies]
serde = "1.0"
`;
    const result = manager.parse("Cargo.toml", content, "not valid lockfile");
    expect(result.partial).toBe(true);
  });

  it("extracts pinned version from exact constraint when no lockfile", () => {
    const content = `
[dependencies]
serde = "1.0.195"
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies[0]?.currentVersion).toBe("1.0.195");
  });

  it("skips comments in TOML", () => {
    const content = `
[dependencies]
# serde = "1.0"
tokio = "1.0"
`;

    const result = manager.parse("Cargo.toml", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("tokio");
  });
});

// ── applyUpdate ──────────────────────────────────────────────────────────

describe("cargo applyUpdate", () => {
  const baseProposal = {
    releases: [] as const,
    securityAdvisory: null,
    risk: {
      facts: {
        updateType: "patch" as const,
        majorDistance: 0,
        minorDistance: 0,
        patchDistance: 1,
        daysBetweenReleases: null,
        currentVersionStale: null,
        isSecurity: false,
        hasChangelog: false,
        isDev: false,
      },
      interpretation: null,
    },
    evidence: [] as const,
    edits: [] as const,
    groupName: null,
  };

  it("updates a simple version string", () => {
    const content = `
[dependencies]
serde = "1.0.195"
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "cargo",
        name: "serde",
        constraint: "1.0.195",
        currentVersion: "1.0.195",
        manifestPath: "Cargo.toml",
        dev: false,
        manager: "cargo",
      },
      currentVersion: "1.0.195",
      targetVersion: "1.0.196",
      updateType: "patch",
    });

    expect(result).not.toBeNull();
    expect(result).toContain('"1.0.196"');
    expect(result).not.toContain('"1.0.195"');
  });

  it("updates version in inline table", () => {
    const content = `
[dependencies]
serde = { version = "1.0.195", features = ["derive"] }
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "cargo",
        name: "serde",
        constraint: "1.0.195",
        currentVersion: "1.0.195",
        manifestPath: "Cargo.toml",
        dev: false,
        manager: "cargo",
      },
      currentVersion: "1.0.195",
      targetVersion: "1.0.196",
      updateType: "patch",
    });

    expect(result).not.toBeNull();
    expect(result).toContain('version = "1.0.196"');
    expect(result).toContain("features");
  });

  it("returns null when dependency not found", () => {
    const content = `
[dependencies]
tokio = "1.0"
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "cargo",
        name: "serde",
        constraint: "1.0",
        currentVersion: "1.0",
        manifestPath: "Cargo.toml",
        dev: false,
        manager: "cargo",
      },
      currentVersion: "1.0",
      targetVersion: "1.1",
      updateType: "minor",
    });

    expect(result).toBeNull();
  });

  it("preserves other TOML sections", () => {
    const content = `
[package]
name = "my-app"

[dependencies]
serde = "1.0"

[dev-dependencies]
tokio = "1.0"
`;

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "cargo",
        name: "serde",
        constraint: "1.0",
        currentVersion: "1.0",
        manifestPath: "Cargo.toml",
        dev: false,
        manager: "cargo",
      },
      currentVersion: "1.0",
      targetVersion: "1.1",
      updateType: "minor",
    });

    expect(result).toContain("my-app");
    expect(result).toContain("tokio");
  });
});
