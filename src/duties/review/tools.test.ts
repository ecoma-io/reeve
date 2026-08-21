import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_BUDGET, REVIEW_TOOLS, createToolExecutor, type ToolBudget } from "./tools.js";
import type { WorkspaceSource } from "./context.js";
import type { PrFile } from "./pr.js";

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: "src/a.ts",
    status: "modified",
    previousPath: null,
    additions: 2,
    deletions: 1,
    patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n context",
    ...overrides,
  };
}

function stubSource(texts: Record<string, string>): WorkspaceSource {
  return {
    root: "/workspace",
    readText: (rel) => Promise.resolve(texts[rel] ?? null),
    readDir: () => Promise.resolve([]),
    history: () => Promise.resolve(null),
  };
}

function call(name: string, args: unknown = {}): { id: string; name: string; arguments: string } {
  return { id: "c1", name, arguments: JSON.stringify(args) };
}

const BUDGET: ToolBudget = { ...DEFAULT_TOOL_BUDGET, maxResultChars: 200, maxFileLines: 5 };

describe("REVIEW_TOOLS", () => {
  it("offers exactly the three read tools", () => {
    expect(REVIEW_TOOLS.map((tool) => tool.name)).toEqual([
      "list_changed_files",
      "read_diff",
      "read_file",
    ]);
  });
});

describe("createToolExecutor", () => {
  it("lists every changed file with its skip reason", async () => {
    const executor = createToolExecutor(
      [file(), file({ path: "pnpm-lock.yaml", additions: 900 })],
      new Map([["pnpm-lock.yaml", "generated"]]),
      null,
      BUDGET,
    );
    const text = await executor.execute(call("list_changed_files"));
    expect(text).toContain("src/a.ts — modified, +2 -1");
    expect(text).toContain("pnpm-lock.yaml");
    expect(text).toContain("skipped: generated");
  });

  it("serves a diff in pages and refuses a page past the end", async () => {
    const long = `@@ -1 +1 @@\n${"+x\n".repeat(300)}`;
    const executor = createToolExecutor([file({ patch: long })], new Map(), null, BUDGET);
    const first = await executor.execute(call("read_diff", { path: "src/a.ts" }));
    expect(first).toContain("page 1/");
    const bad = await executor.execute(call("read_diff", { path: "src/a.ts", page: 99 }));
    expect(bad).toContain("Error");
  });

  it("refuses the diff of a skipped file — a skip the model could read around is not a skip", async () => {
    const executor = createToolExecutor(
      [file({ path: "pnpm-lock.yaml" })],
      new Map([["pnpm-lock.yaml", "generated"]]),
      null,
      BUDGET,
    );
    const text = await executor.execute(call("read_diff", { path: "pnpm-lock.yaml" }));
    expect(text).toContain("Error");
    expect(text).toContain("generated");
  });

  it("refuses a file this pull request never changed", async () => {
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);
    const text = await executor.execute(call("read_diff", { path: "src/other.ts" }));
    expect(text).toContain("Error");
  });

  it("reads a numbered base-branch excerpt, capped to the line span budget", async () => {
    const source = stubSource({
      "src/a.ts": ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n"),
    });
    const executor = createToolExecutor([file()], new Map(), source, BUDGET);
    const text = await executor.execute(call("read_file", { path: "src/a.ts", start: 2, end: 99 }));
    expect(text).toContain("2 | l2");
    expect(text).toContain("6 | l6"); // 5-line span cap from start=2
    expect(text).not.toContain("7 | l7");
  });

  it("refuses a secret path before any read happens", async () => {
    // "Before any read" is the claim, so the source records what it was asked
    // for and the case asserts it was asked for nothing: a denylist that fired
    // only on the way back would already have had the file in memory.
    const asked: string[] = [];
    const source: WorkspaceSource = {
      root: "/workspace",
      readText: (rel) => {
        asked.push(rel);
        return Promise.resolve("TOKEN=x");
      },
      readDir: () => Promise.resolve([]),
      history: () => Promise.resolve(null),
    };
    const executor = createToolExecutor([file()], new Map(), source, BUDGET);
    const text = await executor.execute(call("read_file", { path: ".env" }));
    expect(text).toContain("Error");
    expect(text).not.toContain("TOKEN=x");
    expect(asked).toEqual([]);
    expect(executor.trace().at(-1)?.ok).toBe(false);
  });

  it("says so when there is no checkout instead of pretending an empty file", async () => {
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);
    const text = await executor.execute(call("read_file", { path: "src/a.ts" }));
    expect(text).toContain("no workspace checkout");
  });

  it("answers malformed arguments and unknown tools with errors, never a throw", async () => {
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);
    const badJson = await executor.execute({ id: "c", name: "read_diff", arguments: "{nope" });
    expect(badJson).toContain("Error");
    const unknown = await executor.execute(call("delete_repo"));
    expect(unknown).toContain("Error");
    expect(executor.trace()).toHaveLength(2);
  });

  it("exhausts the pull budget loudly and refuses further reads", async () => {
    const tiny: ToolBudget = { ...BUDGET, maxTotalPullChars: 10 };
    const executor = createToolExecutor([file()], new Map(), null, tiny);
    await executor.execute(call("list_changed_files"));
    const after = await executor.execute(call("read_diff", { path: "src/a.ts" }));
    expect(after).toContain("exhausted");
    expect(executor.pulled()).toBeGreaterThan(10);
  });

  it("counts every answer in the trace with its size", async () => {
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);
    await executor.execute(call("list_changed_files"));
    const entry = executor.trace()[0];
    expect(entry?.name).toBe("list_changed_files");
    expect(entry?.ok).toBe(true);
    expect(entry?.chars).toBeGreaterThan(0);
  });
});
