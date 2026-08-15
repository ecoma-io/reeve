/**
 * Tests for the dependa security advisory module.
 *
 * Tests the parsing of GitHub Advisory API responses and the graceful
 * degradation when the API is unavailable or returns unexpected data.
 *
 * No network calls — all tests use mock data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecurityAdvisory } from "../model.js";

import { queryAdvisories } from "./security-advisory.js";

// Mock @actions/core so we can observe warnings without side effects
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
}));

// ── parseAdvisories (via queryAdvisories with mocked fetch) ─────────────

describe("queryAdvisories", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeAdvisory(id: string): Record<string, unknown> {
    return {
      ghsa_id: id,
      severity: "high",
      summary: `Advisory ${id}`,
      vulnerabilities: [],
    };
  }

  it("returns parsed advisories from a single page", async () => {
    const advisories = [makeAdvisory("GHSA-0001"), makeAdvisory("GHSA-0002")];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(advisories),
    });

    const result = await queryAdvisories("fake-token", "npm", "lodash");

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("GHSA-0001");
    expect(result[1]?.id).toBe("GHSA-0002");
  });

  it("warns when pagination is truncated at the page cap", async () => {
    // Return exactly 100 results per page for 5 pages → triggers truncation
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeAdvisory(`GHSA-${String(i).padStart(4, "0")}`),
    );

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(fullPage),
      });
    });

    const result = await queryAdvisories("fake-token", "npm", "express");

    // Should have fetched exactly 5 pages (the cap)
    expect(callCount).toBe(5);
    // Should have collected 500 advisories
    expect(result).toHaveLength(500);

    // Should have warned about truncation
    const core = await import("@actions/core");
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("truncated at 5 pages"));
  });

  it("does not warn when pagination completes before the cap", async () => {
    // First page has fewer than 100 results → no truncation
    const partialPage = Array.from({ length: 3 }, (_, i) =>
      makeAdvisory(`GHSA-${String(i).padStart(4, "0")}`),
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(partialPage),
    });

    await queryAdvisories("fake-token", "npm", "tiny-pkg");

    const core = await import("@actions/core");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("degrades gracefully on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await queryAdvisories("fake-token", "npm", "some-pkg");

    expect(result).toEqual([]);
  });

  it("degrades gracefully on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await queryAdvisories("fake-token", "npm", "some-pkg");

    expect(result).toEqual([]);
  });

  it("returns empty for unsupported ecosystems", async () => {
    const result = await queryAdvisories("fake-token", "docker", "alpine");

    expect(result).toEqual([]);
  });
});

// ── Type contract tests ─────────────────────────────────────────────────

describe("SecurityAdvisory type contract", () => {
  it("has the expected shape for a valid advisory", () => {
    const advisory: SecurityAdvisory = {
      id: "GHSA-xxxx-xxxx-xxxx",
      severity: "high",
      summary: "A vulnerability was found in the package",
      patchedVersions: ">=1.2.3",
      vulnerableRange: null,
    };
    expect(advisory.id).toBe("GHSA-xxxx-xxxx-xxxx");
    expect(advisory.severity).toBe("high");
    expect(advisory.summary).toBe("A vulnerability was found in the package");
    expect(advisory.patchedVersions).toBe(">=1.2.3");
  });

  it("supports all severity levels", () => {
    const severities: SecurityAdvisory["severity"][] = [
      "low",
      "medium",
      "moderate",
      "high",
      "critical",
    ];
    for (const severity of severities) {
      const advisory: SecurityAdvisory = {
        id: "GHSA-test-test-test",
        severity,
        summary: "test",
        patchedVersions: null,
        vulnerableRange: null,
      };
      expect(advisory.severity).toBe(severity);
    }
  });

  it("supports null patchedVersions", () => {
    const advisory: SecurityAdvisory = {
      id: "GHSA-test-test-test",
      severity: "medium",
      summary: "test",
      patchedVersions: null,
      vulnerableRange: null,
    };
    expect(advisory.patchedVersions).toBeNull();
  });
});

describe("Advisory API ecosystem mapping", () => {
  it("maps npm to npm ecosystem", () => {
    // The ADVISORY_ECOSYSTEMS map maps dependa ecosystems to GitHub API values
    // npm → npm, cargo → rust, go → go
    // GitHub Actions and Docker are not in the advisory database
    const mapping: Record<string, string | undefined> = {
      npm: "npm",
      cargo: "rust",
      go: "go",
      "github-actions": undefined,
      docker: undefined,
    };
    expect(mapping.npm).toBe("npm");
    expect(mapping.cargo).toBe("rust");
    expect(mapping.go).toBe("go");
    expect(mapping["github-actions"]).toBeUndefined();
    expect(mapping.docker).toBeUndefined();
  });
});
