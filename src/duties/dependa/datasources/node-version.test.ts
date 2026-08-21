/**
 * The Node release-index datasource, driven offline against index fixtures.
 *
 * Untested before this: like its siblings it is imported only from
 * `dependa/main.ts`, which is coverage-excluded, so nothing measured it and
 * nothing asserted it — 107 lines that decide which Node runtime version a
 * repository is told to move to, with no executable evidence of any kind.
 *
 * What it does is turn one third-party JSON document into the release list a
 * later stage proposes an update from. Two things about that document are
 * this datasource's own decisions rather than the index's: the `v` prefix
 * every entry carries is stripped, and anything that is not exactly
 * `major.minor.patch` is dropped, because the index also lists shapes this
 * ecosystem does not propose.
 *
 * `fetch` is stubbed the way the sibling datasource suites stub it. Nothing
 * here reaches a network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolutionResult } from "../model.js";

import { createNodeVersionDatasource } from "./node-version.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const datasource = createNodeVersionDatasource();

/** The index url this datasource is pinned to. */
const INDEX = "https://nodejs.org/dist/index.json";

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

/** The release index, newest first, the way nodejs.org serves it. */
function releaseIndex(entries: readonly unknown[] = DEFAULT_ENTRIES): Response {
  return new Response(JSON.stringify(entries), { status: 200 });
}

const DEFAULT_ENTRIES: readonly unknown[] = [
  { version: "v24.1.0", date: "2025-05-01", lts: false },
  { version: "v22.11.0", date: "2024-10-29", lts: "Jod" },
  { version: "v20.18.0", date: "2024-10-03", lts: "Iron" },
];

describe("the request it sends", () => {
  it("asks the Node release index, which answers for the whole ecosystem at once", async () => {
    const { urls } = answering(releaseIndex());

    await datasource.resolve("node");

    expect(urls).toEqual([INDEX]);
  });

  it("asks for JSON rather than whatever the CDN would negotiate", async () => {
    const { headers } = answering(releaseIndex());

    await datasource.resolve("node");

    expect(headers[0]?.Accept).toBe("application/json");
  });

  it("spends no request at all on a name this ecosystem does not have", async () => {
    // The ecosystem has exactly one package — the runtime. Guessing at any
    // other name would spend a request to learn what the name already said.
    const { urls } = answering(releaseIndex());

    expect(await datasource.resolve("nodejs")).toEqual({ status: "not-found" });
    expect(await datasource.resolve("")).toEqual({ status: "not-found" });
    expect(urls).toEqual([]);
  });
});

describe("what the index's answer means", () => {
  it("reports every release the index listed", async () => {
    answering(releaseIndex());

    const result = available(await datasource.resolve("node"));

    expect(result.releases.map((release) => release.version)).toEqual([
      "24.1.0",
      "22.11.0",
      "20.18.0",
    ]);
  });

  it("keeps the index's own newest-first order rather than re-deriving one", async () => {
    // The index is documented newest-first and this datasource trusts it. A
    // change that sorted the list — in either direction — would silently
    // change what `releases[0]` means to every caller reading it as "latest".
    answering(
      releaseIndex([
        { version: "v9.11.2", date: "2018-06-12" },
        { version: "v10.0.0", date: "2018-04-24" },
        { version: "v8.11.2", date: "2018-05-24" },
      ]),
    );

    const result = available(await datasource.resolve("node"));

    expect(result.releases.map((release) => release.version)).toEqual([
      "9.11.2",
      "10.0.0",
      "8.11.2",
    ]);
  });

  it("strips the `v` the index prefixes every version with", async () => {
    // Everything downstream — `classify`, `satisfies`, the manifest write —
    // reads a bare semver. A `v` left on would fail to parse and the update
    // would be skipped with no visible reason.
    answering(releaseIndex([{ version: "v24.1.0", date: "2025-05-01" }]));

    expect(available(await datasource.resolve("node")).releases[0]?.version).toBe("24.1.0");
  });

  it("accepts an entry that carries no `v` prefix", async () => {
    answering(releaseIndex([{ version: "24.1.0", date: "2025-05-01" }]));

    expect(available(await datasource.resolve("node")).releases[0]?.version).toBe("24.1.0");
  });

  it("links each release to its own tag on the nodejs/node releases page", async () => {
    answering(releaseIndex([{ version: "v24.1.0", date: "2025-05-01" }]));

    const release = available(await datasource.resolve("node")).releases[0];

    expect(release?.changelogUrl).toBe("https://github.com/nodejs/node/releases/tag/v24.1.0");
    expect(release?.diffUrl).toBeNull();
  });

  it("reports the release date the index recorded", async () => {
    answering(releaseIndex([{ version: "v24.1.0", date: "2025-05-01" }]));

    expect(available(await datasource.resolve("node")).releases[0]?.releasedAt).toEqual(
      new Date("2025-05-01"),
    );
  });

  it.each([
    ["an unparseable date", "sometime last spring"],
    ["a date that is not a string", 20250501],
    ["no date at all", undefined],
  ])("reports a null date rather than a wrong one for %s", async (_case, date) => {
    answering(releaseIndex([{ version: "v24.1.0", date }]));

    expect(available(await datasource.resolve("node")).releases[0]?.releasedAt).toBeNull();
  });

  it("marks nothing deprecated, yanked or prerelease — the index states none of those", async () => {
    // The index lists shipped releases only. Claiming otherwise would put a
    // withdrawal notice in a PR body that no source ever supported.
    answering(releaseIndex());

    const result = available(await datasource.resolve("node"));

    expect(
      result.releases.every(
        (release) => !release.deprecated && !release.yanked && !release.isPrerelease,
      ),
    ).toBe(true);
  });
});

describe("the entries it drops", () => {
  it.each([
    ["a version that is not a string", { version: 24, date: "2025-05-01" }],
    ["an entry with no version at all", { date: "2025-05-01" }],
    ["a prerelease, which this ecosystem does not propose", { version: "v25.0.0-rc.1" }],
    ["a two-component version", { version: "v0.12" }],
    ["a version with build metadata", { version: "v24.1.0+build" }],
    ["a version that is prose", { version: "vlatest" }],
  ])("drops %s while keeping the entries beside it", async (_case, bad) => {
    answering(releaseIndex([bad, { version: "v24.1.0", date: "2025-05-01" }]));

    const result = available(await datasource.resolve("node"));

    expect(result.releases.map((release) => release.version)).toEqual(["24.1.0"]);
  });

  it("reports malformed-metadata when every entry was unusable", async () => {
    // An index this could read nothing out of is not an empty ecosystem —
    // reporting `available` with no releases would read as "nothing to update".
    answering(releaseIndex([{ version: "vlatest" }, { version: 24 }, {}]));

    const result = await datasource.resolve("node");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("no versions");
  });

  it("reports malformed-metadata for an index that is empty", async () => {
    answering(releaseIndex([]));

    expect((await datasource.resolve("node")).status).toBe("malformed-metadata");
  });
});

describe("the answers it refuses", () => {
  it.each([
    ["a rate limit", 429],
    ["a server error", 500],
    ["an unavailable CDN", 503],
  ])("degrades %s to temporarily-unavailable — capacity is weather", async (_case, status) => {
    answering(new Response("", { status }));

    const result = await datasource.resolve("node");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain(
      String(status),
    );
  });

  it("reports not-found when the index itself is gone", async () => {
    answering(new Response("", { status: 404 }));

    expect(await datasource.resolve("node")).toEqual({ status: "not-found" });
  });

  it("degrades a network failure to temporarily-unavailable, naming it", async () => {
    answering(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await datasource.resolve("node");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain(
      "ECONNREFUSED",
    );
  });

  it("names a thrown value that is not an Error at all", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the case
    answering(() => Promise.reject("just a string"));

    expect((await datasource.resolve("node")).status).toBe("temporarily-unavailable");
  });

  it("reports malformed-metadata for a body that is not JSON at all", async () => {
    // A CDN error page served with a 200 is the shape this has to survive.
    answering(new Response("<html>gateway</html>", { status: 200 }));

    expect((await datasource.resolve("node")).status).toBe("malformed-metadata");
  });

  it.each([
    ["a JSON object", '{"version":"v24.1.0"}'],
    ["a JSON string", '"v24.1.0"'],
    ["JSON null", "null"],
    ["a JSON number", "24"],
  ])("reports malformed-metadata for %s, which is not an index", async (_case, body) => {
    answering(new Response(body, { status: 200 }));

    const result = await datasource.resolve("node");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("array");
  });

  // A `null` inside the array throws a TypeError out of `resolve` rather than
  // returning `malformed-metadata` like every sibling datasource: the loop
  // reads `entry.version` off each element without checking the element
  // itself. `main.ts` catches it and skips the dependency with a warning, so
  // the run stays green, but the reported reason is a JavaScript type error
  // rather than "the index came apart". Left visible rather than pinned,
  // because pinning the throw would bless it.
  it.todo("reports malformed-metadata for an index containing a null entry");
});

describe("what the datasource declares itself to be", () => {
  it("registers under the node-version id and ecosystem", () => {
    expect(datasource.id).toBe("node-version");
    expect(datasource.ecosystem).toBe("node-version");
  });
});
