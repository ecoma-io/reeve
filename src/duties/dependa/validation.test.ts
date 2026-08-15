/**
 * Tests for the dependa validation module.
 *
 * Validation is a safety gate: every edit must survive a round-trip check
 * before it can be committed. These tests cover path safety, content safety,
 * ecosystem-specific validation, and the conversion to refusals.
 *
 * Deterministic: same edits, same result. No network, no model.
 */
import { describe, expect, it } from "vitest";

import { validateEdits, validationRefusals, type FailedEdit } from "./validation.js";
import type { FileEdit } from "./model.js";

// ── helpers ──────────────────────────────────────────────────────────────

function edit(path: string, content: string): FileEdit {
  return { path, content, message: `update ${path}` };
}

// ── validateEdits — path safety ──────────────────────────────────────────

describe("validateEdits — path safety", () => {
  it("rejects an absolute path", () => {
    const result = validateEdits([edit("/etc/passwd", "harmless")]);
    expect(result.valid).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain("absolute");
  });

  it("rejects path traversal", () => {
    const result = validateEdits([edit("../../secrets", "harmless")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("traversal");
  });

  it("rejects empty path", () => {
    const result = validateEdits([edit("", "harmless")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("empty");
  });

  it("accepts a normal relative path", () => {
    const result = validateEdits([edit("src/package.json", "{}")]);
    expect(result.valid).toBe(true);
    expect(result.passed).toHaveLength(1);
  });
});

// ── validateEdits — content safety ───────────────────────────────────────

describe("validateEdits — content safety", () => {
  it("rejects empty content (would delete the file)", () => {
    const result = validateEdits([edit("package.json", "")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("content is empty");
  });

  it("accepts content that is only whitespace", () => {
    // Whitespace-only is not empty — it's malformed, but emptiness is the gate
    const result = validateEdits([edit("unknown.txt", "   ")]);
    expect(result.valid).toBe(true);
  });
});

// ── validateEdits — npm ──────────────────────────────────────────────────

describe("validateEdits — npm (package.json)", () => {
  it("accepts valid package.json", () => {
    const result = validateEdits([edit("package.json", '{"name":"test","version":"1.0.0"}')]);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = validateEdits([edit("package.json", "not json at all")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("not valid JSON");
  });

  it("rejects JSON that is not an object", () => {
    const result = validateEdits([edit("package.json", "42")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("not a JSON object");
  });

  it("rejects JSON null", () => {
    const result = validateEdits([edit("package.json", "null")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("not a JSON object");
  });

  it("rejects JSON array (not an object)", () => {
    const result = validateEdits([edit("package.json", "[1,2,3]")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("not a JSON object");
  });

  it("accepts package.json without a name field", () => {
    const result = validateEdits([edit("package.json", '{"dependencies":{}}')]);
    expect(result.valid).toBe(true);
  });

  it("validates nested package.json", () => {
    const result = validateEdits([edit("packages/app/package.json", '{"name":"@scope/app"}')]);
    expect(result.valid).toBe(true);
  });
});

// ── validateEdits — cargo ────────────────────────────────────────────────

describe("validateEdits — cargo (Cargo.toml)", () => {
  it("accepts valid Cargo.toml", () => {
    const result = validateEdits([
      edit("Cargo.toml", '[package]\nname = "test"\n[dependencies]\nserde = "1"'),
    ]);
    expect(result.valid).toBe(true);
  });

  it("rejects empty Cargo.toml", () => {
    const result = validateEdits([edit("Cargo.toml", "   ")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("empty");
  });

  it("rejects Cargo.toml without TOML headers", () => {
    const result = validateEdits([edit("Cargo.toml", "name = test")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("no valid TOML table headers");
  });

  it("rejects Cargo.toml with stray bracket but no table header", () => {
    // A lone "[" in content is not a valid TOML table header — the old
    // weak validator would pass this, the new one rejects it.
    const result = validateEdits([edit("Cargo.toml", 'name = "test" # [not a header')]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("no valid TOML table headers");
  });

  it("accepts Cargo.toml with array-of-tables syntax", () => {
    const result = validateEdits([
      edit("Cargo.toml", '[package]\nname = "test"\n[[bin]]\nname = "myapp"'),
    ]);
    expect(result.valid).toBe(true);
  });

  it("validates nested Cargo.toml", () => {
    const result = validateEdits([edit("crates/core/Cargo.toml", '[package]\nname = "core"')]);
    expect(result.valid).toBe(true);
  });
});

// ── validateEdits — go ───────────────────────────────────────────────────

describe("validateEdits — go (go.mod)", () => {
  it("accepts valid go.mod", () => {
    const result = validateEdits([edit("go.mod", "module github.com/example/app\n\ngo 1.21\n")]);
    expect(result.valid).toBe(true);
  });

  it("rejects empty go.mod", () => {
    const result = validateEdits([edit("go.mod", "")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("empty");
  });

  it("rejects go.mod without module directive", () => {
    const result = validateEdits([edit("go.mod", "go 1.21\n")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("no module directive");
  });

  it("accepts go.mod without go directive (not fatal)", () => {
    const result = validateEdits([edit("go.mod", "module github.com/example/app\n")]);
    expect(result.valid).toBe(true);
  });
});

// ── validateEdits — github-actions ───────────────────────────────────────

describe("validateEdits — github-actions (workflow files)", () => {
  it("accepts valid workflow file", () => {
    const result = validateEdits([
      edit(
        ".github/workflows/ci.yml",
        "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest",
      ),
    ]);
    expect(result.valid).toBe(true);
  });

  it("rejects empty workflow file", () => {
    const result = validateEdits([edit(".github/workflows/ci.yml", "")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("empty");
  });

  it("rejects workflow file without jobs key", () => {
    const result = validateEdits([edit(".github/workflows/ci.yml", "name: CI\non: push")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("no top-level jobs key");
  });

  it("rejects workflow where 'jobs:' only appears in a comment", () => {
    // The old substring check would pass this; the new regex requires
    // jobs: at the start of a line (YAML top-level key, not commented out)
    const result = validateEdits([
      edit(".github/workflows/ci.yml", "name: CI\n# jobs: disabled\non: push"),
    ]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("no top-level jobs key");
  });

  it("accepts .yaml extension", () => {
    const result = validateEdits([
      edit(
        ".github/workflows/deploy.yaml",
        "name: Deploy\njobs:\n  deploy:\n    runs-on: ubuntu-latest",
      ),
    ]);
    expect(result.valid).toBe(true);
  });

  it("does not match paths outside .github/workflows/", () => {
    // A YAML file outside the workflows directory is not a github-actions manifest
    const result = validateEdits([edit("ci/ci.yml", "jobs:\n  build: {}")]);
    // Treated as unknown file type — passes basic checks
    expect(result.valid).toBe(true);
  });
});

// ── validateEdits — docker ───────────────────────────────────────────────

describe("validateEdits — docker (Dockerfile)", () => {
  it("accepts valid Dockerfile", () => {
    const result = validateEdits([edit("Dockerfile", "FROM node:20\nRUN npm install")]);
    expect(result.valid).toBe(true);
  });

  it("rejects empty Dockerfile", () => {
    const result = validateEdits([edit("Dockerfile", "")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("empty");
  });

  it("rejects Dockerfile without FROM instruction", () => {
    const result = validateEdits([edit("Dockerfile", "RUN npm install")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("no valid FROM instruction");
  });

  it("rejects Dockerfile with FROM but no image reference", () => {
    // "FROM " with nothing after it is invalid — the edit would produce a
    // Dockerfile that fails to build. The old weak check (^FROM\s) passed it.
    const result = validateEdits([edit("Dockerfile", "FROM \nRUN npm install")]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("no valid FROM instruction");
  });

  it("accepts multi-stage Dockerfile with FROM ... AS", () => {
    const result = validateEdits([
      edit("Dockerfile", "FROM node:20 AS builder\nRUN npm install\nFROM node:20-alpine"),
    ]);
    expect(result.valid).toBe(true);
  });

  it("accepts Dockerfile with lowercase FROM", () => {
    const result = validateEdits([edit("Dockerfile", "from node:20\nRUN npm install")]);
    expect(result.valid).toBe(true);
  });

  it("accepts Dockerfile.alpine variant", () => {
    const result = validateEdits([edit("Dockerfile.alpine", "FROM node:20-alpine")]);
    expect(result.valid).toBe(true);
  });

  it("accepts prod.Dockerfile extension variant", () => {
    const result = validateEdits([edit("prod.Dockerfile", "FROM node:20")]);
    expect(result.valid).toBe(true);
  });
});

// ── validateEdits — unknown file types ───────────────────────────────────

describe("validateEdits — unknown file types", () => {
  it("accepts unknown file type if basic checks pass", () => {
    const result = validateEdits([edit("config.ini", "key=value")]);
    expect(result.valid).toBe(true);
  });

  it("still rejects empty content for unknown file types", () => {
    const result = validateEdits([edit("config.ini", "")]);
    expect(result.valid).toBe(false);
  });
});

// ── validateEdits — mixed results ────────────────────────────────────────

describe("validateEdits — mixed results", () => {
  it("separates passed and failed edits", () => {
    const result = validateEdits([
      edit("package.json", '{"name":"ok"}'),
      edit("package.json", "broken"),
      edit("Dockerfile", "FROM node:20"),
    ]);
    expect(result.valid).toBe(false);
    expect(result.passed).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
  });

  it("returns valid when all edits pass", () => {
    const result = validateEdits([
      edit("package.json", '{"name":"ok"}'),
      edit("Dockerfile", "FROM node:20"),
    ]);
    expect(result.valid).toBe(true);
    expect(result.passed).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it("handles empty input", () => {
    const result = validateEdits([]);
    expect(result.valid).toBe(true);
    expect(result.passed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

// ── validationRefusals ───────────────────────────────────────────────────

describe("validationRefusals", () => {
  it("converts failed edits to refusals", () => {
    const failed: FailedEdit[] = [
      { edit: edit("package.json", "bad"), reason: "not valid JSON" },
      { edit: edit("Dockerfile", ""), reason: "empty" },
    ];
    const refusals = validationRefusals(failed);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]?.what).toBe("package.json");
    expect(refusals[0]?.why).toContain("validation failed");
    expect(refusals[0]?.why).toContain("not valid JSON");
    expect(refusals[1]?.what).toBe("Dockerfile");
  });

  it("returns empty for no failures", () => {
    const refusals = validationRefusals([]);
    expect(refusals).toHaveLength(0);
  });
});

// ── validateEdits — edit-path allowlist ────────────────────────────────────

describe("validateEdits — edit-path allowlist", () => {
  it("rejects edits to paths not in the allowlist", () => {
    const allowedPaths = new Set(["package.json", "Dockerfile"]);
    const result = validateEdits(
      [edit("package.json", '{"name":"ok"}'), edit("secret.key", "private-key-data")],
      allowedPaths,
    );
    expect(result.valid).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain("not in discovered manifests");
    expect(result.failed[0]?.edit.path).toBe("secret.key");
    // The allowed edit should still pass
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]?.path).toBe("package.json");
  });

  it("accepts all edits when every path is in the allowlist", () => {
    const allowedPaths = new Set(["package.json", "Dockerfile"]);
    const result = validateEdits(
      [edit("package.json", '{"name":"ok"}'), edit("Dockerfile", "FROM node:20")],
      allowedPaths,
    );
    expect(result.valid).toBe(true);
    expect(result.passed).toHaveLength(2);
  });

  it("accepts all edits when no allowlist is provided", () => {
    // Without an allowlist, the edit-path check is skipped
    const result = validateEdits([edit("any/path.txt", "content")]);
    expect(result.valid).toBe(true);
  });

  it("rejects all edits when allowlist is empty", () => {
    const allowedPaths = new Set<string>();
    const result = validateEdits([edit("package.json", '{"name":"ok"}')], allowedPaths);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("not in discovered manifests");
  });
});

// ── validateEdits — npm structural checks ──────────────────────────────────

describe("validateEdits — npm structural checks", () => {
  it("rejects package.json with non-string name", () => {
    const result = validateEdits([edit("package.json", '{"name":42}')]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("non-string name");
  });

  it("rejects package.json with non-object dependencies", () => {
    const result = validateEdits([
      edit("package.json", '{"name":"test","dependencies":"not-an-object"}'),
    ]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("non-object dependencies");
  });

  it("rejects package.json with array devDependencies", () => {
    const result = validateEdits([edit("package.json", '{"devDependencies":["lodash"]}')]);
    expect(result.valid).toBe(false);
    expect(result.failed[0]?.reason).toContain("non-object devDependencies");
  });

  it("accepts package.json with valid dependency sections", () => {
    const result = validateEdits([
      edit(
        "package.json",
        '{"name":"test","dependencies":{"lodash":"^4.0.0"},"devDependencies":{"vitest":"^1.0.0"}}',
      ),
    ]);
    expect(result.valid).toBe(true);
  });
});
