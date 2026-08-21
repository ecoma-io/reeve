/**
 * DETERMIN — the atlas is a function of the repository, not of the order the
 * tree API listed it.
 *
 * `readAtlas` builds its member list out of `git.getTree(recursive)`. That
 * response is one array holding every blob and every tree in the repository,
 * and nothing in the contract of the endpoint promises an order: a re-listing
 * after a rename, a repository served from a different replica, or a future
 * change to how GitHub walks a tree can all hand the same commit back in a
 * different sequence.
 *
 * Three things downstream care, and each is a different kind of harm:
 *
 *  - `packages` is the vocabulary anchor a triage prompt is built from, so a
 *    reordering that moved it would change the prompt for an unchanged
 *    repository and, with it, the labels a model proposes;
 *  - `propose.ts` derives a computed area label per package, and `matchAtlasEvidence`
 *    resolves a path mention by longest prefix over this same list;
 *  - past `ATLAS_MAX_PACKAGES` the list is *cut*, and which members survive a
 *    cut is exactly where a listing-order dependency does real damage — a
 *    package could drift in and out of the atlas between two runs of the same
 *    commit, and a package that looks absent is a package that looks retired.
 *
 * The walk sorts (`expandGlobs`), so the claim should hold. These tests are
 * what make that a pinned claim rather than an implementation detail: they
 * drive `readAtlas` twice over the same repository with the tree shuffled, and
 * assert the two atlases are identical — including under a cap that cuts a
 * tail, and across the four manifest kinds at once.
 *
 * The stub is `atlas.test.ts`'s, plus a knob for the order the tree is served
 * in. Nothing here reaches a network.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { readAtlas, type Atlas, type AtlasApi } from "./atlas.js";

const AT = { owner: "acme", repo: "widgets" };
const REF = "main";

/** The cap is module-private in `atlas.ts`; mirrored here the way `atlas.test.ts` mirrors it. */
const ATLAS_MAX_PACKAGES = 200;

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { status });
}

interface File {
  readonly path: string;
  readonly content: string;
}

interface TreeEntry {
  readonly path: string;
  readonly type: string;
}

/** Every entry `git.getTree(recursive)` would carry for `files` — blobs, then the directories they imply. */
function treeOf(files: readonly File[]): TreeEntry[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const segments = f.path.split("/");
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join("/"));
  }
  return [
    ...files.map((f) => ({ path: f.path, type: "blob" })),
    ...[...dirs].map((d) => ({ path: d, type: "tree" })),
  ];
}

/**
 * A stub `AtlasApi` that serves the tree in exactly `order` — the caller
 * supplies the permutation, so a test can say "the same repository, listed
 * differently" without touching anything else.
 */
function apiWith(files: readonly File[], order: (tree: TreeEntry[]) => TreeEntry[]): AtlasApi {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const tree = treeOf(files);

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
        getTree: () => Promise.resolve({ data: { tree: order([...tree]) } }),
      },
    },
  };
}

const IDENTITY = (tree: TreeEntry[]): TreeEntry[] => tree;
const REVERSED = (tree: TreeEntry[]): TreeEntry[] => [...tree].reverse();

/** A four-ecosystem monorepo — every manifest kind `readAtlas` knows, in one tree. */
const POLYGLOT: readonly File[] = [
  {
    path: "pnpm-workspace.yaml",
    content: "packages:\n  - packages/*\n",
  },
  {
    path: "packages/alpha/package.json",
    content: JSON.stringify({ name: "alpha", description: "A" }),
  },
  {
    path: "packages/beta/package.json",
    content: JSON.stringify({ name: "beta", description: "B" }),
  },
  {
    path: "packages/gamma/package.json",
    content: JSON.stringify({ name: "gamma", description: "G" }),
  },
  { path: "Cargo.toml", content: '[workspace]\nmembers = ["crates/one", "crates/two"]\n' },
  { path: "crates/one/Cargo.toml", content: '[package]\nname = "one"\ndescription = "1"\n' },
  { path: "crates/two/Cargo.toml", content: '[package]\nname = "two"\ndescription = "2"\n' },
  { path: "go.work", content: "use (\n  ./services/api\n  ./services/worker\n)\n" },
  { path: "services/api/go.mod", content: "module example.com/api\n" },
  { path: "services/worker/go.mod", content: "module example.com/worker\n" },
];

describe("readAtlas — tree-listing-order invariance", () => {
  it("returns the identical atlas whichever order the tree API listed the repository", async () => {
    const forward = await readAtlas(apiWith(POLYGLOT, IDENTITY), AT, REF);
    const backward = await readAtlas(apiWith(POLYGLOT, REVERSED), AT, REF);

    expect(backward).toEqual(forward);
    // And it is the byte order of the member directories, not the listing's:
    // the assertion names the answer so a future change that made the walk
    // order-carrying could not pass by reordering both sides.
    expect(forward.packages.map((p) => p.path)).toEqual([
      "packages/alpha",
      "packages/beta",
      "packages/gamma",
      "crates/one",
      "crates/two",
      "services/api",
      "services/worker",
    ]);
    expect(forward.truncated).toBe(false);
  });

  it("holds for any permutation of the tree, not just the reversal", async () => {
    const reference = await readAtlas(apiWith(POLYGLOT, IDENTITY), AT, REF);
    // Permuting the tree's own indices rather than a guessed length: a
    // permutation shorter than the tree would silently *drop* entries, which
    // is a different claim and one this test must not accidentally make.
    const size = treeOf(POLYGLOT).length;

    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([...Array(size).keys()], { minLength: size, maxLength: size }),
        async (permutation) => {
          expect(permutation).toHaveLength(size);
          const shuffle = (tree: TreeEntry[]): TreeEntry[] =>
            permutation
              .map((index) => tree[index])
              .filter((entry): entry is TreeEntry => entry !== undefined);
          expect(await readAtlas(apiWith(POLYGLOT, shuffle), AT, REF)).toEqual(reference);
        },
      ),
      { numRuns: 40, seed: 20_260_821 },
    );
  });

  it("keeps the identical members under the package cap, whichever order the tree arrived in", async () => {
    // More workspace members than the cap, so a tail is cut. Which tail is cut
    // is the thing a listing-order dependency would decide, and a package
    // silently outside the atlas is a package `propose.ts` may read as retired.
    const many: File[] = [{ path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" }];
    for (let i = 0; i < ATLAS_MAX_PACKAGES + 25; i += 1) {
      const slug = `p${String(i).padStart(4, "0")}`;
      many.push({
        path: `packages/${slug}/package.json`,
        content: JSON.stringify({ name: slug, description: slug }),
      });
    }

    const forward = await readAtlas(apiWith(many, IDENTITY), AT, REF);
    const backward = await readAtlas(apiWith(many, REVERSED), AT, REF);

    expect(forward.truncated).toBe(true);
    expect(forward.packages).toHaveLength(ATLAS_MAX_PACKAGES);
    expect(backward.packages.map((p) => p.name)).toEqual(forward.packages.map((p) => p.name));
    // The byte-lowest members survive, in byte order, whatever the listing said.
    expect(forward.packages[0]?.name).toBe("p0000");
    expect(forward.packages[ATLAS_MAX_PACKAGES - 1]?.name).toBe(
      `p${String(ATLAS_MAX_PACKAGES - 1).padStart(4, "0")}`,
    );
  });

  it("a partial read cut short by capacity keeps the same members in either listing order", async () => {
    // Capacity mid-walk returns what was already read and marks the atlas
    // truncated. What "already read" means is a prefix of the member order, so
    // this is the same claim as the cap above, reached down a different path.
    const files: readonly File[] = [
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      { path: "packages/a/package.json", content: JSON.stringify({ name: "a" }) },
      { path: "packages/b/package.json", content: JSON.stringify({ name: "b" }) },
      { path: "packages/c/package.json", content: JSON.stringify({ name: "c" }) },
    ];

    async function readUntilCapacity(order: (tree: TreeEntry[]) => TreeEntry[]): Promise<Atlas> {
      const base = apiWith(files, order);
      let reads = 0;
      return readAtlas(
        {
          rest: {
            repos: {
              get: base.rest.repos.get,
              getContent: (params) => {
                if (params.path.startsWith("packages/")) {
                  reads += 1;
                  if (reads > 2) return Promise.reject(httpError(429));
                }
                return base.rest.repos.getContent(params);
              },
            },
            git: base.rest.git,
          },
        },
        AT,
        REF,
      );
    }

    const forward = await readUntilCapacity(IDENTITY);
    const backward = await readUntilCapacity(REVERSED);

    expect(forward).toEqual({
      packages: [
        { name: "a", path: "packages/a", description: "" },
        { name: "b", path: "packages/b", description: "" },
      ],
      truncated: true,
    });
    expect(backward).toEqual(forward);
  });
});
