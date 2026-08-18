/**
 * The npm datasource, driven offline against registry fixtures.
 *
 * This module had no test file at all: it is imported only from
 * `dependa/main.ts`, which is coverage-excluded because it calls `run()` at
 * import, so nothing measured it and nothing asserted it. What it does is
 * turn an untrusted third-party JSON document into the evidence every later
 * stage reasons about — which versions exist, when they shipped, which are
 * deprecated, and where to read about them. A registry that answers with
 * something unexpected must degrade to a named failure state, never to a
 * confident wrong answer.
 *
 * `fetch` is stubbed the way `docker-registry.test.ts` and
 * `github-tags.test.ts` already stub it. Nothing here reaches a network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolutionResult } from "../model.js";

import { createNpmDatasource } from "./npm.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const datasource = createNpmDatasource();

/** Narrows to the available case, failing the test rather than the type checker. */
function available(result: ResolutionResult): Extract<ResolutionResult, { status: "available" }> {
  if (result.status !== "available") {
    throw new Error(`expected available, got ${result.status}`);
  }
  return result;
}

/** Replaces `fetch` with one that answers once, recording the URL it was given. */
function answering(response: Response | (() => Promise<never>)): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = vi.fn<typeof fetch>((url) => {
    urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    return typeof response === "function" ? response() : Promise.resolve(response.clone());
  });
  return { urls };
}

function registryDocument(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      name: "left-pad",
      versions: {
        "1.0.0": {},
        "1.1.0": {},
        "2.0.0": {},
      },
      time: {
        "1.0.0": "2020-01-01T00:00:00.000Z",
        "1.1.0": "2021-06-01T00:00:00.000Z",
        "2.0.0": "2022-03-01T00:00:00.000Z",
      },
      ...over,
    }),
    { status: 200 },
  );
}

describe("the request it sends", () => {
  it("asks the npm registry for the package by name", async () => {
    const { urls } = answering(registryDocument());

    await datasource.resolve("left-pad");

    expect(urls).toEqual(["https://registry.npmjs.org/left-pad"]);
  });

  it("encodes the slash of a scoped package, which the registry path cannot carry", async () => {
    // `@scope/name` unencoded would read as two path segments and 404.
    const { urls } = answering(registryDocument());

    await datasource.resolve("@types/node");

    expect(urls).toEqual(["https://registry.npmjs.org/@types%2Fnode"]);
  });

  it("leaves an unscoped name with no slash in it alone", async () => {
    const { urls } = answering(registryDocument());

    await datasource.resolve("lodash");

    expect(urls).toEqual(["https://registry.npmjs.org/lodash"]);
  });
});

describe("what the registry's answer means", () => {
  it("reports every version the registry listed", async () => {
    answering(registryDocument());

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.map((release) => release.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
  });

  it("orders releases newest first, numerically rather than alphabetically", async () => {
    // The ordering that matters: `10.0.0` is newer than `9.0.0`, and a plain
    // string sort says the opposite.
    answering(
      registryDocument({
        versions: { "9.0.0": {}, "10.0.0": {}, "2.0.0": {} },
        time: {},
      }),
    );

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.map((release) => release.version)).toEqual(["10.0.0", "9.0.0", "2.0.0"]);
  });

  it("reports the release date the registry recorded for each version", async () => {
    answering(registryDocument());

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.find((r) => r.version === "1.0.0")?.releasedAt).toEqual(
      new Date("2020-01-01T00:00:00.000Z"),
    );
  });

  it("reports a null date rather than a wrong one when the registry gave none", async () => {
    answering(registryDocument({ time: {} }));

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.every((release) => release.releasedAt === null)).toBe(true);
  });

  it("reports a null date for a time entry that is not a parseable date", async () => {
    answering(registryDocument({ time: { "1.0.0": "not a date", "1.1.0": 12345 } }));

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.find((r) => r.version === "1.0.0")?.releasedAt).toBeNull();
    expect(result.releases.find((r) => r.version === "1.1.0")?.releasedAt).toBeNull();
  });

  it("marks a version the registry deprecated with a message", async () => {
    answering(
      registryDocument({
        versions: { "1.0.0": { deprecated: "use 2.x" }, "2.0.0": {} },
      }),
    );

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.find((r) => r.version === "1.0.0")?.deprecated).toBe(true);
    expect(result.releases.find((r) => r.version === "2.0.0")?.deprecated).toBe(false);
  });

  it("does not mark a version whose deprecated flag is explicitly false", async () => {
    answering(registryDocument({ versions: { "1.0.0": { deprecated: false } } }));

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.deprecated).toBe(false);
  });

  it("never marks an npm version as yanked, because npm has no such concept", async () => {
    answering(registryDocument());

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.every((release) => !release.yanked)).toBe(true);
  });

  it.each([
    ["2.0.0-beta.1", true],
    ["1.0.0-rc1", true],
    ["1.0.0", false],
    ["1.0.0+build.5", false],
    ["not-a-version", false],
  ])("reads %s as prerelease=%s", async (version, isPrerelease) => {
    answering(registryDocument({ versions: { [version]: {} }, time: {} }));

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.isPrerelease).toBe(isPrerelease);
  });
});

describe("the links it derives from package metadata", () => {
  it.each([
    ["an object repository url", { repository: { url: "https://github.com/o/r" } }],
    ["a git+https repository url", { repository: { url: "git+https://github.com/o/r.git" } }],
    ["a string repository", { repository: "https://github.com/o/r" }],
    ["a github: shorthand", { repository: "github:o/r" }],
  ])("derives a releases link from %s", async (_case, info) => {
    answering(registryDocument({ versions: { "1.0.0": info }, time: {} }));

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.changelogUrl).toBe("https://github.com/o/r/releases");
  });

  it("falls back to the homepage when the repository field names no GitHub url", async () => {
    answering(
      registryDocument({
        versions: {
          "1.0.0": {
            repository: { url: "https://gitlab.com/o/r" },
            homepage: "https://github.com/o/r",
          },
        },
        time: {},
      }),
    );

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.changelogUrl).toBe("https://github.com/o/r/releases");
  });

  it("derives a compare link only from the repository, never from the homepage", async () => {
    // A homepage is a docs site as often as it is a repository; a compare url
    // built from one would 404 on the maintainer who clicked it.
    answering(
      registryDocument({
        versions: { "1.0.0": { homepage: "https://github.com/o/r" } },
        time: {},
      }),
    );

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.changelogUrl).toBe("https://github.com/o/r/releases");
    expect(result.releases[0]?.diffUrl).toBeNull();
  });

  it("reports no links at all for a package that named no repository", async () => {
    answering(registryDocument({ versions: { "1.0.0": {} }, time: {} }));

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.changelogUrl).toBeNull();
    expect(result.releases[0]?.diffUrl).toBeNull();
  });

  it("reports no links for a repository hosted somewhere other than GitHub", async () => {
    answering(
      registryDocument({
        versions: { "1.0.0": { repository: { url: "https://bitbucket.org/o/r" } } },
        time: {},
      }),
    );

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.changelogUrl).toBeNull();
  });
});

describe("the answers it refuses", () => {
  it("reports not-found for a package the registry does not have", async () => {
    answering(new Response("", { status: 404 }));

    expect(await datasource.resolve("nope")).toEqual({ status: "not-found" });
  });

  it.each([
    ["a rate limit", 429],
    ["a server error", 500],
    ["a bad gateway", 502],
    ["an unavailable registry", 503],
  ])("degrades %s to temporarily-unavailable — capacity is weather", async (_case, status) => {
    answering(new Response("", { status }));

    const result = await datasource.resolve("left-pad");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain(
      String(status),
    );
  });

  it.each([
    ["a bad request", 400],
    ["an unauthorized read", 401],
    ["a forbidden read", 403],
  ])(
    "degrades %s to temporarily-unavailable rather than to a wrong answer",
    async (_case, status) => {
      answering(new Response("", { status }));

      expect((await datasource.resolve("left-pad")).status).toBe("temporarily-unavailable");
    },
  );

  it("degrades a network failure to temporarily-unavailable, naming it", async () => {
    answering(() => Promise.reject(new TypeError("fetch failed")));

    const result = await datasource.resolve("left-pad");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain(
      "fetch failed",
    );
  });

  it("degrades a timeout to temporarily-unavailable", async () => {
    answering(() => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      return Promise.reject(timeout);
    });

    expect((await datasource.resolve("left-pad")).status).toBe("temporarily-unavailable");
  });

  it("reports malformed-metadata for a body that is not JSON at all", async () => {
    answering(new Response("<html>proxy error</html>", { status: 200 }));

    const result = await datasource.resolve("left-pad");

    expect(result.status).toBe("malformed-metadata");
  });

  it.each([
    ["a JSON string", '"left-pad"'],
    ["a JSON number", "42"],
    ["JSON null", "null"],
  ])("reports malformed-metadata for %s where an object was expected", async (_case, body) => {
    answering(new Response(body, { status: 200 }));

    expect((await datasource.resolve("left-pad")).status).toBe("malformed-metadata");
  });

  it("reports malformed-metadata for a document carrying no versions field", async () => {
    answering(new Response(JSON.stringify({ name: "left-pad" }), { status: 200 }));

    const result = await datasource.resolve("left-pad");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("versions");
  });

  // ADJUDICATE: a `versions` ARRAY is accepted, and fabricates a release.
  // `parseRegistryResponse` guards with `typeof versions !== "object"`
  // (npm.ts:95), which an array passes, and then reads it with
  // `Object.entries` — so `versions: ["1.0.0"]` yields one release whose
  // `version` is the array INDEX, `"0"`, reported as `status: "available"`.
  // The module's own doc (npm.ts:11) says malformed registry responses degrade
  // to `malformed-metadata`, and `types.ts:38-44` says a datasource returns an
  // explicit failure state rather than a confident wrong answer — both of
  // which read as refusing this. The blast radius is small (a "0" target
  // version does not survive semver comparison downstream) and no npm registry
  // sends this shape, so the source's current behaviour is pinned here rather
  // than changed. Reported for a ruling; an `Array.isArray` guard beside the
  // `typeof` check is the one-line fix if the ruling goes the other way.
  it("accepts a versions ARRAY and names the release after its index", async () => {
    answering(new Response(JSON.stringify({ versions: ["1.0.0", "2.0.0"] }), { status: 200 }));

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.map((release) => release.version)).toEqual(["1", "0"]);
  });

  it("reports malformed-metadata for a document whose versions map is empty", async () => {
    answering(new Response(JSON.stringify({ versions: {} }), { status: 200 }));

    const result = await datasource.resolve("left-pad");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("no valid");
  });

  it("ignores a blank version key rather than reporting a release with no name", async () => {
    answering(
      new Response(JSON.stringify({ versions: { "   ": {}, "1.0.0": {} } }), { status: 200 }),
    );

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases.map((release) => release.version)).toEqual(["1.0.0"]);
  });

  it("tolerates a time field that is not an object, rather than refusing the document", async () => {
    // The dates are optional evidence; the versions are the answer. Losing
    // the first must not cost the second.
    answering(
      new Response(JSON.stringify({ versions: { "1.0.0": {} }, time: "nope" }), { status: 200 }),
    );

    const result = available(await datasource.resolve("left-pad"));

    expect(result.releases[0]?.releasedAt).toBeNull();
  });
});

describe("what the datasource declares itself to be", () => {
  it("registers under the npm id and the npm ecosystem", () => {
    expect(datasource.id).toBe("npm");
    expect(datasource.ecosystem).toBe("npm");
  });
});
