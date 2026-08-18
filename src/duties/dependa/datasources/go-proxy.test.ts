/**
 * The Go module proxy datasource, driven offline against proxy fixtures.
 *
 * Untested before this: imported only from `dependa/main.ts`, which is
 * coverage-excluded, so nothing measured it and nothing asserted it. It is
 * also the only datasource that makes TWO requests — a plain-text version
 * list, then a `.info` document for the newest version's timestamp — and the
 * second one is explicitly best-effort: a proxy that answers the list and not
 * the info must still produce a usable answer.
 *
 * `fetch` is stubbed the way the sibling datasource suites already stub it.
 * Nothing here reaches a network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolutionResult } from "../model.js";

import { createGoProxyDatasource } from "./go-proxy.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const datasource = createGoProxyDatasource();

function available(result: ResolutionResult): Extract<ResolutionResult, { status: "available" }> {
  if (result.status !== "available") {
    throw new Error(`expected available, got ${result.status}`);
  }
  return result;
}

/**
 * Replaces `fetch` with a router: `/@v/list` gets `list`, `.info` gets `info`.
 *
 * Routing by url rather than by call order, because the info request is
 * conditional — a case that never reaches it should not have to know that.
 */
function proxy(options: {
  list?: Response | (() => Promise<never>);
  info?: Response | (() => Promise<never>);
}): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = vi.fn<typeof fetch>((url) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    urls.push(target);
    const answer = target.endsWith("/list") ? options.list : options.info;
    if (answer === undefined) return Promise.resolve(new Response("", { status: 404 }));
    return typeof answer === "function" ? answer() : Promise.resolve(answer.clone());
  });
  return { urls };
}

function versionList(text = "v1.0.0\nv1.1.0\nv2.0.0\n"): Response {
  return new Response(text, { status: 200 });
}

function infoDocument(time = "2022-03-01T00:00:00Z"): Response {
  return new Response(JSON.stringify({ Version: "v2.0.0", Time: time }), { status: 200 });
}

describe("the requests it sends", () => {
  it("asks the proxy for the module's version list", async () => {
    const { urls } = proxy({ list: versionList(), info: infoDocument() });

    await datasource.resolve("github.com/spf13/cobra");

    expect(urls[0]).toBe("https://proxy.golang.org/github.com%2Fspf13%2Fcobra/@v/list");
  });

  it("asks for the info document of the first version the list named", async () => {
    const { urls } = proxy({ list: versionList(), info: infoDocument() });

    await datasource.resolve("github.com/spf13/cobra");

    expect(urls[1]).toBe("https://proxy.golang.org/github.com%2Fspf13%2Fcobra/@v/v1.0.0.info");
  });

  it("makes exactly two requests however long the version list is", async () => {
    // One `.info` per version would be a request per release on every run,
    // for a date only the newest one's is used for.
    const { urls } = proxy({
      list: versionList("v1.0.0\nv1.1.0\nv1.2.0\nv1.3.0\nv2.0.0\n"),
      info: infoDocument(),
    });

    await datasource.resolve("github.com/spf13/cobra");

    expect(urls).toHaveLength(2);
  });
});

describe("what the proxy's answer means", () => {
  it("reports every version the list named, newest first, with the v prefix stripped", async () => {
    proxy({ list: versionList(), info: infoDocument() });

    const result = available(await datasource.resolve("github.com/spf13/cobra"));

    expect(result.releases.map((release) => release.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
  });

  it("orders numerically rather than alphabetically", async () => {
    proxy({ list: versionList("v9.0.0\nv10.0.0\nv2.0.0\n"), info: infoDocument() });

    const result = available(await datasource.resolve("github.com/spf13/cobra"));

    expect(result.releases.map((release) => release.version)).toEqual(["10.0.0", "9.0.0", "2.0.0"]);
  });

  it("ignores blank lines and lines that are not versions", async () => {
    proxy({ list: versionList("v1.0.0\n\n  \nnot-a-version\nv2.0.0\n"), info: infoDocument() });

    const result = available(await datasource.resolve("github.com/spf13/cobra"));

    expect(result.releases.map((release) => release.version)).toEqual(["2.0.0", "1.0.0"]);
  });

  it("trims whitespace around a version line", async () => {
    proxy({ list: versionList("  v1.0.0  \n"), info: infoDocument() });

    expect(available(await datasource.resolve("m")).releases[0]?.version).toBe("1.0.0");
  });

  it.each([
    ["v1.0.0-alpha.1", true],
    ["v0.1.0-pre.1", true],
    ["v1.0.0", false],
    ["v1.0.0+incompatible", false],
  ])("reads %s as prerelease=%s", async (version, isPrerelease) => {
    proxy({ list: versionList(`${version}\n`), info: infoDocument() });

    expect(available(await datasource.resolve("m")).releases[0]?.isPrerelease).toBe(isPrerelease);
  });

  it("never marks a Go version as deprecated or yanked, concepts the proxy has not got", async () => {
    proxy({ list: versionList(), info: infoDocument() });

    const result = available(await datasource.resolve("github.com/spf13/cobra"));

    expect(result.releases.every((r) => !r.deprecated && !r.yanked)).toBe(true);
  });
});

describe("the best-effort release date", () => {
  it("fills in the date the info document gave for the version it asked about", async () => {
    proxy({ list: versionList("v1.0.0\n"), info: infoDocument("2020-01-01T00:00:00Z") });

    const result = available(await datasource.resolve("m"));

    expect(result.releases[0]?.releasedAt).toEqual(new Date("2020-01-01T00:00:00Z"));
  });

  it("still answers with every version when the info request fails outright", async () => {
    // The whole point of it being best-effort: the version list IS the answer,
    // and a missing timestamp costs a nicety, not the run.
    proxy({ list: versionList(), info: () => Promise.reject(new Error("ECONNRESET")) });

    const result = available(await datasource.resolve("github.com/spf13/cobra"));

    expect(result.releases).toHaveLength(3);
    expect(result.releases.every((release) => release.releasedAt === null)).toBe(true);
  });

  it("still answers when the info endpoint returns a non-ok status", async () => {
    proxy({ list: versionList(), info: new Response("", { status: 500 }) });

    expect(available(await datasource.resolve("m")).releases).toHaveLength(3);
  });

  it("still answers when the info document is not JSON", async () => {
    proxy({ list: versionList(), info: new Response("not json", { status: 200 }) });

    expect(available(await datasource.resolve("m")).releases).toHaveLength(3);
  });

  it("leaves the date null when the info document carries no Time field", async () => {
    proxy({
      list: versionList(),
      info: new Response(JSON.stringify({ Version: "v1" }), { status: 200 }),
    });

    const result = available(await datasource.resolve("m"));

    expect(result.releases.every((release) => release.releasedAt === null)).toBe(true);
  });

  it("leaves the date null when Time is not a parseable date", async () => {
    proxy({ list: versionList(), info: infoDocument("whenever") });

    const result = available(await datasource.resolve("m"));

    expect(result.releases.every((release) => release.releasedAt === null)).toBe(true);
  });
});

describe("the links it derives from the module path", () => {
  it("builds tag and compare links for a GitHub-hosted module", async () => {
    proxy({ list: versionList("v1.0.0\n"), info: infoDocument() });

    const release = available(await datasource.resolve("github.com/spf13/cobra")).releases[0];

    expect(release?.changelogUrl).toBe("https://github.com/spf13/cobra/releases/tag/v1.0.0");
    expect(release?.diffUrl).toBe("https://github.com/spf13/cobra/compare/v1.0.0");
  });

  it("keeps the owner and repo only, dropping a nested module suffix", async () => {
    proxy({ list: versionList("v1.0.0\n"), info: infoDocument() });

    const release = available(await datasource.resolve("github.com/spf13/cobra/submodule/deep"))
      .releases[0];

    expect(release?.changelogUrl).toBe("https://github.com/spf13/cobra/releases/tag/v1.0.0");
  });

  it("reports no links for a module hosted somewhere other than GitHub", async () => {
    proxy({ list: versionList("v1.0.0\n"), info: infoDocument() });

    const release = available(await datasource.resolve("golang.org/x/text")).releases[0];

    expect(release?.changelogUrl).toBeNull();
    expect(release?.diffUrl).toBeNull();
  });

  it("reports no links for a github.com path too short to name a repository", async () => {
    proxy({ list: versionList("v1.0.0\n"), info: infoDocument() });

    const release = available(await datasource.resolve("github.com/onlyowner")).releases[0];

    expect(release?.changelogUrl).toBeNull();
  });
});

describe("the answers it refuses", () => {
  it("reports not-found for a module the proxy does not have", async () => {
    proxy({ list: new Response("", { status: 404 }) });

    expect(await datasource.resolve("m")).toEqual({ status: "not-found" });
  });

  it("reports not-found for a module the proxy has retired with a 410", async () => {
    // Gone is gone: a retired module is not weather to be waited out.
    proxy({ list: new Response("", { status: 410 }) });

    expect(await datasource.resolve("m")).toEqual({ status: "not-found" });
  });

  it("reports not-found for a version list that is empty", async () => {
    proxy({ list: versionList("") });

    expect(await datasource.resolve("m")).toEqual({ status: "not-found" });
  });

  it("reports not-found for a list carrying nothing that looks like a version", async () => {
    proxy({ list: versionList("no versions here\njust prose\n") });

    expect(await datasource.resolve("m")).toEqual({ status: "not-found" });
  });

  it.each([
    ["a rate limit", 429],
    ["a server error", 500],
    ["an unavailable proxy", 503],
  ])("degrades %s to temporarily-unavailable — capacity is weather", async (_case, status) => {
    proxy({ list: new Response("", { status }) });

    const result = await datasource.resolve("m");

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
      proxy({ list: new Response("", { status }) });

      expect((await datasource.resolve("m")).status).toBe("temporarily-unavailable");
    },
  );

  it("degrades a network failure on the version list to temporarily-unavailable", async () => {
    proxy({ list: () => Promise.reject(new Error("ENOTFOUND")) });

    const result = await datasource.resolve("m");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain("ENOTFOUND");
  });
});

describe("what the datasource declares itself to be", () => {
  it("registers under the go-proxy id and the go ecosystem", () => {
    expect(datasource.id).toBe("go-proxy");
    expect(datasource.ecosystem).toBe("go");
  });
});
