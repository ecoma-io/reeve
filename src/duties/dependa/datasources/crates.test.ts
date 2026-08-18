/**
 * The crates.io datasource, driven offline against API fixtures.
 *
 * Untested before this: imported only from `dependa/main.ts`, which is
 * coverage-excluded, so nothing measured it and nothing asserted it. What it
 * does is turn an untrusted third-party JSON document into the evidence a
 * later stage proposes updates from — and crates.io carries a concept npm
 * does not, `yanked`, which is the difference between "you may upgrade to
 * this" and "this was withdrawn".
 *
 * `fetch` is stubbed the way the sibling datasource suites already stub it.
 * Nothing here reaches a network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolutionResult } from "../model.js";

import { createCratesDatasource } from "./crates.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const datasource = createCratesDatasource();

function available(result: ResolutionResult): Extract<ResolutionResult, { status: "available" }> {
  if (result.status !== "available") {
    throw new Error(`expected available, got ${result.status}`);
  }
  return result;
}

/** Replaces `fetch`, recording the url and headers it was given. */
function answering(response: Response | (() => Promise<never>)): {
  urls: string[];
  headers: Record<string, string>[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  globalThis.fetch = vi.fn<typeof fetch>((url, init) => {
    urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    return typeof response === "function" ? response() : Promise.resolve(response.clone());
  });
  return { urls, headers };
}

function cratesDocument(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      crate: { name: "serde", repository: "https://github.com/serde-rs/serde" },
      versions: [
        { num: "1.0.0", created_at: "2020-01-01T00:00:00Z", yanked: false },
        { num: "1.1.0", created_at: "2021-06-01T00:00:00Z", yanked: false },
        { num: "2.0.0", created_at: "2022-03-01T00:00:00Z", yanked: false },
      ],
      ...over,
    }),
    { status: 200 },
  );
}

describe("the request it sends", () => {
  it("asks crates.io for the crate by name", async () => {
    const { urls } = answering(cratesDocument());

    await datasource.resolve("serde");

    expect(urls).toEqual(["https://crates.io/api/v1/crates/serde"]);
  });

  it("url-encodes a crate name so it cannot escape its path segment", async () => {
    const { urls } = answering(cratesDocument());

    await datasource.resolve("a/../b");

    expect(urls[0]).toBe("https://crates.io/api/v1/crates/a%2F..%2Fb");
  });

  it("sends the user agent crates.io requires, which refuses requests without one", async () => {
    const { headers } = answering(cratesDocument());

    await datasource.resolve("serde");

    expect(headers[0]?.["User-Agent"]).toContain("reeve-dependa");
  });
});

describe("what the API's answer means", () => {
  it("reports every version the API listed, newest first", async () => {
    answering(cratesDocument());

    const result = available(await datasource.resolve("serde"));

    expect(result.releases.map((release) => release.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
  });

  it("orders numerically rather than alphabetically", async () => {
    answering(
      cratesDocument({ versions: [{ num: "9.0.0" }, { num: "10.0.0" }, { num: "2.0.0" }] }),
    );

    const result = available(await datasource.resolve("serde"));

    expect(result.releases.map((release) => release.version)).toEqual(["10.0.0", "9.0.0", "2.0.0"]);
  });

  it("carries a yanked version through as yanked rather than dropping it", async () => {
    // Dropping it would leave a maintainer unable to see that the version
    // their manifest pins was withdrawn.
    answering(
      cratesDocument({
        versions: [
          { num: "1.0.0", yanked: true },
          { num: "1.1.0", yanked: false },
        ],
      }),
    );

    const result = available(await datasource.resolve("serde"));

    expect(result.releases.find((r) => r.version === "1.0.0")?.yanked).toBe(true);
    expect(result.releases.find((r) => r.version === "1.1.0")?.yanked).toBe(false);
  });

  it("treats a yanked field that is not exactly true as not yanked", async () => {
    // A withdrawn release is a strong claim; only the API's own `true` makes it.
    answering(cratesDocument({ versions: [{ num: "1.0.0", yanked: "yes" }] }));

    expect(available(await datasource.resolve("serde")).releases[0]?.yanked).toBe(false);
  });

  it("never marks a crate version as deprecated, because crates.io has no such concept", async () => {
    answering(cratesDocument());

    const result = available(await datasource.resolve("serde"));

    expect(result.releases.every((release) => !release.deprecated)).toBe(true);
  });

  it("reports the release date the API recorded", async () => {
    answering(cratesDocument());

    const result = available(await datasource.resolve("serde"));

    expect(result.releases.find((r) => r.version === "1.0.0")?.releasedAt).toEqual(
      new Date("2020-01-01T00:00:00Z"),
    );
  });

  it("reports a null date rather than a wrong one for an unparseable created_at", async () => {
    answering(cratesDocument({ versions: [{ num: "1.0.0", created_at: "whenever" }] }));

    expect(available(await datasource.resolve("serde")).releases[0]?.releasedAt).toBeNull();
  });

  it("reports a null date when created_at is not a string at all", async () => {
    answering(cratesDocument({ versions: [{ num: "1.0.0", created_at: 1700000000 }] }));

    expect(available(await datasource.resolve("serde")).releases[0]?.releasedAt).toBeNull();
  });

  it.each([
    ["1.0.0-alpha.1", true],
    ["0.1.0-pre.1", true],
    ["1.0.0", false],
    ["1.0.0+meta", false],
  ])("reads %s as prerelease=%s", async (num, isPrerelease) => {
    answering(cratesDocument({ versions: [{ num }] }));

    expect(available(await datasource.resolve("serde")).releases[0]?.isPrerelease).toBe(
      isPrerelease,
    );
  });
});

describe("the links it derives from crate metadata", () => {
  it("builds a tag and compare link from the crate's GitHub repository", async () => {
    answering(cratesDocument({ versions: [{ num: "1.0.0" }] }));

    const release = available(await datasource.resolve("serde")).releases[0];

    expect(release?.changelogUrl).toBe("https://github.com/serde-rs/serde/releases/tag/v1.0.0");
    expect(release?.diffUrl).toBe("https://github.com/serde-rs/serde/compare/v1.0.0");
  });

  it("strips a trailing .git so the link is one a browser can open", async () => {
    answering(
      cratesDocument({
        crate: { repository: "https://github.com/serde-rs/serde.git" },
        versions: [{ num: "1.0.0" }],
      }),
    );

    expect(available(await datasource.resolve("serde")).releases[0]?.changelogUrl).toBe(
      "https://github.com/serde-rs/serde/releases/tag/v1.0.0",
    );
  });

  it("falls back to the homepage when the repository names no GitHub url", async () => {
    answering(
      cratesDocument({
        crate: { repository: "https://gitlab.com/o/r", homepage: "https://github.com/o/r" },
        versions: [{ num: "1.0.0" }],
      }),
    );

    expect(available(await datasource.resolve("serde")).releases[0]?.changelogUrl).toContain(
      "github.com/o/r",
    );
  });

  it("reports no links for a crate hosted nowhere this can read", async () => {
    answering(cratesDocument({ crate: {}, versions: [{ num: "1.0.0" }] }));

    const release = available(await datasource.resolve("serde")).releases[0];

    expect(release?.changelogUrl).toBeNull();
    expect(release?.diffUrl).toBeNull();
  });

  it("ignores a repository field that is not a string", async () => {
    answering(
      cratesDocument({
        crate: { repository: { url: "https://github.com/o/r" } },
        versions: [{ num: "1.0.0" }],
      }),
    );

    expect(available(await datasource.resolve("serde")).releases[0]?.changelogUrl).toBeNull();
  });
});

describe("the answers it refuses", () => {
  it("reports not-found for a crate crates.io does not have", async () => {
    answering(new Response("", { status: 404 }));

    expect(await datasource.resolve("nope")).toEqual({ status: "not-found" });
  });

  it.each([
    ["a rate limit", 429],
    ["a server error", 500],
    ["an unavailable API", 503],
  ])("degrades %s to temporarily-unavailable — capacity is weather", async (_case, status) => {
    answering(new Response("", { status }));

    const result = await datasource.resolve("serde");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain(
      String(status),
    );
  });

  it.each([
    ["a bad request", 400],
    ["a forbidden read", 403],
  ])(
    "degrades %s to temporarily-unavailable rather than to a wrong answer",
    async (_case, status) => {
      answering(new Response("", { status }));

      expect((await datasource.resolve("serde")).status).toBe("temporarily-unavailable");
    },
  );

  it("degrades a network failure to temporarily-unavailable, naming it", async () => {
    answering(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await datasource.resolve("serde");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain(
      "ECONNREFUSED",
    );
  });

  it("names a thrown value that is not an Error at all", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the case
    answering(() => Promise.reject("just a string"));

    expect((await datasource.resolve("serde")).status).toBe("temporarily-unavailable");
  });

  it("reports malformed-metadata for a body that is not JSON", async () => {
    answering(new Response("<html>gateway</html>", { status: 200 }));

    expect((await datasource.resolve("serde")).status).toBe("malformed-metadata");
  });

  it.each([
    ["a JSON string", '"serde"'],
    ["JSON null", "null"],
    ["a JSON number", "7"],
  ])("reports malformed-metadata for %s", async (_case, body) => {
    answering(new Response(body, { status: 200 }));

    expect((await datasource.resolve("serde")).status).toBe("malformed-metadata");
  });

  it("reports malformed-metadata for a document with no crate field", async () => {
    answering(new Response(JSON.stringify({ versions: [{ num: "1.0.0" }] }), { status: 200 }));

    const result = await datasource.resolve("serde");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("crate");
  });

  it("reports malformed-metadata when versions is not an array", async () => {
    answering(
      new Response(JSON.stringify({ crate: {}, versions: { "1.0.0": {} } }), { status: 200 }),
    );

    const result = await datasource.resolve("serde");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("versions");
  });

  it("reports malformed-metadata when every entry in versions is unusable", async () => {
    answering(
      new Response(
        JSON.stringify({ crate: {}, versions: [null, "1.0.0", { num: 7 }, { num: "" }, {}] }),
        { status: 200 },
      ),
    );

    const result = await datasource.resolve("serde");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("no valid");
  });

  it("keeps the usable versions and drops the unusable ones beside them", async () => {
    // A registry entry that came apart is not a reason to lose the entries
    // that did not.
    answering(
      new Response(
        JSON.stringify({
          crate: {},
          versions: [{ num: "1.0.0" }, null, { num: 7 }, { num: "2.0.0" }],
        }),
        { status: 200 },
      ),
    );

    const result = available(await datasource.resolve("serde"));

    expect(result.releases.map((release) => release.version)).toEqual(["2.0.0", "1.0.0"]);
  });
});

describe("what the datasource declares itself to be", () => {
  it("registers under the crates id and the cargo ecosystem", () => {
    expect(datasource.id).toBe("crates");
    expect(datasource.ecosystem).toBe("cargo");
  });
});
