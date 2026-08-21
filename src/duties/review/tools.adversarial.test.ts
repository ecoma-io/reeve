/**
 * The tool executor as a boundary against a model that misbehaves.
 *
 * `tools.test.ts` asks what the three tools serve when the model asks for
 * something sensible. This file asks the other question, which is the one
 * CONTRIBUTING's reviewer bar names: what happens when the arguments are not
 * what the schema demanded, when the file the model names cannot be served,
 * and when the model spends its whole budget on calls that answer nothing.
 *
 * Two properties hold across every case here, and they are what makes the
 * loop bounded rather than merely usually-short:
 *
 * - **A refused call answers, it never throws.** `agenticAnswer` replays every
 *   call id back into the conversation, so a throw out of `execute` would end
 *   the pass on the model's malformed JSON rather than letting it correct
 *   itself inside the round budget.
 * - **A refusal still costs.** Every answer — served or refused — is counted
 *   against `maxTotalPullChars`, so a model that only ever sends garbage still
 *   runs out of budget instead of looping until the round cap.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolCall } from "../../core/provider.js";
import { fsSource, type WorkspaceSource } from "./context.js";
import type { PrFile } from "./pr.js";
import { DEFAULT_TOOL_BUDGET, createToolExecutor, type ToolBudget } from "./tools.js";

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: "src/a.ts",
    status: "modified",
    previousPath: null,
    additions: 2,
    deletions: 1,
    patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;",
    ...overrides,
  };
}

/** A checkout that holds exactly the files it was given, and nothing else. */
function stubSource(texts: Record<string, string>): WorkspaceSource {
  return {
    root: "/workspace",
    readText: (rel) => Promise.resolve(texts[rel] ?? null),
    readDir: () => Promise.resolve([]),
    history: () => Promise.resolve(null),
  };
}

/** A call carrying whatever the model actually wrote, not a serialised object. */
function raw(name: string, args: string): ToolCall {
  return { id: "c1", name, arguments: args };
}

const BUDGET: ToolBudget = { ...DEFAULT_TOOL_BUDGET, maxResultChars: 200, maxFileLines: 5 };

describe("arguments that are not the object the schema demanded", () => {
  it("reads an empty argument string as no arguments rather than failing the call", async () => {
    // Several providers emit `arguments: ""` for a no-parameter tool.
    // `list_changed_files` takes none, so an empty string must serve the list.
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);

    const text = await executor.execute(raw("list_changed_files", "   "));

    expect(text).toContain("src/a.ts");
    expect(executor.trace().at(-1)?.ok).toBe(true);
  });

  it("refuses a JSON array of arguments rather than reading it as an object", async () => {
    // `JSON.parse("[…]")` succeeds, so only the explicit array check stands
    // between a positional-argument model and `args.path` reading undefined.
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);

    const text = await executor.execute(raw("read_diff", '["src/a.ts"]'));

    expect(text).toBe("Error: arguments must be a JSON object.");
    expect(executor.trace().at(-1)).toMatchObject({ ok: false, note: "arguments not an object" });
  });

  it("refuses a JSON null and a bare scalar the same way", async () => {
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);

    expect(await executor.execute(raw("read_diff", "null"))).toContain("must be a JSON object");
    expect(await executor.execute(raw("read_diff", "42"))).toContain("must be a JSON object");
    expect(executor.trace().every((entry) => !entry.ok)).toBe(true);
  });

  it("refuses a path that is not a string instead of coercing it into one", async () => {
    // The argument is a one-element array, which is what a model that got the
    // shape half-right sends. Stringifying it would name the file exactly —
    // so a coercing executor would serve the diff here, and the refusal is
    // what tells the model to send the path in the shape it was asked for.
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);

    const text = await executor.execute(raw("read_diff", '{"path": ["src/a.ts"]}'));

    expect(text).toContain("is not a file this pull request changes");
    expect(text).not.toContain("@@");
    expect(executor.trace().at(-1)?.ok).toBe(false);
  });

  it("reads a non-integer page as the first page rather than serving nothing", async () => {
    // The paging argument is a convenience, not a gate: a model that sends
    // `"2"` or `1.5` gets page one, never an error that ends its read.
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);

    const text = await executor.execute(raw("read_diff", '{"path": "src/a.ts", "page": "2"}'));

    expect(text).toContain("(page 1/1)");
    expect(executor.trace().at(-1)?.ok).toBe(true);
  });
});

describe("files the executor cannot serve", () => {
  it("says a binary file has no textual diff instead of serving an empty patch", async () => {
    // `patch: null` is what the pull request files API returns for a binary
    // blob. An empty string answer would read to the model as "nothing
    // changed here", which is a different and false claim.
    const executor = createToolExecutor(
      [file({ path: "logo.png", patch: null })],
      new Map(),
      null,
      BUDGET,
    );

    const text = await executor.execute(raw("read_diff", '{"path": "logo.png"}'));

    expect(text).toContain("no textual diff (binary or empty)");
    expect(executor.trace().at(-1)).toMatchObject({ ok: false, note: "no text patch" });
  });

  it("says a file the checkout does not hold could not be read", async () => {
    // The base-branch checkout is not the diff: a file added by this pull
    // request is absent from it, and so is a path the model invented.
    const executor = createToolExecutor(
      [file()],
      new Map(),
      stubSource({ "src/a.ts": "l1" }),
      BUDGET,
    );

    const text = await executor.execute(raw("read_file", '{"path": "src/invented.ts"}'));

    expect(text).toContain("could not be read (missing, denied, or too large)");
    expect(executor.trace().at(-1)).toMatchObject({ ok: false, note: "unreadable" });
  });

  it("refuses a read_file call with no usable path before touching the checkout", async () => {
    // The refusal has to happen before `readText`, because the denylist is
    // what stands between a steered read and a secret; an empty path that
    // reached the source would be asking the checkout to interpret it.
    const asked: string[] = [];
    const source: WorkspaceSource = {
      root: "/workspace",
      readText: (rel) => {
        asked.push(rel);
        return Promise.resolve(null);
      },
      readDir: () => Promise.resolve([]),
      history: () => Promise.resolve(null),
    };
    const executor = createToolExecutor([file()], new Map(), source, BUDGET);

    const text = await executor.execute(raw("read_file", '{"path": 7}'));

    expect(text).toContain("is not readable");
    expect(asked).toEqual([]);
  });

  it("names the file's real length when the model starts its read past the end", async () => {
    const executor = createToolExecutor(
      [file()],
      new Map(),
      stubSource({ "src/a.ts": ["l1", "l2", "l3"].join("\n") }),
      BUDGET,
    );

    const text = await executor.execute(raw("read_file", '{"path": "src/a.ts", "start": 900}'));

    expect(text).toBe("Error: src/a.ts has 3 line(s).");
    expect(executor.trace().at(-1)).toMatchObject({ ok: false, note: "start past EOF" });
  });

  it("reads a zero or negative start as the first line rather than an empty excerpt", async () => {
    const executor = createToolExecutor(
      [file()],
      new Map(),
      stubSource({ "src/a.ts": ["l1", "l2"].join("\n") }),
      BUDGET,
    );

    const text = await executor.execute(raw("read_file", '{"path": "src/a.ts", "start": 0}'));

    expect(text).toContain("    1 | l1");
    expect(text).toContain("lines 1-2 of 2");
  });
});

describe("a result never grows past the cap it was given", () => {
  it("truncates an oversized listing and says where it was cut", async () => {
    // The file list is the one answer whose size the pull request chooses
    // rather than the budget: a 400-file change must not put 400 lines into
    // the conversation just because nobody asked for a page.
    const many = Array.from({ length: 400 }, (_, index) =>
      file({ path: `src/module-${String(index)}.ts` }),
    );
    const executor = createToolExecutor(many, new Map(), null, BUDGET);

    const text = await executor.execute(raw("list_changed_files", "{}"));

    expect(text).toContain("… (truncated at 200 characters)");
    expect(text.length).toBeLessThan(400);
  });
});

describe("the checkout the model may read, against the real filesystem source", () => {
  // The executor's own guard is the secret denylist; containment against
  // traversal lives in the `WorkspaceSource` it is handed, which in a real run
  // is always `fsSource(workspaceRoot)` (`main.ts:587`). These cases therefore
  // run the pair the way production wires it — a fake source here would prove
  // only what the fake decided to allow.
  let root: string;
  let outsideName: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "reeve-tools-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "const inside = 1;\n", "utf8");
    // A file the workspace does not contain, holding a string no answer may
    // ever carry — the leak this whole describe exists to refuse.
    outsideName = `outside-${basename(root)}.txt`;
    await writeFile(join(root, "..", outsideName), "OUTSIDE-SECRET-VALUE", "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(join(root, "..", outsideName), { force: true });
  });

  function executor(): ReturnType<typeof createToolExecutor> {
    return createToolExecutor([file()], new Map(), fsSource(root), BUDGET);
  }

  it("serves a file inside the checkout — the control the refusals are read against", async () => {
    const text = await executor().execute(raw("read_file", '{"path": "src/a.ts"}'));

    expect(text).toContain("const inside = 1;");
  });

  it.each([
    ["a parent-directory escape", (name: string) => `../${name}`],
    ["an escape that starts inside the workspace", (name: string) => `src/../../${name}`],
    ["a doubled escape", (name: string) => `../../${name}`],
  ])("refuses %s and leaks nothing from outside the checkout", async (_case, build) => {
    const text = await executor().execute(
      raw("read_file", JSON.stringify({ path: build(outsideName) })),
    );

    expect(text).not.toContain("OUTSIDE-SECRET-VALUE");
    expect(text).toContain("Error:");
  });

  it("refuses an absolute path, which is not workspace-relative at all", async () => {
    const text = await executor().execute(
      raw("read_file", JSON.stringify({ path: join(root, "src", "a.ts") })),
    );

    expect(text).not.toContain("const inside = 1;");
    expect(text).toContain("Error:");
  });

  it("refuses a path carrying a NUL byte rather than letting the runtime truncate it", async () => {
    // `"src/a.ts\0.png"` is `src/a.ts` to a C string and something else to
    // every check that ran before it.
    const text = await executor().execute(
      raw("read_file", JSON.stringify({ path: "src/a.ts\u0000.png" })),
    );

    expect(text).not.toContain("const inside = 1;");
    expect(text).toContain("Error:");
  });
});

describe("a refusal costs the model its budget", () => {
  it("exhausts the pull budget on malformed calls alone, rather than answering them forever", async () => {
    // Without this, a model stuck in a malformed-arguments loop would be
    // refused cheaply every round and only ever stopped by the round cap —
    // and every refusal still lands in the conversation, so it is context
    // spent either way.
    const tiny: ToolBudget = { ...BUDGET, maxTotalPullChars: 60 };
    const executor = createToolExecutor([file()], new Map(), null, tiny);

    await executor.execute(raw("read_diff", "{nope"));
    await executor.execute(raw("read_diff", "{nope"));
    const third = await executor.execute(raw("read_diff", '{"path": "src/a.ts"}'));

    expect(third).toContain("pull budget for this review is exhausted");
    expect(executor.trace().at(-1)?.note).toBe("pull budget exhausted");
    expect(executor.pulled()).toBeGreaterThan(60);
  });

  it("keeps every refusal in the trace, so a run can be read back call by call", async () => {
    const executor = createToolExecutor([file()], new Map(), null, BUDGET);

    await executor.execute(raw("read_diff", "{nope"));
    await executor.execute(raw("delete_repo", "{}"));

    expect(executor.trace().map((entry) => entry.note)).toEqual([
      "arguments not JSON",
      "unknown tool",
    ]);
    expect(executor.trace().every((entry) => entry.chars > 0)).toBe(true);
  });
});
