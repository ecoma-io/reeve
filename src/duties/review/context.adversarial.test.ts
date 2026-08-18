/**
 * The repository-context engine, attacked.
 *
 * Context reads a maintainer's checkout to inform a review, which makes it the
 * one place this duty touches files nobody put in the diff. The questions here
 * are the ones a hostile pull request would ask: can I make it read outside
 * the workspace, read a secret, spend an unbounded number of reads, or grow
 * the prompt past the budget the run set?
 *
 * Every case drives the real assembly through the same structural
 * `WorkspaceSource` port production uses — `fsSource` in a run, an in-memory
 * stub here — so the gates under test are the production gates.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
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

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    total: 4000,
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
    lines: new Map([[1, "+export function keeper(): void {}"]]),
    patch: "@@ -1,2 +1,2 @@\n+export function keeper(): void {}",
    ...overrides,
  };
}

/** An in-memory workspace, recording every path the engine actually asked for. */
function sourceOf(
  files: Record<string, string>,
  options: { dirs?: Record<string, readonly string[]>; history?: Record<string, string> } = {},
): WorkspaceSource & { readonly asked: readonly string[] } {
  const asked: string[] = [];
  return {
    root: "/workspace",
    asked,
    // eslint-disable-next-line @typescript-eslint/require-await
    async readText(rel) {
      asked.push(`text:${rel}`);
      return files[rel] ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readDir(rel) {
      asked.push(`dir:${rel}`);
      return options.dirs?.[rel] ?? [];
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async history(rel) {
      asked.push(`history:${rel}`);
      return options.history?.[rel] ?? null;
    },
  };
}

const RULES = ".github/reeve-review.yml";

describe("withinWorkspace refuses every spelling of an escape", () => {
  it("refuses_traversal_absolutes_nul_and_the_empty_path", () => {
    const root = "/workspace";
    for (const rel of [
      "",
      "\0",
      "src/\0.ts",
      "/etc/passwd",
      "..",
      "../outside.ts",
      "src/../../outside.ts",
      "src/../..",
      "a/../../b",
    ]) {
      expect(withinWorkspace(root, rel)).toBeNull();
    }
  });

  it("refuses_a_sibling_directory_that_merely_shares_the_roots_prefix", () => {
    // `/workspace-evil` starts with `/workspace` as a string but is not inside
    // it — the separator in the base is what makes the check honest.
    expect(withinWorkspace("/workspace", "../workspace-evil/x.ts")).toBeNull();
  });

  it("accepts_an_ordinary_relative_path_and_returns_it_resolved", () => {
    expect(withinWorkspace("/workspace", "src/app.ts")).toBe("/workspace/src/app.ts");
    expect(withinWorkspace("/workspace", "./src/app.ts")).toBe("/workspace/src/app.ts");
  });

  it("a_dot_segment_alone_resolves_to_the_root_itself_which_is_allowed", () => {
    expect(withinWorkspace("/workspace", ".")).toBe("/workspace");
  });
});

describe("the secret denylist", () => {
  it("catches_env_files_keys_and_word_bearing_config_segments", () => {
    for (const path of [
      ".env",
      ".env.production",
      "config/.env.local",
      ".ssh/config",
      ".npmrc",
      ".netrc",
      "deploy/id_rsa",
      "certs/server.pem",
      "certs/server.key",
      "tokens/github.json",
      "secrets/values.yaml",
      "credentials.yaml",
      "config/password.txt",
    ]) {
      expect(isSecretPath(path)).toBe(true);
    }
  });

  it("does_not_catch_source_files_whose_names_merely_contain_the_words", () => {
    for (const path of [
      "src/tokens.ts",
      "src/tokenizer.ts",
      "src/secrets.ts",
      "src/password.tsx",
      "src/credential.go",
      "src/environment.ts",
      "lib/auth/token.rs",
    ]) {
      expect(isSecretPath(path)).toBe(false);
    }
  });

  it("a_secret_file_named_in_the_diff_is_never_read_into_the_config_section", async () => {
    const source = sourceOf(
      { "config/.env": "TOKEN=hunter2", "config/package.json": "{}" },
      { dirs: { config: [".env", "package.json"], ".": [] } },
    );
    const out = await collectContext([target({ path: "config/app.ts" })], source, budget(), RULES);
    expect(source.asked).not.toContain("text:config/.env");
    expect(out.text ?? "").not.toContain("hunter2");
  });
});

describe("the read budget cannot be blown from inside the workspace", () => {
  it("a_file_past_maxFileChars_reads_as_absent_rather_than_flooding_a_section", async () => {
    const source = sourceOf(
      { "src/app.ts": "x".repeat(200), "src/pkg/package.json": "{}" },
      { dirs: { "src/pkg": ["package.json"] } },
    );
    const out = await collectContext(
      [target({ path: "src/app.ts" })],
      source,
      budget({ maxFileChars: 10 }),
      RULES,
    );
    expect(out.text ?? "").not.toContain("xxxxxxxxxxx");
  });

  it("more_changed_files_than_the_cap_are_truncated_and_the_drop_is_reported", async () => {
    const targets = Array.from({ length: 30 }, (_, i) => target({ path: `src/f${String(i)}.ts` }));
    const out = await collectContext(targets, sourceOf({}), budget({ maxChangedFiles: 5 }), RULES);
    const diff = out.sections.find((section) => section.kind === "diff");
    expect(diff?.entries).toHaveLength(5);
    expect(diff?.dropped).toBe(25);
  });

  it("a_total_budget_of_zero_keeps_only_the_diff_and_reports_no_context_text", async () => {
    // ADJUDICATE: `cut` is computed, but the `sections.length === 1` guard
    // short-circuits to `text: null` before it can be rendered, so a run whose
    // whole supplementary context was cut by the budget is indistinguishable
    // — in `text` — from a run that found no context at all. The section list
    // and `readFiles` still tell the truth, which is why this pins current
    // behaviour rather than calling it a defect, but the "… (context
    // truncated)" mark never reaches the prompt on this path.
    const source = sourceOf({}, { history: { "src/app.ts": "abc1234 a commit" } });
    const out = await collectContext([target()], source, budget({ total: 0 }), RULES);
    expect(out.sections.map((s) => s.kind)).toEqual(["diff"]);
    expect(out.totalChars).toBe(0);
    expect(out.text).toBeNull();
    expect(out.readFiles).toBeGreaterThan(0);
  });

  it("a_budget_that_fits_some_sections_marks_the_ones_it_cut", async () => {
    // The same `cut` flag, on the path where it IS rendered: at least one
    // supplementary section fit, so the reader is told the rest did not.
    const source = sourceOf({}, { history: { "src/app.ts": "abc1234 a commit" } });
    // 60 chars fits the symbols section (53) but not the history one (54).
    const out = await collectContext([target()], source, budget({ total: 60 }), RULES);
    expect(out.sections.map((section) => section.kind)).toEqual(["diff", "symbols"]);
    expect(out.text).toContain("context truncated");
  });

  it("a_hostile_history_payload_is_recapped_here_not_trusted_from_the_source", async () => {
    // The source is asked to cap; a source that ignores the cap must not be
    // able to grow the section past what the run decided.
    const source = sourceOf({}, { history: { "src/app.ts": "h".repeat(5000) } });
    const out = await collectContext([target()], source, budget({ maxHistoryChars: 50 }), RULES);
    const history = out.sections.find((section) => section.kind === "history");
    expect(history?.entries[0]?.length).toBeLessThanOrEqual(50 + "### src/app.ts\n".length);
  });

  it("a_history_of_only_whitespace_drops_the_section_rather_than_printing_a_blank_one", async () => {
    const source = sourceOf({}, { history: { "src/app.ts": "   \n  \n" } });
    const out = await collectContext([target()], source, budget(), RULES);
    expect(out.sections.map((s) => s.kind)).not.toContain("history");
  });

  it("the_callers_walk_stops_at_maxFilesScannedPerDirectory", async () => {
    // A repository shaped to make the walk unbounded: every directory holds
    // another directory. The bound is what keeps one review from listing a
    // whole monorepo.
    const dirs: Record<string, readonly string[]> = {};
    for (let i = 0; i < 300; i += 1) dirs[`src${"/deep".repeat(i)}`] = ["deep"];
    const source = sourceOf({}, { dirs });
    await collectContext([target()], source, budget({ maxFilesScannedPerDirectory: 3 }), RULES);
    const listed = source.asked.filter((entry) => entry.startsWith("dir:"));
    expect(listed.length).toBeLessThan(60);
  });

  it("an_empty_workspace_root_reads_nothing_at_all", async () => {
    const source = sourceOf({ "src/app.ts": "x" });
    const rootless: WorkspaceSource = { ...source, root: "" };
    const out = await collectContext([target()], rootless, budget(), RULES);
    expect(out).toEqual({ sections: [], text: null, totalChars: 0, readFiles: 0 });
    expect(source.asked).toEqual([]);
  });

  it("every_attempted_read_is_counted_including_the_ones_that_found_nothing", async () => {
    const out = await collectContext([target()], sourceOf({}), budget(), RULES);
    expect(out.readFiles).toBeGreaterThan(0);
  });
});

describe("what the sections refuse to include", () => {
  it("a_removed_file_contributes_no_symbols_and_no_callers", async () => {
    const source = sourceOf({ "src/app.ts": "keeper();" }, { dirs: { src: ["app.ts"] } });
    const out = await collectContext([target({ status: "removed" })], source, budget(), RULES);
    expect(out.sections.map((s) => s.kind)).not.toContain("symbols");
    expect(out.sections.map((s) => s.kind)).not.toContain("callers");
  });

  it("a_file_with_no_patch_contributes_no_symbols_imports_or_surrounding_source", async () => {
    const source = sourceOf({ "src/app.ts": "import x from 'y';" });
    const out = await collectContext([target({ patch: null })], source, budget(), RULES);
    for (const kind of ["symbols", "imports", "surrounding", "callers"]) {
      expect(out.sections.map((s) => s.kind)).not.toContain(kind);
    }
  });

  it("an_added_file_gets_no_base_branch_excerpt_because_there_is_no_base", async () => {
    const source = sourceOf({ "src/new.ts": "whatever the base had" });
    const out = await collectContext(
      [target({ path: "src/new.ts", status: "added" })],
      source,
      budget(),
      RULES,
    );
    expect(out.sections.map((s) => s.kind)).not.toContain("surrounding");
    expect(out.text ?? "").not.toContain("whatever the base had");
  });

  it("the_rules_file_is_never_quoted_into_the_config_section", async () => {
    // The config section quotes 400 characters of a file verbatim into the
    // prompt. Quoting the rules file there would feed the model its own
    // instructions back a second time, so the rules path is skipped by name.
    // (The callers walk may still READ it — it emits only lines containing a
    // changed symbol, never the file — which is why the assertion is on the
    // section, not on the read.)
    const source = sourceOf(
      { [RULES]: "version: 1\nrules: []\n", ".github/package.json": "{}" },
      { dirs: { ".github": ["reeve-review.yml", "package.json"] } },
    );
    const out = await collectContext([target({ path: ".github/app.ts" })], source, budget(), RULES);
    const config = out.sections.find((section) => section.kind === "config");
    expect(config?.entries.join("\n") ?? "").not.toContain(RULES);
    expect(config?.entries.join("\n") ?? "").toContain(".github/package.json");
  });

  it("a_config_file_that_cannot_be_read_drops_the_section_rather_than_printing_a_header", async () => {
    const source = sourceOf({}, { dirs: { src: ["package.json"] } });
    const out = await collectContext([target()], source, budget(), RULES);
    expect(out.sections.map((s) => s.kind)).not.toContain("config");
  });

  it("a_patch_with_no_hunks_yields_no_old_ranges_and_no_surrounding_section", async () => {
    expect(oldRanges("no hunks here")).toEqual([]);
    const source = sourceOf({ "src/app.ts": "base source" });
    const out = await collectContext([target({ patch: "no hunks here" })], source, budget(), RULES);
    expect(out.sections.map((s) => s.kind)).not.toContain("surrounding");
  });
});

describe("truncate is the one bound every section shares", () => {
  it("keeps_the_earliest_items_and_reports_the_exact_drop", () => {
    expect(truncate([1, 2, 3, 4], 2)).toEqual({ kept: [1, 2], dropped: 2 });
    expect(truncate([1, 2], 5)).toEqual({ kept: [1, 2], dropped: 0 });
    expect(truncate([], 5)).toEqual({ kept: [], dropped: 0 });
    expect(truncate([1, 2], 0)).toEqual({ kept: [], dropped: 2 });
  });
});

describe("fsSource — the production port", () => {
  it("refuses_a_traversal_read_a_listing_and_a_history_without_touching_disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "reeve-review-ctx-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "app.ts"), "const a = 1;\n");
      const source = fsSource(root);

      expect(await source.readText("src/app.ts")).toBe("const a = 1;\n");
      expect(await source.readDir("src")).toEqual(["app.ts"]);

      // Escapes are refused by the same gate, whatever the operation.
      expect(await source.readText("../../etc/passwd")).toBeNull();
      expect(await source.readDir("../..")).toEqual([]);
      expect(await source.history("../../etc", 100)).toBeNull();

      // A missing path fails soft rather than throwing into the run.
      expect(await source.readText("src/nope.ts")).toBeNull();
      expect(await source.readDir("nope")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a_directory_read_as_a_file_fails_soft_rather_than_throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "reeve-review-ctx-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      expect(await fsSource(root).readText("src")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("history_in_a_directory_that_is_not_a_git_repository_fails_soft", async () => {
    const root = await mkdtemp(join(tmpdir(), "reeve-review-ctx-"));
    try {
      await writeFile(join(root, "a.ts"), "x");
      expect(await fsSource(root).history("a.ts", 100)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a_directory_listing_is_sorted_so_two_runs_read_the_same_order", async () => {
    const root = await mkdtemp(join(tmpdir(), "reeve-review-ctx-"));
    try {
      for (const name of ["c.ts", "a.ts", "b.ts"]) await writeFile(join(root, name), "x");
      expect(await fsSource(root).readDir(".")).toEqual(["a.ts", "b.ts", "c.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
