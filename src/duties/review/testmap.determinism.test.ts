/**
 * DETERMIN-01 regression: `discoverTests` must yield the same discovery for
 * the same tree whatever order `readdir` returns its entries in.
 *
 * The walk byte-sorts every listing before processing it, so the BFS order —
 * and, more importantly, which entries survive the entry/file/char budgets — is
 * a function of the tree, not of the filesystem's directory enumeration order.
 * These tests flip the mocked `readdir` order between two identical runs and
 * assert identical results, including under a cap that cuts a tail.
 */
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const orders: Record<string, string[]> = {};
  const contents: Record<string, string> = {};
  const dirs = new Set<string>();
  return { orders, contents, dirs };
});

vi.mock("node:fs/promises", () => ({
  readdir: (path: string) => Promise.resolve(mocks.orders[path] ?? []),
  stat: (path: string) => Promise.resolve({ isDirectory: () => mocks.dirs.has(path) }),
  readFile: (path: string) => Promise.resolve(mocks.contents[path] ?? ""),
}));

import { discoverTests, MAX_TEST_FILES } from "./testmap.js";

describe("discoverTests — readdir-order invariance", () => {
  it("returns the identical test list in either readdir order", async () => {
    const root = "/ws";
    mocks.dirs.add(join(root, "src"));
    mocks.orders[root] = ["src"];
    mocks.orders[join(root, "src")] = ["a.test.ts", "b.test.ts", "c.test.ts"];
    mocks.contents[join(root, "src/a.test.ts")] = "it('a')";
    mocks.contents[join(root, "src/b.test.ts")] = "it('b')";
    mocks.contents[join(root, "src/c.test.ts")] = "it('c')";

    const first = await discoverTests(root);
    mocks.orders[join(root, "src")] = ["c.test.ts", "b.test.ts", "a.test.ts"];
    const second = await discoverTests(root);

    expect(first.tests).toEqual(second.tests);
    // Byte order wins: `a/b/c`, not the listing's order.
    expect(first.tests.map((t) => t.rel)).toEqual([
      "src/a.test.ts",
      "src/b.test.ts",
      "src/c.test.ts",
    ]);
  });

  it("keeps the identical candidate set under the test-file cap in either readdir order", async () => {
    const root = "/ws";
    mocks.dirs.add(join(root, "src"));
    mocks.orders[root] = ["src"];
    // More test files than the budget, so the cap cuts a tail. Which tail is
    // cut is where a listing-order dependency used to leak in.
    const names = Array.from(
      { length: MAX_TEST_FILES + 10 },
      (_, i) => `f${String(i).padStart(3, "0")}.test.ts`,
    );
    for (const name of names) {
      mocks.contents[join(root, "src", name)] = `it(${JSON.stringify(name)})`;
    }

    mocks.orders[join(root, "src")] = [...names];
    const first = await discoverTests(root);
    mocks.orders[join(root, "src")] = [...names].reverse();
    const second = await discoverTests(root);

    expect(first.tests.map((t) => t.rel)).toEqual(second.tests.map((t) => t.rel));
    // The byte-lowest 200 survive, in byte order, whatever the listing said.
    expect(first.tests.map((t) => t.rel)).toEqual(
      names.slice(0, MAX_TEST_FILES).map((name) => `src/${name}`),
    );
  });

  it("agree byte-for-byte on the discovered files (content included)", async () => {
    const root = "/ws";
    mocks.dirs.add(join(root, "src"));
    mocks.orders[root] = ["src"];
    mocks.orders[join(root, "src")] = ["z.test.ts", "a.test.ts", "m.test.ts"];
    mocks.contents[join(root, "src/z.test.ts")] = "it('z')";
    mocks.contents[join(root, "src/a.test.ts")] = "it('a')";
    mocks.contents[join(root, "src/m.test.ts")] = "it('m')";

    const first = await discoverTests(root);
    mocks.orders[join(root, "src")] = ["m.test.ts", "a.test.ts", "z.test.ts"];
    const second = await discoverTests(root);

    // Same discovery → same evidence (each TestFile's rel AND content).
    expect(second.tests).toEqual(first.tests);
  });
});
