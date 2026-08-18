/**
 * The GitHub tags datasource, driven offline against API fixtures.
 *
 * This is the datasource behind every GitHub Action a workflow pins, and it is
 * the only one that distinguishes `auth-refused` from `temporarily-unavailable`
 * — the run's own token being refused is configuration, not weather, and it
 * must not be waited out. It also makes two requests: tags are the answer,
 * releases are best-effort evidence layered on top, and a releases call that
 * fails must not cost the tags.
 *
 * `fetch` is stubbed; nothing here reaches a network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Datasource } from "./types.js";
import type { ResolutionResult } from "../model.js";

import { createGithubTagsDatasource } from "./github-tags.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function available(result: ResolutionResult): Extract<ResolutionResult, { status: "available" }> {
  if (result.status !== "available") {
    throw new Error(`expected available, got ${result.status}`);
  }
  return result;
}

/**
 * Routes `/tags` to `tags` and `/releases` to `releases`.
 *
 * By url rather than by call order, because the releases request is made only
 * once the tags request succeeded — a case that never reaches it should not
 * have to know that.
 */
function api(options: {
  tags?: Response | (() => Promise<never>);
  releases?: Response | (() => Promise<never>);
}): { urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  globalThis.fetch = vi.fn<typeof fetch>((url, init) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    urls.push(target);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const answer = target.includes("/releases") ? options.releases : options.tags;
    if (answer === undefined) return Promise.resolve(new Response("[]", { status: 200 }));
    return typeof answer === "function" ? answer() : Promise.resolve(answer.clone());
  });
  return { urls, headers };
}

function tagList(names: readonly string[] = ["v1", "v2", "v3"]): Response {
  return new Response(
    JSON.stringify(names.map((name) => ({ name, commit: { sha: `sha-${name}` } }))),
    { status: 200 },
  );
}

function releaseList(
  entries: readonly Record<string, unknown>[] = [
    { tag_name: "v3", body: "notes", created_at: "2023-01-01T00:00:00Z", prerelease: false },
  ],
): Response {
  return new Response(JSON.stringify(entries), { status: 200 });
}

describe("the requests it sends", () => {
  it("asks the GitHub API for the action repository's tags", async () => {
    const { urls } = api({ tags: tagList(), releases: releaseList() });

    await createGithubTagsDatasource("t").resolve("actions/checkout");

    expect(urls[0]).toBe("https://api.github.com/repos/actions/checkout/tags?per_page=100");
  });

  it("asks for the releases too, as evidence layered on the tags", async () => {
    const { urls } = api({ tags: tagList(), releases: releaseList() });

    await createGithubTagsDatasource("t").resolve("actions/checkout");

    expect(urls[1]).toBe("https://api.github.com/repos/actions/checkout/releases?per_page=100");
  });

  it("sends the run's token and the pinned API version on every request", async () => {
    const { headers } = api({ tags: tagList(), releases: releaseList() });

    await createGithubTagsDatasource("secret-token").resolve("actions/checkout");

    for (const sent of headers) {
      expect(sent.Authorization).toBe("Bearer secret-token");
      expect(sent["X-GitHub-Api-Version"]).toBe("2022-11-28");
    }
  });

  it("keeps a repository name containing a slash whole", async () => {
    const { urls } = api({ tags: tagList(), releases: releaseList() });

    await createGithubTagsDatasource("t").resolve("owner/nested/repo");

    expect(urls[0]).toContain("/repos/owner/nested/repo/tags");
  });
});

describe("what the API's answer means", () => {
  it("reports every tag the API listed, newest first", async () => {
    api({ tags: tagList(["v1", "v2", "v3"]), releases: releaseList([]) });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases.map((release) => release.version)).toEqual(["v3", "v2", "v1"]);
  });

  it("orders tags numerically, so v10 leads v9", async () => {
    api({ tags: tagList(["v2", "v9", "v10"]), releases: releaseList([]) });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases.map((release) => release.version)).toEqual(["v10", "v9", "v2"]);
  });

  it("always offers a compare link, which needs only the tag name", async () => {
    api({ tags: tagList(["v3"]), releases: releaseList([]) });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases[0]?.diffUrl).toBe("https://github.com/actions/checkout/compare/v3");
  });

  it("offers a changelog link only for a tag that has a release behind it", async () => {
    // A tag with no release has no notes to link to, and a link to a page that
    // does not exist is worse than no link.
    api({
      tags: tagList(["v3", "v2"]),
      releases: releaseList([{ tag_name: "v3", created_at: "2023-01-01T00:00:00Z" }]),
    });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases.find((r) => r.version === "v3")?.changelogUrl).toBe(
      "https://github.com/actions/checkout/releases/tag/v3",
    );
    expect(result.releases.find((r) => r.version === "v2")?.changelogUrl).toBeNull();
  });

  it("takes the release date from the release, not from the tag", async () => {
    api({
      tags: tagList(["v3"]),
      releases: releaseList([{ tag_name: "v3", created_at: "2023-05-05T00:00:00Z" }]),
    });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases[0]?.releasedAt).toEqual(new Date("2023-05-05T00:00:00Z"));
  });

  it("reports a null date for a tag with no release date behind it", async () => {
    api({ tags: tagList(["v3"]), releases: releaseList([{ tag_name: "v3" }]) });

    expect(
      available(await createGithubTagsDatasource("t").resolve("actions/checkout")).releases[0]
        ?.releasedAt,
    ).toBeNull();
  });

  it("marks a tag whose release the API flagged as a prerelease", async () => {
    api({
      tags: tagList(["v4", "v3"]),
      releases: releaseList([
        { tag_name: "v4", prerelease: true },
        { tag_name: "v3", prerelease: false },
      ]),
    });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases.find((r) => r.version === "v4")?.isPrerelease).toBe(true);
    expect(result.releases.find((r) => r.version === "v3")?.isPrerelease).toBe(false);
  });

  it("treats a tag with no release at all as not a prerelease", async () => {
    api({ tags: tagList(["v3"]), releases: releaseList([]) });

    expect(
      available(await createGithubTagsDatasource("t").resolve("actions/checkout")).releases[0]
        ?.isPrerelease,
    ).toBe(false);
  });

  it("never marks an action tag as deprecated or yanked", async () => {
    api({ tags: tagList(), releases: releaseList() });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases.every((r) => !r.deprecated && !r.yanked)).toBe(true);
  });

  it("ignores a tag entry with no usable name", async () => {
    api({
      tags: new Response(JSON.stringify([{ name: "" }, { name: 7 }, {}, { name: "v1" }]), {
        status: 200,
      }),
      releases: releaseList([]),
    });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases.map((release) => release.version)).toEqual(["v1"]);
  });

  it("ignores a release entry whose tag_name is not a string", async () => {
    api({
      tags: tagList(["v1"]),
      releases: releaseList([{ tag_name: 7, created_at: "2023-01-01T00:00:00Z" }]),
    });

    expect(
      available(await createGithubTagsDatasource("t").resolve("actions/checkout")).releases[0]
        ?.changelogUrl,
    ).toBeNull();
  });
});

describe("the releases request is best-effort", () => {
  it("still answers with every tag when the releases request throws", async () => {
    // Tags are the answer; releases are the evidence layered on top. Losing
    // the second must not cost the first.
    api({ tags: tagList(), releases: () => Promise.reject(new Error("ECONNRESET")) });

    const result = available(await createGithubTagsDatasource("t").resolve("actions/checkout"));

    expect(result.releases).toHaveLength(3);
    expect(result.releases.every((release) => release.changelogUrl === null)).toBe(true);
  });

  it("still answers when the releases endpoint returns a non-ok status", async () => {
    api({ tags: tagList(), releases: new Response("", { status: 500 }) });

    expect(
      available(await createGithubTagsDatasource("t").resolve("actions/checkout")).releases,
    ).toHaveLength(3);
  });

  it("still answers when the releases body is not JSON", async () => {
    api({ tags: tagList(), releases: new Response("not json", { status: 200 }) });

    expect(
      available(await createGithubTagsDatasource("t").resolve("actions/checkout")).releases,
    ).toHaveLength(3);
  });

  it("still answers when the releases body is not an array", async () => {
    api({
      tags: tagList(),
      releases: new Response(JSON.stringify({ nope: true }), { status: 200 }),
    });

    expect(
      available(await createGithubTagsDatasource("t").resolve("actions/checkout")).releases,
    ).toHaveLength(3);
  });
});

describe("the answers it refuses", () => {
  it.each([
    ["a token with no read access (403)", 403],
    ["a token the API would not accept (401)", 401],
  ])("reports auth-refused for %s — configuration, never weather", async (_case, status) => {
    // The distinction this datasource exists to make: a refused token is not
    // something a later run waits out, so it must not degrade to
    // `temporarily-unavailable` alongside a rate limit.
    api({ tags: new Response("", { status }) });

    const result = await createGithubTagsDatasource("read-only-token").resolve("actions/checkout");

    expect(result.status).toBe("auth-refused");
    expect(result.status === "auth-refused" ? result.reason : "").toContain("read access");
  });

  it.each([
    ["a rate limit", 429],
    ["a server error", 500],
    ["an unavailable API", 503],
  ])("degrades %s to temporarily-unavailable — capacity is weather", async (_case, status) => {
    api({ tags: new Response("", { status }) });

    const result = await createGithubTagsDatasource("t").resolve("actions/checkout");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain(
      String(status),
    );
  });

  it("degrades an unexpected 4xx to temporarily-unavailable rather than to a wrong answer", async () => {
    api({ tags: new Response("", { status: 422 }) });

    expect((await createGithubTagsDatasource("t").resolve("actions/checkout")).status).toBe(
      "temporarily-unavailable",
    );
  });

  it("reports not-found for an action repository the API does not have", async () => {
    api({ tags: new Response("", { status: 404 }) });

    expect(await createGithubTagsDatasource("t").resolve("unknown/package")).toEqual({
      status: "not-found",
    });
  });

  it("reports not-found for a name that does not identify a repository at all", async () => {
    const { urls } = api({ tags: tagList() });

    expect(await createGithubTagsDatasource("t").resolve("checkout")).toEqual({
      status: "not-found",
    });
    // And spends nothing finding out: there is no repository to ask about.
    expect(urls).toEqual([]);
  });

  it("reports not-found for a repository that has no tags at all", async () => {
    // A repository that only uses branches has no versions to offer, which is
    // the same answer as one that does not exist — not a malformed response.
    api({ tags: tagList([]), releases: releaseList([]) });

    expect(await createGithubTagsDatasource("t").resolve("actions/checkout")).toEqual({
      status: "not-found",
    });
  });

  it("degrades a network failure to temporarily-unavailable, naming it", async () => {
    api({ tags: () => Promise.reject(new Error("ENOTFOUND api.github.com")) });

    const result = await createGithubTagsDatasource("t").resolve("actions/checkout");

    expect(result.status).toBe("temporarily-unavailable");
    expect(result.status === "temporarily-unavailable" ? result.reason : "").toContain("ENOTFOUND");
  });

  it("reports malformed-metadata for a tags body that is not JSON", async () => {
    api({ tags: new Response("<html>", { status: 200 }) });

    expect((await createGithubTagsDatasource("t").resolve("actions/checkout")).status).toBe(
      "malformed-metadata",
    );
  });

  it("reports malformed-metadata for a tags body that is not an array", async () => {
    api({ tags: new Response(JSON.stringify({ tags: [] }), { status: 200 }) });

    const result = await createGithubTagsDatasource("t").resolve("actions/checkout");

    expect(result.status).toBe("malformed-metadata");
    expect(result.status === "malformed-metadata" ? result.reason : "").toContain("array");
  });
});

describe("what the datasource declares itself to be", () => {
  it("registers under the github-tags id and the github-actions ecosystem", () => {
    const ds: Datasource = createGithubTagsDatasource("t");

    expect(ds.id).toBe("github-tags");
    expect(ds.ecosystem).toBe("github-actions");
  });
});
