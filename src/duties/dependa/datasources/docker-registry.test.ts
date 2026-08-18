/**
 * Tests for the Docker registry datasource — Docker Hub pagination and response parsing.
 *
 * Mocks global `fetch` to simulate Docker Hub API responses with pagination,
 * v2 registry responses, and error conditions. No real network calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "@actions/core";

// Only the two reporting functions are replaced; everything else in
// `@actions/core` stays real. A warning is the whole visible outcome of an
// SSRF refusal, so a case has to be able to read it back.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  info: vi.fn(),
  warning: vi.fn(),
}));

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

/**
 * The image name reaches this datasource out of a Dockerfile `FROM` line —
 * repository content, which is untrusted input. A `FROM 169.254.169.254/x`
 * that made dependa fetch that host would turn a maintenance run into a
 * credential read against the runner's own metadata service.
 *
 * The guard is therefore about the REQUEST, not about the verdict. A case
 * asserting only `status === "not-found"` passes with the guard removed —
 * fetching 127.0.0.1 from a CI runner usually gets connection-refused, which
 * degrades to a verdict too — and while it passes, the suite is performing
 * the SSRF it claims to test. So every case below asserts that `fetch` was
 * never called, and stubs it so that a regression is a failed assertion
 * rather than whatever the host's network happens to do.
 */
describe("docker-registry SSRF protection", () => {
  beforeEach(() => {
    vi.mocked(core.warning).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fetch that must not be reached — calling it is the failure. */
  function forbiddenFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
    const spy = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ tags: ["1.0"] }), { status: 200 })),
    );
    globalThis.fetch = spy;
    return spy;
  }

  it.each([
    ["loopback by IP", "127.0.0.1/internal/image"],
    ["loopback by name and port", "localhost:5000/internal/image"],
    ["the cloud metadata endpoint", "169.254.169.254/latest/image"],
    ["an RFC 1918 10.x address", "10.0.0.1/internal/image"],
    ["an RFC 1918 192.168.x address", "192.168.1.1/internal/image"],
    ["an RFC 1918 172.16.x address", "172.16.0.1/internal/image"],
  ])("makes no request at all to %s", async (_case, image) => {
    const fetchSpy = forbiddenFetch();

    const result = await datasource.resolve(image);

    // The assertion that actually pins the guard: no packet left the process.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("not-found");
  });

  // ADJUDICATE: `isSafeRegistry` has a `localhost` arm (docker-registry.ts:310)
  // that a BARE `localhost/x` can never reach. `parseImageName:366` classifies
  // the first path component as a registry only when it contains a `.` or a
  // `:`, and Docker's own reference additionally special-cases the literal
  // `localhost` — so `localhost/internal/image` parses as the Docker Hub
  // namespace `localhost` and is fetched from Docker Hub. That is NOT an SSRF
  // (no request reaches the loopback interface) and `localhost:5000/x` above
  // IS refused, so the question is whether the bare form should join it.
  // Pinned to the source's current behaviour, unchanged, pending a ruling.
  it("sends a bare `localhost/x` to Docker Hub rather than to the loopback interface", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchSpy;

    await datasource.resolve("localhost/internal/image");

    const requested = fetchSpy.mock.calls
      .map(([url]) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url))
      .join(" ");
    // The load-bearing half: whatever it did, it did not talk to localhost.
    expect(requested).not.toContain("//localhost");
    expect(requested).not.toContain("127.0.0.1");
    expect(requested).toContain("docker.com");
  });

  it("says out loud that it refused, rather than reporting a plain not-found", async () => {
    // A silent `not-found` is indistinguishable from an image that does not
    // exist, and a maintainer whose Dockerfile is being rewritten by somebody
    // else's pull request needs to see the refusal.
    forbiddenFetch();

    await datasource.resolve("169.254.169.254/latest/image");

    const said = vi
      .mocked(core.warning)
      .mock.calls.map(([message]) => String(message))
      .join("\n");
    expect(said).toContain("169.254.169.254");
    expect(said).toContain("private/internal address");
    // The message used to read "skipping SSRF protection" while the code was
    // applying it — the opposite of what happened, in the one line a reader
    // consults to find out what happened.
    expect(said).not.toContain("skipping");
    expect(said).toContain("no request was made");
  });

  it("allows a known safe registry through to a real request", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ tags: ["1.0"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = fetchSpy;

    const result = await datasource.resolve("ghcr.io/owner/image");

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.status).toBe("available");
  });

  it("allows the default registry, which has no hostname to check at all", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ results: [{ name: "1.0" }] }), { status: 200 }),
        ),
      );

    await datasource.resolve("nginx");

    expect(fetchSpy).toHaveBeenCalled();
  });
});
