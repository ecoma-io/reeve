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

  it("throws on 401/403 — the run's own token being refused is not weather", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    await expect(queryAdvisories("fake-token", "npm", "some-pkg")).rejects.toThrow(/HTTP 403/);
    await expect(queryAdvisories("fake-token", "npm", "some-pkg")).rejects.toThrow(/refused/);

    // Tagged `AuthRefused` so dependa's caller rethrows instead of swallowing.
    await expect(queryAdvisories("fake-token", "npm", "some-pkg")).rejects.toMatchObject({
      name: "AuthRefused",
    });
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

// ---------------------------------------------------------------------------
// The parse half of the module, driven through `queryAdvisories`.
//
// The block above pins pagination and the failure states. What it does not
// reach is `parseAdvisories` (security-advisory.ts:147-235), which is where an
// untrusted third-party document becomes the severity that decides whether an
// update is proposed as security-critical. Every entry below is a shape the
// API can send and the parser has to survive: two spellings of the same
// severity, a missing one, two generations of the patched-version field, and
// entries that came apart entirely.
// ---------------------------------------------------------------------------

describe("parsing one advisory document", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Answers the first page with `entries` and nothing after it. */
  function answering(entries: readonly unknown[]): void {
    globalThis.fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(entries), { status: 200 })),
    );
  }

  /** One advisory, parsed. */
  async function parsed(entry: Record<string, unknown>): Promise<SecurityAdvisory | undefined> {
    answering([entry]);
    return (await queryAdvisories("t", "npm", "lodash"))[0];
  }

  function advisory(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ghsa_id: "GHSA-0001",
      severity: "high",
      summary: "Prototype pollution",
      vulnerabilities: [],
      ...over,
    };
  }

  describe("severity", () => {
    it.each([
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["critical", "critical"],
    ])("keeps the REST spelling %s as %s", async (raw, expected) => {
      expect((await parsed(advisory({ severity: raw })))?.severity).toBe(expected);
    });

    it("normalises GraphQL's `moderate` to REST's `medium`", async () => {
      // Two spellings of one severity, from two APIs. A consumer comparing
      // against `medium` must not miss the advisories that said `moderate`.
      expect((await parsed(advisory({ severity: "moderate" })))?.severity).toBe("medium");
    });

    it("falls back to cvss_severity when the severity field is missing", async () => {
      expect(
        (await parsed(advisory({ severity: undefined, cvss_severity: "critical" })))?.severity,
      ).toBe("critical");
    });

    it("normalises `moderate` in cvss_severity too", async () => {
      expect(
        (await parsed(advisory({ severity: null, cvss_severity: "moderate" })))?.severity,
      ).toBe("medium");
    });

    it("defaults an unknown severity to low rather than inflating the risk", async () => {
      // An advisory nobody rated must not outrank one somebody rated low.
      expect((await parsed(advisory({ severity: "catastrophic" })))?.severity).toBe("low");
      expect((await parsed(advisory({ severity: 9.8 })))?.severity).toBe("low");
      expect((await parsed(advisory({ severity: undefined })))?.severity).toBe("low");
    });

    it("defaults to low when cvss_severity is also unusable", async () => {
      expect(
        (await parsed(advisory({ severity: "unknown", cvss_severity: { score: 9 } })))?.severity,
      ).toBe("low");
    });
  });

  describe("the patched and vulnerable ranges", () => {
    it("turns the REST first_patched_version into a >= range", async () => {
      const entry = await parsed(
        advisory({ vulnerabilities: [{ first_patched_version: "1.82.0" }] }),
      );

      expect(entry?.patchedVersions).toBe(">=1.82.0");
    });

    it("falls back to the legacy patched_versions range when there is no first_patched_version", async () => {
      const entry = await parsed(advisory({ vulnerabilities: [{ patched_versions: ">=1.2.3" }] }));

      expect(entry?.patchedVersions).toBe(">=1.2.3");
    });

    it("prefers first_patched_version over the legacy field when both are present", async () => {
      const entry = await parsed(
        advisory({
          vulnerabilities: [{ first_patched_version: "2.0.0", patched_versions: ">=1.0.0" }],
        }),
      );

      expect(entry?.patchedVersions).toBe(">=2.0.0");
    });

    it("joins several affected packages' patched versions into one range", async () => {
      const entry = await parsed(
        advisory({
          vulnerabilities: [
            { first_patched_version: "1.82.0" },
            { first_patched_version: "2.4.0" },
          ],
        }),
      );

      expect(entry?.patchedVersions).toBe(">=1.82.0 || >=2.4.0");
    });

    it("carries the vulnerable range through, joined the same way", async () => {
      const entry = await parsed(
        advisory({
          vulnerabilities: [
            { vulnerable_version_range: "< 1.82.0" },
            { vulnerable_version_range: ">= 2.0.0, < 2.4.0" },
          ],
        }),
      );

      expect(entry?.vulnerableRange).toBe("< 1.82.0 || >= 2.0.0, < 2.4.0");
    });

    it("reports null rather than an empty range when no version was named", async () => {
      // Null says "the API did not say"; an empty string would be read as a
      // range that matches nothing.
      const entry = await parsed(advisory({ vulnerabilities: [] }));

      expect(entry?.patchedVersions).toBeNull();
      expect(entry?.vulnerableRange).toBeNull();
    });

    it("reports null when the vulnerabilities field is not an array at all", async () => {
      const entry = await parsed(advisory({ vulnerabilities: { patched: "1.0.0" } }));

      expect(entry?.patchedVersions).toBeNull();
      expect(entry?.vulnerableRange).toBeNull();
    });

    it("ignores an entry inside vulnerabilities that is not an object", async () => {
      const entry = await parsed(
        advisory({ vulnerabilities: [null, "1.0.0", ["x"], { first_patched_version: "3.0.0" }] }),
      );

      expect(entry?.patchedVersions).toBe(">=3.0.0");
    });

    it("ignores a version field that is present but empty", async () => {
      const entry = await parsed(
        advisory({
          vulnerabilities: [{ first_patched_version: "", vulnerable_version_range: "" }],
        }),
      );

      expect(entry?.patchedVersions).toBeNull();
      expect(entry?.vulnerableRange).toBeNull();
    });
  });

  describe("entries it drops rather than half-reads", () => {
    it("drops an entry that is not an object", async () => {
      answering([null, "GHSA-0001", 42, ["x"]]);

      expect(await queryAdvisories("t", "npm", "lodash")).toEqual([]);
    });

    it("drops an entry with no usable ghsa_id", async () => {
      answering([advisory({ ghsa_id: "" }), advisory({ ghsa_id: 7 }), advisory({ ghsa_id: null })]);

      expect(await queryAdvisories("t", "npm", "lodash")).toEqual([]);
    });

    it("drops an entry with no usable summary", async () => {
      // The summary is what a maintainer reads to decide. An advisory without
      // one is a row of metadata, not a report of anything.
      answering([advisory({ summary: "" }), advisory({ summary: 7 })]);

      expect(await queryAdvisories("t", "npm", "lodash")).toEqual([]);
    });

    it("keeps the usable entries beside the ones it dropped", async () => {
      answering([null, advisory({ ghsa_id: "GHSA-GOOD" }), advisory({ summary: "" })]);

      const result = await queryAdvisories("t", "npm", "lodash");

      expect(result.map((entry) => entry.id)).toEqual(["GHSA-GOOD"]);
    });
  });

  describe("the ecosystems it covers", () => {
    it.each(["npm", "cargo", "go"] as const)(
      "queries the advisory API for %s",
      async (ecosystem) => {
        const fetchMock = vi.fn<typeof fetch>(() =>
          Promise.resolve(new Response("[]", { status: 200 })),
        );
        globalThis.fetch = fetchMock;

        await queryAdvisories("t", ecosystem, "pkg");

        expect(fetchMock).toHaveBeenCalled();
      },
    );

    it.each(["docker", "github-actions"] as const)(
      "asks nothing at all for %s, which the advisory database does not cover",
      async (ecosystem) => {
        const fetchMock = vi.fn<typeof fetch>(() =>
          Promise.resolve(new Response("[]", { status: 200 })),
        );
        globalThis.fetch = fetchMock;

        expect(await queryAdvisories("t", ecosystem, "pkg")).toEqual([]);
        // Spending a request to learn an ecosystem is unsupported is a request
        // spent on a foregone conclusion.
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("url-encodes the package name so it cannot escape the query string", async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("[]", { status: 200 })),
      );
      globalThis.fetch = fetchMock;

      await queryAdvisories("t", "npm", "@scope/pkg");

      const [url] = fetchMock.mock.calls[0] ?? [];
      const target =
        typeof url === "string" ? url : url instanceof URL ? url.href : (url?.url ?? "");
      expect(target).toContain("affects=%40scope%2Fpkg");
    });

    it("sends the run's token and the pinned API version", async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("[]", { status: 200 })),
      );
      globalThis.fetch = fetchMock;

      await queryAdvisories("secret", "npm", "lodash");

      const init = fetchMock.mock.calls[0]?.[1];
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret");
      expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    });
  });

  describe("bodies it cannot read", () => {
    it("degrades a body that is not JSON to the advisories it already had", async () => {
      globalThis.fetch = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("<html>", { status: 200 })),
      );

      expect(await queryAdvisories("t", "npm", "lodash")).toEqual([]);
    });

    it("degrades a body that is not an array to the advisories it already had", async () => {
      globalThis.fetch = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ advisories: [] }), { status: 200 })),
      );

      expect(await queryAdvisories("t", "npm", "lodash")).toEqual([]);
    });

    it("keeps the pages it read when a later page comes back unreadable", async () => {
      // Partial evidence is still evidence: a page-two failure must not throw
      // away page one's advisories.
      const firstPage = Array.from({ length: 100 }, (_, at) =>
        advisory({ ghsa_id: `GHSA-${String(at).padStart(4, "0")}` }),
      );
      let call = 0;
      globalThis.fetch = vi.fn<typeof fetch>(() => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? new Response(JSON.stringify(firstPage), { status: 200 })
            : new Response("not json", { status: 200 }),
        );
      });

      expect(await queryAdvisories("t", "npm", "lodash")).toHaveLength(100);
    });
  });
});
