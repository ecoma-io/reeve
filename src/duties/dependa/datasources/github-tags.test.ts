import { afterEach, describe, expect, it, vi } from "vitest";

import type { Datasource } from "./types.js";

import { createGithubTagsDatasource } from "./github-tags.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createGithubTagsDatasource", () => {
  function fetchMock(status: number): typeof fetch {
    const response = new Response("", { status });
    const mock = vi.fn<typeof fetch>().mockResolvedValue(response);
    return mock;
  }

  it("returns auth-refused when the GitHub API refuses the run's token (401/403)", async () => {
    globalThis.fetch = fetchMock(403);

    const ds: Datasource = createGithubTagsDatasource("read-only-token");
    const result = await ds.resolve("actions/checkout");

    expect(result).toEqual({
      status: "auth-refused",
      reason: expect.stringContaining("read access") as string,
    });
  });

  it("returns temporarily-unavailable for rate limits and server errors", async () => {
    globalThis.fetch = fetchMock(429);

    const ds: Datasource = createGithubTagsDatasource("token");
    const result = await ds.resolve("actions/checkout");

    expect(result.status).toBe("temporarily-unavailable");
  });

  it("returns not-found for an unknown action repository", async () => {
    globalThis.fetch = fetchMock(404);

    const ds: Datasource = createGithubTagsDatasource("token");
    const result = await ds.resolve("unknown/package");

    expect(result.status).toBe("not-found");
  });
});
