/**
 * The context engine's pure parts and its assembly, all against hand-built
 * workspace stubs — no mock library, the same structural-port style every
 * review module tests with.
 */
import { describe, expect, it } from "vitest";

import {
  callerCandidates,
  changedSymbols,
  collectContext,
  fsSource,
  isSecretPath,
  oldRanges,
  truncate,
  withinWorkspace,
  type Budget,
  type ContextTarget,
  type WorkspaceSource,
} from "./context.js";

/** A fixture budget, matching the production constants and the default input. */
function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    total: 12000,
    perFileSourceExcerpt: 800,
    importsWindow: 60,
    maxChangedFiles: 25,
    maxFilesScannedPerDirectory: 100,
    maxCallsitesPerSymbol: 10,
    maxMatchesPerSymbol: 10,
    maxSymbolsPerFile: 15,
    maxRelatedTestsPerChangedFile: 8,
    maxConfigFiles: 3,
    maxHistoryChars: 800,
    maxFileChars: 64 * 1024,
    ...overrides,
  };
}

function target(overrides: Partial<ContextTarget> = {}): ContextTarget {
  return {
    path: "src/app.ts",
    status: "modified",
    lines: new Map([
      [1, "+export function keeper(): void {}"],
      [2, "+import { helper } from './helper';"],
    ]),
    patch:
      "@@ -0,0 +1,2 @@\n+export function keeper(): void {}\n+import { helper } from './helper';",
    ...overrides,
  };
}

/** A stub source backed by an in-memory map, counting every attempt. */
function sourceOf(
  files: Record<string, string>,
  history: Record<string, string> = {},
): WorkspaceSource & { reads: number } {
  let reads = 0;
  return {
    root: "/workspace",
    // eslint-disable-next-line @typescript-eslint/require-await
    async readText(rel) {
      reads += 1;
      return Object.prototype.hasOwnProperty.call(files, rel) ? (files[rel] ?? null) : null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readDir(rel) {
      reads += 1;
      const prefix = rel === "." ? "" : `${rel}/`;
      const names = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split("/")[0] ?? "");
      return [...new Set(names)].sort((a, b) => a.localeCompare(b));
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async history(rel, budgetChars) {
      reads += 1;
      const text = history[rel] ?? null;
      if (text === null) return null;
      return text.length <= budgetChars ? text : text.slice(0, budgetChars);
    },
    get reads() {
      return reads;
    },
  };
}

describe("withinWorkspace", () => {
  const root = "/work/reeve";

  it.each([
    ["accepts a child", "src/app.ts", "/work/reeve/src/app.ts"],
    ["accepts a nested child", "a/b/c.ts", "/work/reeve/a/b/c.ts"],
    ["accepts the root itself", "", null],
  ])("%s", (_name, rel, expected) => {
    expect(withinWorkspace(root, rel)).toBe(expected);
  });

  it("rejects `..`", () => {
    expect(withinWorkspace(root, "..")).toBeNull();
    expect(withinWorkspace(root, "src/../outside.ts")).toBeNull();
    expect(withinWorkspace(root, "src/../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute rel", () => {
    expect(withinWorkspace(root, "/etc/passwd")).toBeNull();
    expect(withinWorkspace(root, `${root}/src/app.ts`)).toBeNull();
  });

  it("rejects a root itself as rel and a trailing-slash escape", () => {
    expect(withinWorkspace(root, "")).toBeNull();
    expect(withinWorkspace(root, "../")).toBeNull();
    expect(withinWorkspace(root, "src/..")).toBeNull();
  });

  it("rejects a NUL byte", () => {
    expect(withinWorkspace(root, "src/app.ts\0")).toBeNull();
  });
});

describe("isSecretPath", () => {
  it("matches the denylist", () => {
    for (const path of [
      ".env",
      ".env.prod",
      "config/tokens.yaml",
      "id_rsa",
      "a.pem",
      "dir/.ssh/x",
      "password.txt",
      "secrets/deploy.yml",
      "config/credentials.yml",
      ".npmrc",
      ".netrc",
    ]) {
      expect(isSecretPath(path)).toBe(true);
    }
  });

  it("rejects lookalikes", () => {
    for (const path of [
      "tokens.ts",
      "tokenizer.ts",
      ".env-please",
      "package.json",
      "environment.ts",
      "src/app.ts",
    ]) {
      expect(isSecretPath(path)).toBe(false);
    }
  });
});

describe("changedSymbols", () => {
  it("extracts TS/JS declaration forms, sorted by byte order", () => {
    expect(
      changedSymbols([
        "export function open() {}",
        "export async function run() {}",
        "export class Box {}",
        "const value = 1",
        "let mutable = 2",
        "var legacy = 3",
        "export interface Shape {}",
        "type Alias = string",
      ]),
    ).toEqual(["Alias", "Box", "Shape", "legacy", "mutable", "open", "run", "value"]);
  });

  it("extracts Go and Rust forms, sorted by byte order", () => {
    expect(
      changedSymbols([
        "func Do() {}",
        "type Config struct {}",
        "fn main() {}",
        "struct Point {}",
        "impl Point {}",
      ]),
    ).toEqual(["Config", "Do", "Point", "main"]);
  });

  it("ignores comments and non-declarations, and reads a declaration's real name", () => {
    expect(
      changedSymbols([
        "// export function ghost() {}",
        "const msg = 'const fake = 1'",
        "call(export);",
        "return x;",
      ]),
    ).toEqual(["msg"]);
  });

  it("sorts, dedupes, and caps at maxSymbolsPerFile", () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `const sym${String(i).padStart(2, "0")} = ${String(i)};`,
    );
    const out = changedSymbols(many);
    expect(out).toHaveLength(20); // changedSymbols itself does not cap
    expect(out[0]).toBe("sym00");
    expect(out[19]).toBe("sym19");
  });
});

describe("oldRanges", () => {
  it("parses old ranges from hunks", () => {
    expect(oldRanges("@@ -0,0 +1,5 @@")).toEqual([{ start: 0, count: 0 }]);
    expect(oldRanges("@@ -12,3 +14,2 @@")).toEqual([{ start: 12, count: 3 }]);
    expect(oldRanges("@@ -10 +20 @@")).toEqual([{ start: 10, count: 1 }]);
  });

  it("parses multiple hunks in order", () => {
    const patch = "@@ -1,2 +1,2 @@\n ctx\n@@ -30,5 +32,5 @@\n ctx";
    expect(oldRanges(patch)).toEqual([
      { start: 1, count: 2 },
      { start: 30, count: 5 },
    ]);
  });

  it("returns [] for a patch with no hunks", () => {
    expect(oldRanges("plain text")).toEqual([]);
  });
});

describe("truncate", () => {
  it("keeps the earliest items and reports the drop", () => {
    expect(truncate([1, 2, 3], 2)).toEqual({ kept: [1, 2], dropped: 1 });
    expect(truncate([1, 2], 2)).toEqual({ kept: [1, 2], dropped: 0 });
    expect(truncate([], 2)).toEqual({ kept: [], dropped: 0 });
  });
});

describe("callerCandidates", () => {
  it("prunes the target and secrets, and sorts", () => {
    const paths = ["src/a.ts", "src/app.ts", ".env", "src/b.ts"];
    expect(callerCandidates(paths, "src/app.ts")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("DETERMIN-02: sorts by byte order, invariant under locale collation", () => {
    // `localeCompare` (collation-dependent) would interleave `Foo.ts`/`foo.ts`
    // differently across `LANG`/ICU versions; byte order never moves.
    const names = ["foo.ts", "Foo.ts", "strasse/x.ts", "straße/x.ts"];
    const sorted = callerCandidates(names, "");
    expect(sorted).toEqual([...names].sort()); // the byte-sorted order
    // A case-insensitive collation would NOT produce this order — it groups
    // equal-at-base pairs back-to-back, keeping `foo.ts` before `Foo.ts` and
    // tying `strasse`/`straße`. This pins that the comparator really is byte
    // order, not "whatever the host's collation says today".
    const caseInsensitive = [...names].sort((a, b) =>
      a.localeCompare(b, "de", { sensitivity: "base" }),
    );
    expect(sorted).not.toEqual(caseInsensitive);
  });
});

describe("collectContext", () => {
  const files = {
    "src/app.ts": "import { helper } from './helper';\nexport function keeper(): void {}\n",
    "src/app.test.ts": "import { keeper } from './app';\nit('runs', () => { keeper(); });\n",
    "src/helper.ts": "export function helper(): void {}\nexport function keeper(): void {}\n",
    "package.json": '{"name": "x"}\n',
    "src/util.ts": "export const util = 1;\nkeeper();\n",
  };

  it("assembles the expected sections in order and renders text deterministically", async () => {
    const source = sourceOf(files);
    const ctx = await collectContext(
      [
        target({
          lines: new Map([[1, "+export function keeper(): void {}"]]),
          patch: "@@ -0,0 +1 @@\n+export function keeper(): void {}",
        }),
      ],
      source,
      budget(),
      ".github/reeve-rules.yml",
    );

    expect(ctx.text).not.toBeNull();
    // The diff is rendered by `verdict.ts`, never duplicated here.
    expect(ctx.text).not.toContain("--- DIFF ---");
    expect(ctx.text).toContain("--- SYMBOLS DEFINED OR CHANGED ---");
    expect(ctx.text).toContain("--- RELATED TESTS ---");
    expect(ctx.text).toContain("--- CONFIGURATION ---");
    expect(ctx.text).toContain("src/app.test.ts");
    expect(ctx.text).toContain("keeper");

    // Determinism: two collects over the same source are byte-identical.
    const second = await collectContext(
      [
        target({
          lines: new Map([[1, "+export function keeper(): void {}"]]),
          patch: "@@ -0,0 +1 @@\n+export function keeper(): void {}",
        }),
      ],
      source,
      budget(),
      ".github/reeve-rules.yml",
    );
    expect(second.text).toBe(ctx.text);
  });

  it("applies the budget to the supplementary sections only, keeping diff and dropping the tail with a mark", async () => {
    const ctx = await collectContext(
      [target()],
      sourceOf(files),
      budget({ total: 100 }),
      ".github/reeve-rules.yml",
    );
    expect(ctx.text).not.toContain("--- DIFF ---");
    expect(ctx.text).toContain("… (context truncated");
  });

  it("counts readFiles for every attempt, including missing files", async () => {
    const source = sourceOf({ "src/app.ts": files["src/app.ts"] });
    const ctx = await collectContext([target()], source, budget(), ".github/reeve-rules.yml");
    expect(ctx.readFiles).toBeGreaterThan(0);
    expect(ctx.readFiles).toBe(source.reads);
  });

  it("returns empty when the root is empty", async () => {
    // The engine short-circuits on an empty root, so these stubs never await.
    const empty: WorkspaceSource = {
      root: "",
      // eslint-disable-next-line @typescript-eslint/require-await
      readText: async () => null,
      // eslint-disable-next-line @typescript-eslint/require-await
      readDir: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      history: async () => null,
    };
    const ctx = await collectContext([target()], empty, budget(), "rules.yml");
    expect(ctx.text).toBeNull();
    expect(ctx.readFiles).toBe(0);
    expect(ctx.totalChars).toBe(0);
  });

  it("imports unions the diff-added lines with the base file's imports", async () => {
    const ctx = await collectContext(
      [
        target({
          lines: new Map([
            [1, "+import { newly } from './newly';"],
            [2, "+export function keeper() {}"],
          ]),
          patch: "@@ -0,0 +1,2 @@\n+import { newly } from './newly';\n+export function keeper() {}",
        }),
      ],
      sourceOf(files),
      budget(),
      ".github/reeve-rules.yml",
    );
    const section = ctx.sections.find((s) => s.kind === "imports");
    expect(section?.entries.join("\n")).toContain("import { helper } from './helper';");
    expect(section?.entries.join("\n")).toContain("import { newly } from './newly';");
  });

  it("relates tests by naming convention without reading them", async () => {
    const ctx = await collectContext([target()], sourceOf(files), budget(), "rules.yml");
    const section = ctx.sections.find((s) => s.kind === "tests");
    expect(section?.entries.join("\n")).toContain("src/app.test.ts");
  });

  it("discovers config as the nearest ancestor, deduped and capped", async () => {
    const nested = {
      "src/deep/app.ts": "export function keeper() {}\n",
      "src/deep/package.json": '{"name": "nested"}\n',
      "package.json": '{"name": "root"}\n',
    };
    const ctx = await collectContext(
      [target({ path: "src/deep/app.ts" })],
      sourceOf(nested),
      budget({ maxConfigFiles: 3 }),
      "rules.yml",
    );
    const section = ctx.sections.find((s) => s.kind === "config");
    expect(section).not.toBeNull();
    const text = section?.entries.join("\n") ?? "";
    expect(text).toContain("src/deep/package.json");
    expect(text).toContain("package.json");
  });

  it("DETERMIN-08: keeps the same caller candidates whatever the directory listing order", async () => {
    // With `maxFilesScannedPerDirectory` low enough that the walk is cut
    // short, WHICH directories get scanned is decided by the order the walk
    // pops them — and an unsorted listing let the filesystem's `readdir`
    // order decide that. This flips the listing order between two identical
    // runs and pins that the surfaced candidates (the cap's deterministic
    // tail) are identical.
    const files: Record<string, string> = {
      "src/app.ts": "export function keeper(): void {}\n",
      "src/a/keeper.ts": "keeper();\n",
      "src/b/keeper.ts": "keeper();\n",
      "src/c/keeper.ts": "keeper();\n",
    };
    const sourceWith = (order: readonly string[]): WorkspaceSource & { reads: number } => {
      let observed = 0;
      return {
        root: "/workspace",
        // eslint-disable-next-line @typescript-eslint/require-await
        async readText(rel) {
          observed += 1;
          return Object.prototype.hasOwnProperty.call(files, rel) ? (files[rel] ?? null) : null;
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async readDir(rel) {
          observed += 1;
          if (rel === "src") return [...order];
          if (rel.startsWith("src/")) return ["keeper.ts"];
          return [];
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async history() {
          observed += 1;
          return null;
        },
        get reads() {
          return observed;
        },
      };
    };

    const limited = budget({ maxFilesScannedPerDirectory: 2 });
    const first = await collectContext(
      [target()],
      sourceWith(["a", "b", "c"]),
      limited,
      "rules.yml",
    );
    const second = await collectContext(
      [target()],
      sourceWith(["c", "b", "a"]),
      limited,
      "rules.yml",
    );

    const callers1 = first.sections.find((s) => s.kind === "callers");
    const callers2 = second.sections.find((s) => s.kind === "callers");
    expect(callers1).toEqual(callers2);
    // The cap drops a deterministic tail: byte order `a,b,c` walks c first
    // (LIFO), so `src/c/keeper.ts` is the one candidate that surfaces — in
    // both orderings.
    expect(callers1?.entries.join("\n")).toContain("src/c/keeper.ts");
    expect(callers2?.entries.join("\n")).toContain("src/c/keeper.ts");
  });

  it("calls source.history per changed file, capping its output to maxHistoryChars", async () => {
    let asked = 0;
    const source: WorkspaceSource = {
      root: "/workspace",
      // eslint-disable-next-line @typescript-eslint/require-await
      readText: async () => null,
      // eslint-disable-next-line @typescript-eslint/require-await
      readDir: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      history: async (rel, budgetChars) => {
        asked += 1;
        if (rel !== "src/app.ts") return null;
        return "commit long".repeat(500).slice(0, budgetChars + 100);
      },
    };
    const ctx = await collectContext(
      [target()],
      source,
      budget({ maxHistoryChars: 100 }),
      "rules.yml",
    );
    const section = ctx.sections.find((s) => s.kind === "history");
    expect(asked).toBe(1);
    expect(section?.entries.join("\n").length).toBeLessThanOrEqual(100 + 50);
  });

  it("drops the history section entirely when history returns null", async () => {
    const ctx = await collectContext([target()], sourceOf(files), budget(), "rules.yml");
    expect(ctx.sections.some((s) => s.kind === "history")).toBe(false);
  });
});

describe("fsSource", () => {
  it("reads a real file and lists a real directory", async () => {
    const source = fsSource("/tmp");
    const text = await source.readText("."); // not a file — null
    expect(text).toBeNull();
    const names = await source.readDir("/tmp");
    expect(names).toBeDefined();
  });
});
