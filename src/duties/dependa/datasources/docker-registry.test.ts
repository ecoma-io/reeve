/**
 * Tests for the Docker registry datasource — Docker Hub pagination and response parsing.
 *
 * Mocks global `fetch` to simulate Docker Hub API responses with pagination,
 * v2 registry responses, and error conditions. No real network calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDockerRegistryDatasource } from "./docker-registry.js";

import type { ResolutionResult } from "../model.js";

// ── helpers ──────────────────────────────────────────────────────────────

/** Assert the result is available, narrowing its type. */
function assertAvailable(
  result: ResolutionResult,
): asserts result is Extract<ResolutionResult, { status: "available" }> {
  expect(result.status).toBe("available");
}

/** A single page of Docker Hub tag results. */
function dockerHubPage(
  tags: readonly { name: string; last_updated?: string }[],
  next: string | null,
): { results: typeof tags; next: typeof next; count: number } {
  return { results: tags, next, count: tags.length };
}

/** Build a Docker Hub tag object. */
function tag(name: string): { name: string; last_updated: string } {
  return { name, last_updated: "2026-01-01T00:00:00Z" };
}

/** Extract a URL string from fetch's overloaded input type. */
function urlString(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

const datasource = createDockerRegistryDatasource();

// ── pagination ───────────────────────────────────────────────────────────

describe("docker-registry pagination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows Docker Hub next URLs across pages", async () => {
    const page1 = dockerHubPage(
      [tag("1.0"), tag("1.1")],
      "https://registry.hub.docker.com/v2/repositories/library/node/tags/?page=2&page_size=100",
    );
    const page2 = dockerHubPage([tag("2.0")], null);

    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const urlStr = urlString(input);
      calls.push(urlStr);
      if (urlStr.includes("page=2")) {
        return Promise.resolve(
          new Response(JSON.stringify(page2), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(page1), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const result = await datasource.resolve("node");
    expect(result.status).toBe("available");
    assertAvailable(result);
    // Should have 3 tags: 1.0, 1.1, 2.0
    expect(result.releases).toHaveLength(3);
    const names = result.releases.map((r) => r.version);
    expect(names).toContain("1.0");
    expect(names).toContain("1.1");
    expect(names).toContain("2.0");
    // Should have made 2 fetch calls
    expect(calls).toHaveLength(2);
  });

  it("stops pagination when next is null", async () => {
    const page = dockerHubPage([tag("1.0"), tag("2.0")], null);

    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      calls.push(urlString(input));
      return Promise.resolve(
        new Response(JSON.stringify(page), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const result = await datasource.resolve("node");
    expect(result.status).toBe("available");
    assertAvailable(result);
    expect(result.releases).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("returns partial results when pagination fails on a later page", async () => {
    const page1 = dockerHubPage(
      [tag("1.0")],
      "https://registry.hub.docker.com/v2/repositories/library/node/tags/?page=2",
    );

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const urlStr = urlString(input);
      if (urlStr.includes("page=2")) {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(page1), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const result = await datasource.resolve("node");
    // Should return the partial results from page 1
    expect(result.status).toBe("available");
    assertAvailable(result);
    expect(result.releases).toHaveLength(1);
  });

  it("caps pagination at MAX_PAGES and returns what was collected", async () => {
    // Return a page that always has a next URL
    const alwaysNext = (page: number) =>
      dockerHubPage(
        [tag(`${String(page)}.0`)],
        `https://registry.hub.docker.com/v2/repositories/library/node/tags/?page=${String(page + 1)}`,
      );

    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const urlStr = urlString(input);
      calls.push(urlStr);
      const pageMatch = /page=(\d+)/.exec(urlStr);
      const pageNum = pageMatch !== null ? Number(pageMatch[1]) : 1;
      return Promise.resolve(
        new Response(JSON.stringify(alwaysNext(pageNum)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const result = await datasource.resolve("node");
    expect(result.status).toBe("available");
    assertAvailable(result);
    // MAX_PAGES is 10, so we should get 10 tags
    expect(result.releases).toHaveLength(10);
    // Should have made 10 fetch calls (MAX_PAGES)
    expect(calls).toHaveLength(10);
  });

  it("handles v2 registry (non-Docker Hub) without pagination", async () => {
    const v2Response = { tags: ["1.0", "2.0", "latest"] };

    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(v2Response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await datasource.resolve("ghcr.io/owner/image");
    expect(result.status).toBe("available");
    assertAvailable(result);
    // "latest" should be filtered out
    expect(result.releases).toHaveLength(2);
    const names = result.releases.map((r) => r.version);
    expect(names).toContain("1.0");
    expect(names).toContain("2.0");
    expect(names).not.toContain("latest");
  });
});

// ── SSRF protection ─────────────────────────────────────────────────────

describe("docker-registry SSRF protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks loopback addresses", async () => {
    const result = await datasource.resolve("127.0.0.1/internal/image");
    expect(result.status).toBe("not-found");
  });

  it("blocks cloud metadata endpoints", async () => {
    const result = await datasource.resolve("169.254.169.254/latest/image");
    expect(result.status).toBe("not-found");
  });

  it("blocks RFC 1918 private addresses", async () => {
    const result = await datasource.resolve("10.0.0.1/internal/image");
    expect(result.status).toBe("not-found");
  });

  it("allows known safe registries", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ tags: ["1.0"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await datasource.resolve("ghcr.io/owner/image");
    expect(result.status).toBe("available");
  });
});
