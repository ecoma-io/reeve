import { describe, expect, it } from "vitest";

import { matchAtlasEvidence, readAtlas, type AtlasApi, type Atlas, type Package } from "./atlas.js";

// The empty/cap constants are module-private in atlas.ts; the tests mirror the
// values so the assertions stay exact while the surface stays internal.
const EMPTY_ATLAS: Atlas = { packages: [], truncated: false };
const ATLAS_MAX_PACKAGES = 200;

const AT = { owner: "acme", repo: "widgets" };
const REF = "main";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** An error the way the GitHub client actually raises one — carrying an HTTP status. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { status });
}

interface File {
  readonly path: string;
  readonly content: string;
}

/** A stub `AtlasApi` over a fixed set of files and a directory tree, so a test can name a monorepo shape declaratively. */
function apiWith(files: readonly File[]): AtlasApi {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const dirs = new Set<string>();
  for (const f of files) {
    const segments = f.path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      dirs.add(segments.slice(0, i).join("/"));
    }
  }

  return {
    rest: {
      repos: {
        get: () => Promise.resolve({ data: { default_branch: REF } }),
        getContent: ({ path }) => {
          const content = byPath.get(path);
          if (content === undefined) return Promise.reject(httpError(404));
          return Promise.resolve({
            data: { type: "file", content: b64(content), encoding: "base64" },
          });
        },
      },
      git: {
        getTree: () =>
          Promise.resolve({
            data: {
              tree: [
                ...files.map((f) => ({ path: f.path, type: "blob" })),
                ...[...dirs].map((d) => ({ path: d, type: "tree" })),
              ],
            },
          }),
      },
    },
  };
}

describe("readAtlas", () => {
  it("returns EMPTY_ATLAS when repos.get says the repository is not there", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.reject(httpError(404)),
          getContent: () => Promise.reject(new Error("unused")),
        },
        git: { getTree: () => Promise.resolve({ data: { tree: [] } }) },
      },
    };
    expect(await readAtlas(api, AT)).toEqual(EMPTY_ATLAS);
  });

  it("answers a capacity error on repos.get with the truncated empty atlas, not EMPTY_ATLAS", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.reject(httpError(429)),
          getContent: () => Promise.reject(new Error("unused")),
        },
        git: { getTree: () => Promise.resolve({ data: { tree: [] } }) },
      },
    };
    expect(await readAtlas(api, AT)).toEqual({ packages: [], truncated: true });
  });

  it("propagates an auth error on repos.get — configuration, not a smaller workspace", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.reject(httpError(403)),
          getContent: () => Promise.reject(new Error("unused")),
        },
        git: { getTree: () => Promise.resolve({ data: { tree: [] } }) },
      },
    };
    await expect(readAtlas(api, AT)).rejects.toThrow("HTTP 403");
  });

  it("returns EMPTY_ATLAS when default_branch is empty", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "" } }),
          getContent: () => Promise.reject(new Error("unused")),
        },
        git: { getTree: () => Promise.resolve({ data: { tree: [] } }) },
      },
    };
    expect(await readAtlas(api, AT)).toEqual(EMPTY_ATLAS);
  });

  it("returns EMPTY_ATLAS when the tree itself is not there", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: REF } }),
          getContent: () => Promise.reject(new Error("unused")),
        },
        git: {
          getTree: () => Promise.reject(httpError(404)),
        },
      },
    };
    expect(await readAtlas(api, AT)).toEqual(EMPTY_ATLAS);
  });

  it("answers a capacity error on the tree read as truncated — a timeout must never look like an empty workspace", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: REF } }),
          getContent: () => Promise.reject(new Error("unused")),
        },
        git: {
          getTree: () => Promise.reject(httpError(502)),
        },
      },
    };
    expect(await readAtlas(api, AT)).toEqual({ packages: [], truncated: true });
  });

  it("marks the atlas truncated when the tree API says its own listing was", async () => {
    const files = [
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      {
        path: "packages/a/package.json",
        content: JSON.stringify({ name: "@acme/a", description: "Package A" }),
      },
    ];
    const inner = apiWith(files);
    const api: AtlasApi = {
      rest: {
        ...inner.rest,
        git: {
          getTree: async (params) => {
            const { data } = await inner.rest.git.getTree(params);
            return { data: { ...data, truncated: true } };
          },
        },
      },
    };
    const atlas = await readAtlas(api, AT);
    expect(atlas.truncated).toBe(true);
    expect(atlas.packages.map((p) => p.name)).toEqual(["@acme/a"]);
  });

  it("keeps the members already read and marks truncated when a member read hits capacity", async () => {
    const files = [
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      {
        path: "packages/a/package.json",
        content: JSON.stringify({ name: "@acme/a", description: "Package A" }),
      },
      {
        path: "packages/b/package.json",
        content: JSON.stringify({ name: "@acme/b", description: "Package B" }),
      },
    ];
    const inner = apiWith(files);
    let manifestReads = 0;
    const api: AtlasApi = {
      rest: {
        ...inner.rest,
        repos: {
          ...inner.rest.repos,
          getContent: (params) => {
            if (params.path.endsWith("package.json") && params.path !== "package.json") {
              manifestReads += 1;
              if (manifestReads > 1) return Promise.reject(httpError(429));
            }
            return inner.rest.repos.getContent(params);
          },
        },
      },
    };
    const atlas = await readAtlas(api, AT);
    expect(atlas.truncated).toBe(true);
    expect(atlas.packages.map((p) => p.name)).toEqual(["@acme/a"]);
  });

  it("returns EMPTY_ATLAS when no manifest exists at the root", async () => {
    const api = apiWith([{ path: "README.md", content: "hi" }]);
    expect(await readAtlas(api, AT)).toEqual(EMPTY_ATLAS);
  });

  it("reads a pnpm workspace's members via pnpm-workspace.yaml", async () => {
    const api = apiWith([
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      {
        path: "packages/a/package.json",
        content: JSON.stringify({ name: "@acme/a", description: "Package A" }),
      },
      {
        path: "packages/b/package.json",
        content: JSON.stringify({ name: "@acme/b", description: "Package B" }),
      },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.truncated).toBe(false);
    expect(atlas.packages).toEqual(
      expect.arrayContaining([
        { name: "@acme/a", path: "packages/a", description: "Package A" },
        { name: "@acme/b", path: "packages/b", description: "Package B" },
      ]),
    );
  });

  it("reads npm/yarn classic workspaces (a bare array) from package.json", async () => {
    const api = apiWith([
      { path: "package.json", content: JSON.stringify({ workspaces: ["apps/*"] }) },
      { path: "apps/web/package.json", content: JSON.stringify({ name: "web" }) },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages).toEqual([{ name: "web", path: "apps/web", description: "" }]);
  });

  it("reads yarn 2+ workspaces ({packages: [...]}) from package.json", async () => {
    const api = apiWith([
      { path: "package.json", content: JSON.stringify({ workspaces: { packages: ["apps/*"] } }) },
      { path: "apps/web/package.json", content: JSON.stringify({ name: "web" }) },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages).toEqual([{ name: "web", path: "apps/web", description: "" }]);
  });

  it("reads a Cargo workspace's members", async () => {
    const api = apiWith([
      { path: "Cargo.toml", content: '[workspace]\nmembers = ["crates/a", "crates/b"]\n' },
      { path: "crates/a/Cargo.toml", content: '[package]\nname = "a"\ndescription = "Crate A"\n' },
      { path: "crates/b/Cargo.toml", content: '[package]\nname = "b"\n' },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages).toEqual(
      expect.arrayContaining([
        { name: "a", path: "crates/a", description: "Crate A" },
        { name: "b", path: "crates/b", description: "" },
      ]),
    );
  });

  it("reads a go.work's use directives, single-line and block form", async () => {
    const api = apiWith([
      { path: "go.work", content: "use ./svc-a\nuse (\n\t./svc-b\n\t./svc-c\n)\n" },
      { path: "svc-a/go.mod", content: "module github.com/acme/svc-a\n" },
      { path: "svc-b/go.mod", content: "module github.com/acme/svc-b\n" },
      { path: "svc-c/go.mod", content: "module github.com/acme/svc-c\n" },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages.map((p) => p.name).sort()).toEqual(["svc-a", "svc-b", "svc-c"]);
    expect(atlas.packages.every((p) => p.description === "")).toBe(true);
  });

  it("excludes a directory matched by a leading ! glob", async () => {
    const api = apiWith([
      {
        path: "pnpm-workspace.yaml",
        content: "packages:\n  - packages/*\n  - '!packages/internal-*'\n",
      },
      { path: "packages/a/package.json", content: JSON.stringify({ name: "a" }) },
      { path: "packages/internal-b/package.json", content: JSON.stringify({ name: "internal-b" }) },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages.map((p) => p.name)).toEqual(["a"]);
  });

  it("expands a ** glob to any depth", async () => {
    const api = apiWith([
      { path: "pnpm-workspace.yaml", content: "packages:\n  - apps/**\n" },
      { path: "apps/a/b/package.json", content: JSON.stringify({ name: "deep" }) },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages.map((p) => p.name)).toEqual(["deep"]);
  });

  it("skips a member with no readable manifest, rather than failing the whole read", async () => {
    const api = apiWith([
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      { path: "packages/a/package.json", content: JSON.stringify({ name: "a" }) },
      // packages/b matched by the glob (via its own manifest-less presence is not
      // even in the tree here) is simply absent — readAtlas must not throw.
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages.map((p) => p.name)).toEqual(["a"]);
  });

  it("skips a package.json with no name", async () => {
    const api = apiWith([
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      { path: "packages/a/package.json", content: JSON.stringify({ description: "no name here" }) },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages).toEqual([]);
  });

  it("skips a malformed package.json rather than throwing", async () => {
    const api = apiWith([
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      { path: "packages/a/package.json", content: "{ not json" },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages).toEqual([]);
  });

  it("truncates at ATLAS_MAX_PACKAGES and reports it", async () => {
    const files: File[] = [
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      ...Array.from({ length: ATLAS_MAX_PACKAGES + 5 }, (_v, i) => ({
        path: `packages/p${String(i)}/package.json`,
        content: JSON.stringify({ name: `p${String(i)}` }),
      })),
    ];
    const api = apiWith(files);
    const atlas = await readAtlas(api, AT);
    expect(atlas.truncated).toBe(true);
    expect(atlas.packages).toHaveLength(ATLAS_MAX_PACKAGES);
  });

  it("sanitizes and caps a description", async () => {
    const api = apiWith([
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      {
        path: "packages/a/package.json",
        content: JSON.stringify({ name: "a", description: "x".repeat(300) }),
      },
    ]);
    const atlas = await readAtlas(api, AT);
    expect(atlas.packages[0]?.description.length).toBeLessThanOrEqual(201);
  });

  it("accepts an explicit ref without calling repos.get", async () => {
    let called = false;
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => {
            called = true;
            return Promise.resolve({ data: { default_branch: REF } });
          },
          getContent: () => Promise.reject(httpError(404)),
        },
        git: { getTree: () => Promise.resolve({ data: { tree: [] } }) },
      },
    };
    await readAtlas(api, AT, "some-ref");
    expect(called).toBe(false);
  });
});

describe("matchAtlasEvidence", () => {
  const atlas: Atlas = {
    packages: [
      { name: "@acme/web", path: "apps/web", description: "" },
      { name: "@acme/web-admin", path: "apps/web-admin", description: "" },
    ],
    truncated: false,
  };

  it("returns nothing for text with no path-shaped tokens", () => {
    expect(matchAtlasEvidence(atlas, "just some prose", new Map())).toEqual({
      lines: [],
      candidates: [],
    });
  });

  it("matches a package by its own path", () => {
    const result = matchAtlasEvidence(atlas, "Broken in `apps/web/src/index.ts`.", new Map());
    expect(result.candidates).toEqual(["@acme/web"]);
  });

  it("prefers the longest matching prefix over a shorter one", () => {
    const result = matchAtlasEvidence(atlas, "See apps/web-admin/src/page.tsx", new Map());
    expect(result.candidates).toEqual(["@acme/web-admin"]);
  });

  it("does not match a package whose path is only a prefix of the token's own segment name", () => {
    // apps/web is a package; apps/web-admin/x must not match apps/web.
    const result = matchAtlasEvidence(
      { packages: [{ name: "@acme/web", path: "apps/web", description: "" }], truncated: false },
      "apps/web-admin/x.ts",
      new Map(),
    );
    expect(result.candidates).toEqual([]);
  });

  it("matches a label's own paths: prefix", () => {
    const labelPaths = new Map([["area:docs", ["docs"]]]);
    const result = matchAtlasEvidence(EMPTY_ATLAS, "Typo in docs/guide.md", labelPaths);
    expect(result.candidates).toEqual(["area:docs"]);
  });

  it("never treats a manifest description as a token source — only the passed-in text is scanned", () => {
    const withDescription: Package = {
      name: "x",
      path: "apps/x",
      description: "apps/y mentioned here",
    };
    const result = matchAtlasEvidence(
      { packages: [withDescription], truncated: false },
      "no path mention at all",
      new Map(),
    );
    expect(result.candidates).toEqual([]);
  });

  it("de-duplicates repeated tokens into one candidate", () => {
    const result = matchAtlasEvidence(atlas, "apps/web and again apps/web/thing", new Map());
    expect(result.candidates).toEqual(["@acme/web"]);
  });
});
