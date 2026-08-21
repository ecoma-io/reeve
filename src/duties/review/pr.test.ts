import { describe, expect, it } from "vitest";

import {
  classify,
  isGenerated,
  lineNumbers,
  matchesGlob,
  readPr,
  listPrFiles,
  type PrApi,
  type PrFile,
  type ReviewBounds,
} from "./pr.js";

type PrData = Parameters<PrApi["rest"]["pulls"]["get"]>[0] extends never
  ? never
  : Awaited<ReturnType<PrApi["rest"]["pulls"]["get"]>> extends { data: infer D }
    ? D
    : never;
type FileData =
  Awaited<ReturnType<PrApi["rest"]["pulls"]["listFiles"]>> extends { data: infer D } ? D : never;

function pulls(pr: PrData = {}, files: FileData[] = []): PrApi {
  const listPages = files.length > 0 ? files : [[]];
  return {
    rest: {
      pulls: {
        get: () => Promise.resolve({ data: pr }),
        listFiles: (params) => Promise.resolve({ data: listPages[(params.page ?? 1) - 1] ?? [] }),
      },
    },
  };
}

describe("readPr", () => {
  it("reads the standing, resolving every shape the API sends", async () => {
    const api = pulls({
      title: "Fix the bug",
      body: "Body text",
      state: "open",
      draft: false,
      merged: false,
      head: { sha: "abc123" },
      base: { sha: "base1" },
      user: { login: "octocat", type: "User" },
      labels: ["ready", { name: "ops" }, { name: "" }],
    });
    expect(await readPr(api, { owner: "o", repo: "r", number: 1 })).toEqual({
      title: "Fix the bug",
      body: "Body text",
      state: "open",
      draft: false,
      merged: false,
      headSha: "abc123",
      baseSha: "base1",
      author: { login: "octocat", isBot: false },
      labels: ["ready", "ops"],
    });
  });

  it("treats missing halves as empty rather than as undefined", async () => {
    const api = pulls({});
    expect(await readPr(api, { owner: "o", repo: "r", number: 1 })).toEqual({
      title: "",
      body: "",
      state: "open",
      draft: false,
      merged: false,
      headSha: "",
      baseSha: "",
      author: { login: "", isBot: false },
      labels: [],
    });
  });

  it("flags a bot author", async () => {
    const api = pulls({ user: { login: "reeve[bot]", type: "Bot" } });
    const standing = await readPr(api, { owner: "o", repo: "r", number: 1 });
    expect(standing.author.isBot).toBe(true);
  });
});

describe("listPrFiles", () => {
  it("walks pages until a short page", async () => {
    const api = pulls({}, [
      Array.from({ length: 100 }, (_, i) => ({ filename: `f${String(i)}` })),
      [{ filename: "last" }],
    ]);
    const files = await listPrFiles(api, { owner: "o", repo: "r", number: 1 });
    expect(files).toHaveLength(101);
    expect(files[100]?.path).toBe("last");
  });

  it("maps status and previous name", async () => {
    const api = pulls({}, [
      [
        {
          filename: "a.ts",
          status: "renamed",
          previous_filename: "old.ts",
          additions: 1,
          deletions: 2,
          patch: "@@ -1 +1 @@",
        },
        { filename: "b.ts", status: "what", additions: 0, deletions: 0, patch: null },
      ],
    ]);
    const files = await listPrFiles(api, { owner: "o", repo: "r", number: 1 });
    expect(files[0]).toMatchObject({ path: "a.ts", status: "renamed", previousPath: "old.ts" });
    expect(files[1]).toMatchObject({
      path: "b.ts",
      status: "unknown",
      previousPath: null,
      patch: null,
    });
  });
});

describe("matchesGlob", () => {
  it("matches a literal and every wildcard", () => {
    expect(matchesGlob("docs/generated/**", "docs/generated/a/b.ts")).toBe(true);
    expect(matchesGlob("docs/*.md", "docs/a.md")).toBe(true);
    expect(matchesGlob("docs/*.md", "docs/sub/a.md")).toBe(false);
    expect(matchesGlob("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/?.ts", "src/ab.ts")).toBe(false);
  });

  it("anchors the whole path — a pattern is a whole-path claim", () => {
    expect(matchesGlob("src/", "src/a.ts")).toBe(false);
    expect(matchesGlob("src", "src/a.ts")).toBe(false);
    expect(matchesGlob("src/**", "src/a.ts")).toBe(true);
  });

  it("escapes pattern metacharacters literally", () => {
    expect(matchesGlob("a.b.ts", "a.b.ts")).toBe(true);
    expect(matchesGlob("a.b.ts", "aXb.ts")).toBe(false);
  });
});

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: "a.ts",
    status: "modified",
    previousPath: null,
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    ...overrides,
  };
}

const BOUNDS: ReviewBounds = {
  ignoreFiles: [],
  ignorePaths: [],
  generatedExtensions: [".min.js"],
  maxDiffChars: 10000,
};

describe("classify", () => {
  it("shows a normal file with its proven lines", () => {
    const snapshot = classify([file()], BOUNDS);
    expect(snapshot.capped).toBe(false);
    expect(snapshot.shown).toHaveLength(1);
    expect(snapshot.skipped).toHaveLength(0);
    expect(snapshot.shown[0]?.lines.has(1)).toBe(true);
  });

  it("skips an ignored file silently", () => {
    const snapshot = classify([file({ path: "skip.ts" })], { ...BOUNDS, ignoreFiles: ["skip.ts"] });
    expect(snapshot.skipped).toEqual([{ path: "skip.ts", reason: "ignored" }]);
    expect(snapshot.shown).toHaveLength(0);
  });

  it("skips an ignored path glob", () => {
    const snapshot = classify([file({ path: "docs/generated/out.md" })], {
      ...BOUNDS,
      ignorePaths: ["docs/generated/**"],
    });
    expect(snapshot.skipped[0]).toEqual({ path: "docs/generated/out.md", reason: "ignored" });
  });

  it("skips generated, removed, and binary files with their reasons", () => {
    const snapshot = classify(
      [
        file({ path: "bundle.min.js" }),
        file({ path: "gone.ts", status: "removed" }),
        file({ path: "img.png", patch: null }),
      ],
      BOUNDS,
    );
    expect(snapshot.shown).toHaveLength(0);
    expect(snapshot.skipped.map(({ reason }) => reason).sort()).toEqual([
      "binary",
      "generated",
      "removed",
    ]);
  });

  it("caps a file past the budget whole, not half", () => {
    const snapshot = classify([file({ patch: "x".repeat(100) })], { ...BOUNDS, maxDiffChars: 50 });
    expect(snapshot.skipped).toEqual([{ path: "a.ts", reason: "capped" }]);
    expect(snapshot.capped).toBe(true);
  });

  it("shows files in listing order, consuming the budget in order", () => {
    const snapshot = classify([file({ path: "a.ts" }), file({ path: "b.ts" })], BOUNDS);
    expect(snapshot.shown.map(({ path }) => path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("isGenerated", () => {
  it("matches by suffix", () => {
    expect(isGenerated("a.min.js", [".min.js"])).toBe(true);
    expect(isGenerated("a.js", [".min.js"])).toBe(false);
  });

  it("matches a bare name as an exact basename at any depth, never a substring", () => {
    expect(isGenerated("pnpm-lock.yaml", ["pnpm-lock.yaml"])).toBe(true);
    expect(isGenerated("packages/app/pnpm-lock.yaml", ["pnpm-lock.yaml"])).toBe(true);
    // A substring is not a lockfile: the segment has to match whole.
    expect(isGenerated("xpackage-lock.json", ["package-lock.json"])).toBe(false);
    expect(isGenerated("package-lock.json.orig", ["package-lock.json"])).toBe(false);
  });

  it("matches a separator-carrying name as an exact whole path", () => {
    expect(isGenerated("vendor/modules.txt", ["vendor/modules.txt"])).toBe(true);
    // The basename alone is not the pattern: `modules.txt` elsewhere stays reviewable.
    expect(isGenerated("docs/modules.txt", ["vendor/modules.txt"])).toBe(false);
  });

  it("matches a wildcard pattern as a whole-path glob", () => {
    expect(isGenerated("dist/index.js", ["dist/**"])).toBe(true);
    expect(isGenerated("packages/app/dist/index.js", ["**/dist/**"])).toBe(true);
    // Anchored: a directory merely named around `dist` is not build output.
    expect(isGenerated("redistribute/a.js", ["dist/**"])).toBe(false);
  });
});

describe("lineNumbers", () => {
  const patch = [
    "@@ -10,3 +20,3 @@",
    " context",
    "+plus",
    "-minus",
    "@@ -30 +40,0 @@",
    "+orphan",
  ].join("\n");

  it("maps context and plus lines to new-line numbers, skipping minus and hunk headers", () => {
    const lines = lineNumbers(patch);
    expect(lines.get(20)).toBe("context");
    expect(lines.get(21)).toBe("plus");
    expect(lines.has(40)).toBe(true);
    expect([...lines.keys()]).toEqual([20, 21, 40]);
  });

  it("returns an empty map on a patch with no hunks", () => {
    expect(lineNumbers("plain text")).toEqual(new Map());
  });
});
