/**
 * The repository context engine: the assembled, bounded, deterministic half of
 * a review that lives beside the diff.
 *
 * A diff is the whole universe the review may speak about — but a diff in a
 * vacuum hides the questions a careful reader asks first. Does the change
 * shadow an existing helper? Which tests cover this file? What does the base
 * branch look like around the change? This module answers those questions by
 * reading the workflow's own base-ref checkout (the same `GITHUB_WORKSPACE`
 * the rules file lives in — the same trust tier, pinned by the workflow's
 * `checkout` step, never the pull request's merge ref) and assembling what it
 * finds into bounded sections behind the same nonce fence the diff uses.
 *
 * Three properties hold by construction:
 *
 * 1. **Assembled, never streaming.** Every file read and directory listing
 *    goes through `withinWorkspace` + `isSecretPath`, is counted in
 *    `readFiles`, and every section has a fixed cap. The engine cannot be
 *    steered by repository contents: the config allowlist is a fixed constant,
 *    the directory walk is breadth-bounded, and the budget drops a whole
 *    section rather than half-showing it.
 * 2. **Deterministic.** Sections assemble in a fixed priority order against
 *    one budget; truncation keeps the earliest entries and says so. Two runs
 *    over the same checkout and diff produce byte-identical text, which is
 *    what keeps the review's marker fingerprint stable across synchronize
 *    events.
 * 3. **Evidence, never instructions.** Every line of `context.text` is read
 *    from the repository — the same category of text as the diff itself — and
 *    enters the prompt behind `enclose`'s nonce fence, framed as evidence
 *    about the repository. A finding still has to name a file the diff showed
 *    and a line the patch proves (see `verdict.ts`'s `parseFinding`); context
 *    may inform a finding, never authorise one.
 *
 * The `max-context-chars` budget governs the supplementary sections below
 * (symbols, imports, tests, config, surrounding, callers, history) and not the
 * diff: the diff is already bounded by `max-diff-chars` and is rendered by
 * `verdict.ts` before the context block appears. `Context.totalChars` counts
 * the supplementary sections only, which is what the job summary's "Context"
 * row reports.
 */
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { PrFile } from "./pr.js";

/** The kind of one context section — drives its title and its place in the order. */
export type ContextKind =
  "diff" | "symbols" | "imports" | "tests" | "config" | "surrounding" | "callers" | "history";

/** One assembled, bounded section of repository context. */
export interface ContextSection {
  readonly kind: ContextKind;
  readonly title: string;
  readonly entries: readonly string[];
  /** True when a cap cut entries — the renderer shows how many. */
  readonly truncated: boolean;
  /** How many entries a cap cut, 0 when nothing was cut. */
  readonly dropped: number;
  /** The rendered character count, counted against the whole-run budget. */
  readonly chars: number;
}

/** The whole-run context: every section, the rendered text, and the read tally. */
export interface Context {
  readonly sections: readonly ContextSection[];
  /**
   * The rendered context block, or null when the run assembled nothing. This
   * is what `verdict.ts` places inside the `untrusted-diff` fence after the
   * diff block.
   */
  readonly text: string | null;
  /** The character count of the supplementary (non-diff) sections. */
  readonly totalChars: number;
  /** Every read attempt — including denied and missing ones. */
  readonly readFiles: number;
}

/** One changed file the engine may draw context from, in diff shape. */
export interface ContextTarget {
  readonly path: string;
  readonly status: PrFile["status"];
  /** The new-file line numbers the patch proves, mapped to the text at them. */
  readonly lines: ReadonlyMap<number, string>;
  /** The unified diff, or null for a binary file. */
  readonly patch: string | null;
}

/** The bounds one context run may spend — fixes and per-run inputs only. */
export interface Budget {
  /** The whole-run cap for the supplementary sections, in characters. */
  readonly total: number;
  readonly perFileSourceExcerpt: number;
  readonly importsWindow: number;
  readonly maxChangedFiles: number;
  readonly maxFilesScannedPerDirectory: number;
  readonly maxCallsitesPerSymbol: number;
  readonly maxMatchesPerSymbol: number;
  readonly maxSymbolsPerFile: number;
  readonly maxRelatedTestsPerChangedFile: number;
  readonly maxConfigFiles: number;
  readonly maxHistoryChars: number;
  /** A per-file read ceiling — a file past it is treated as unreadable. */
  readonly maxFileChars: number;
}

/**
 * The workspace a run may read from: a structural port, satisfied by
 * `fsSource` in production and by a hand-built stub in tests — the same shape
 * every review port takes, so a concrete filesystem dependency never reaches
 * the assembly logic.
 */
export interface WorkspaceSource {
  readonly root: string;
  /** Reads a workspace-relative path to text, or null when missing/denied/unreadable. */
  readText(rel: string): Promise<string | null>;
  /** Lists one workspace-relative directory to its entry names, or [] when missing/denied. */
  readDir(rel: string): Promise<readonly string[]>;
  /** The file's recent commit history, truncated, or null on any failure. */
  history(rel: string, budgetChars: number): Promise<string | null>;
}

/**
 * Resolves a workspace-relative path and proves the result still sits inside
 * the workspace. Every read the engine makes goes through this first: a hostile
 * repository path — or a hostile history argument — must not read outside
 * `GITHUB_WORKSPACE` or reach a path a maintainer never checked in.
 */
export function withinWorkspace(root: string, rel: string): string | null {
  if (rel.length === 0) return null;
  if (rel.includes("\0")) return null;
  if (rel.startsWith("/")) return null;
  // A `..` segment walks up before `resolve` ever sees it; resolve would
  // happily land inside the workspace from `src/../outside.ts`, so the
  // traversal is refused by segment before any path arithmetic.
  if (rel.split("/").some((segment) => segment === "..")) return null;
  const resolved = resolve(root, rel);
  const base = `${resolve(root)}${sep}`;
  if (resolved !== resolve(root) && !resolved.startsWith(base)) return null;
  return resolved;
}

/**
 * Whether a path is on the secret denylist: exact names, whole segments —
 * split on `/` first, then `.` on the basename so `.env` and `.env.prod` are
 * caught while `environment.ts` is not. A segment match, not a substring: the
 * case-insensitive `secret`/`credential`/`token`/`password` words hit a bare
 * `tokens/` directory, never `tokens.ts` or `tokenizer.ts`.
 */
/** Source-code extensions exempt from the word-contains check: `tokens.ts` and `tokenizer.ts` are code, not a secrets file. */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".rb",
  ".php",
  ".cs",
  ".mjs",
  ".cjs",
  ".tsx",
  ".jsx",
]);

export function isSecretPath(path: string): boolean {
  const segments = path.split("/");
  const base = segments.at(-1) ?? "";
  for (const segment of [...segments, base]) {
    if (segment === ".env" || segment.startsWith(".env.")) return true;
    if (segment === ".ssh" || segment === ".npmrc" || segment === ".netrc") return true;
    if (segment === "id_rsa" || segment.endsWith(".pem") || segment.endsWith(".key")) return true;
    const lowered = segment.toLowerCase();
    // The words hit a bare `tokens/` directory or a config/data file, never a
    // source file whose name merely contains the word.
    if (SOURCE_EXTENSIONS.has(segment.slice(segment.lastIndexOf(".")).toLowerCase())) {
      continue;
    }
    if (["secret", "credential", "token", "password"].some((word) => lowered.includes(word))) {
      return true;
    }
  }
  return false;
}

/**
 * The symbol forms this review recognises in ADDED diff lines, across the
 * languages the ladder ships: TS/JS declarations, Go's `func`/`type`, and
 * Rust's `fn`/`struct`/`impl`.
 */
const SYMBOL =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)|^\s*(?:func|type|fn|struct|impl)\s+([A-Za-z_$][\w$]*)/;

/**
 * The symbols a diff's ADDED lines define or change, deduped, sorted, and
 * capped. A symbol only seeds the callers walk when the diff itself carries
 * it — a symbol that never appears in the diff has no changed code this
 * review can prove around.
 */
export function changedSymbols(added: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const line of added) {
    const match = SYMBOL.exec(line);
    if (match === null) continue;
    const name = match[1] ?? match[2] ?? "";
    if (name.length > 0) out.add(name);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * The files worth walking for callsites of one symbol: every candidate path
 * except the changed file itself and anything on the secret denylist, sorted
 * for determinism.
 */
export function callerCandidates(paths: readonly string[], target: string): readonly string[] {
  return paths
    .filter((path) => path !== target && !isSecretPath(path))
    .sort((a, b) => a.localeCompare(b));
}

/** Keeps the earliest `cap` items, and reports how many were dropped. */
export function truncate<T>(
  items: readonly T[],
  cap: number,
): { kept: readonly T[]; dropped: number } {
  if (items.length <= cap) return { kept: items, dropped: 0 };
  return { kept: items.slice(0, cap), dropped: items.length - cap };
}

/**
 * The OLD-file ranges of a unified diff's hunks — `@@ -o1,o2 +n1,n2 @@`.
 * These are what the surrounding section reads by: for a modified file, the
 * base branch's own line numbers, not the new file's.
 */
export function oldRanges(patch: string): readonly { start: number; count: number }[] {
  const ranges: { start: number; count: number }[] = [];
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk === null) continue;
    ranges.push({ start: Number(hunk[1]), count: Number(hunk[2] ?? 1) });
  }
  return ranges;
}

const SECTION_TITLES: Readonly<Record<ContextKind, string>> = {
  diff: "--- DIFF ---",
  symbols: "--- SYMBOLS DEFINED OR CHANGED ---",
  imports: "--- IMPORTS ---",
  tests: "--- RELATED TESTS ---",
  config: "--- CONFIGURATION ---",
  surrounding: "--- SURROUNDING SOURCE (BASE BRANCH) ---",
  callers: "--- CALLERS ---",
  history: "--- CHANGE HISTORY ---",
};

/**
 * The one header each section renders. A fixed constant rather than anything
 * read from the repository, so a workspace file can never manufacture a
 * second fence or another heading style of its own.
 */
export function sectionTitle(kind: ContextKind): string {
  return SECTION_TITLES[kind];
}

/** A rendered section: header, entries, and the visible mark when anything was cut. */
function renderSection(
  kind: ContextKind,
  entries: readonly string[],
  dropped: number,
): ContextSection {
  const lines = [SECTION_TITLES[kind], ...entries];
  if (dropped > 0) lines.push(`… (${String(dropped)} entries cut)`);
  const chars = lines.join("\n").length;
  return { kind, title: SECTION_TITLES[kind], entries, truncated: dropped > 0, dropped, chars };
}

/**
 * The context block `verdict.ts` places inside the `untrusted-diff` fence:
 * every supplementary section's full body. The diff section is deliberately
 * absent — the diff block is rendered first by `verdict.ts`, and showing a
 * second copy here would double the model's view of the patch.
 */
function renderContextText(sections: readonly ContextSection[]): string {
  return sections
    .filter((section) => section.kind !== "diff")
    .map((section) => {
      const lines = [section.title, ...section.entries];
      if (section.dropped > 0) lines.push(`… (${String(section.dropped)} entries cut)`);
      return lines.join("\n");
    })
    .join("\n");
}

/** The ADDED lines of a file — the `+` half of its patch, excluding the `+++` header. */
function addedLines(target: ContextTarget): readonly string[] {
  const out: string[] = [];
  for (const text of target.lines.values()) {
    if (text.startsWith("+") && !text.startsWith("+++")) out.push(text.slice(1));
  }
  return out;
}

/** Whether a diff line looks like an import — the same shapes several languages spell them in. */
function isImportLike(line: string): boolean {
  return (
    /^\s*import\s/.test(line) ||
    /^\s*from\s/.test(line) ||
    /^\s*use\s/.test(line) ||
    /^\s*import\s?"/.test(line)
  );
}

/** The default filesystem source: the workflow's own checkout. */
export function fsSource(root: string): WorkspaceSource {
  return {
    root,
    async readText(rel) {
      const path = withinWorkspace(root, rel);
      if (path === null) return null;
      try {
        const text = await readFile(path, "utf8");
        return text.length <= 64 * 1024 ? text : null;
      } catch {
        return null;
      }
    },
    async readDir(rel) {
      const path = withinWorkspace(root, rel);
      if (path === null) return [];
      try {
        const names = await readdir(path);
        return [...names].sort((a, b) => a.localeCompare(b));
      } catch {
        return [];
      }
    },
    async history(rel, budgetChars) {
      // Containment before anything runs: the argument to `git` is
      // workspace-relative exactly as the caller read it, and a hostile path
      // is refused without ever reaching a process.
      if (withinWorkspace(root, rel) === null) return null;
      try {
        const { stdout } = await promisify(execFile)(
          "git",
          ["-C", root, "log", "--oneline", "-n", "5", "--", rel],
          { maxBuffer: 65_536 },
        );
        return stdout.length <= budgetChars ? stdout : stdout.slice(0, budgetChars);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Assembles the context sections, in the fixed priority order, against one
 * budget. The diff section is always first and always present; the budget
 * governs the supplementary sections after it — a section that does not fit
 * is dropped whole and the run says so.
 */
export async function collectContext(
  targets: readonly ContextTarget[],
  source: WorkspaceSource,
  budget: Budget,
  rulesPath: string,
): Promise<Context> {
  if (source.root.length === 0) {
    return { sections: [], text: null, totalChars: 0, readFiles: 0 };
  }

  const tally = { reads: 0 };
  const collect = new Collector(source, budget, tally);
  const capped = truncate(targets, budget.maxChangedFiles);
  const changed = capped.kept;
  const sections: ContextSection[] = [
    renderSection(
      "diff",
      changed.map((t) => t.path),
      capped.dropped,
    ),
  ];

  // The supplementary sections assemble in the fixed priority order. The diff
  // is not part of this list: it is already bounded by `max-diff-chars`, and
  // `verdict.ts` renders it before the context block appears.
  const assembled = await Promise.all([
    collect.symbols(changed),
    collect.imports(changed),
    collect.tests(changed),
    collect.config(changed, rulesPath),
    collect.surrounding(changed),
    collect.callers(changed),
    collect.history(changed),
  ]);

  let total = 0;
  let cut = false;
  for (const section of assembled) {
    if (section === null) continue;
    if (total + section.chars <= budget.total) {
      total += section.chars;
      sections.push(section);
    } else {
      cut = true;
    }
  }

  const text =
    sections.length === 1
      ? null
      : `${renderContextText(sections)}${cut ? "\n… (context truncated: context sections cut)" : ""}`;

  return { sections, text, totalChars: total, readFiles: tally.reads };
}

/**
 * The assembly worker: every read goes through the workspace/secret gates,
 * every attempt is counted, and anything unreadable fails soft.
 */
class Collector {
  readonly source: WorkspaceSource;
  readonly budget: Budget;
  readonly tally: { reads: number };

  constructor(source: WorkspaceSource, budget: Budget, tally: { reads: number }) {
    this.source = source;
    this.budget = budget;
    this.tally = tally;
  }

  private async readText(rel: string): Promise<string | null> {
    this.tally.reads += 1;
    const text = await this.source.readText(rel);
    return text === null || text.length > this.budget.maxFileChars ? null : text;
  }

  private async readDir(rel: string): Promise<readonly string[]> {
    this.tally.reads += 1;
    return this.source.readDir(rel);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async symbols(targets: readonly ContextTarget[]): Promise<ContextSection | null> {
    const entries: string[] = [];
    for (const target of targets) {
      if (target.status === "removed" || target.patch === null) continue;
      const symbols = changedSymbols(addedLines(target));
      const capped = truncate(symbols, this.budget.maxSymbolsPerFile);
      for (const symbol of capped.kept) entries.push(`${target.path}: ${symbol}`);
    }
    if (entries.length === 0) return null;
    return renderSection("symbols", entries, 0);
  }

  async imports(targets: readonly ContextTarget[]): Promise<ContextSection | null> {
    const found = new Set<string>();
    for (const target of targets) {
      if (target.status === "added") continue;
      if (target.patch === null) continue;
      const added = addedLines(target);
      if (!added.some((line) => isImportLike(line))) continue;
      // The base checkout of the file is where its existing imports live; the
      // diff's own added import lines are the other half of the union.
      const base = await this.readText(target.path);
      const lines = base === null ? [] : base.split("\n").slice(0, this.budget.importsWindow);
      for (const line of [...lines, ...added]) {
        const trimmed = line.trim();
        if (isImportLike(trimmed)) found.add(trimmed);
      }
    }
    if (found.size === 0) return null;
    const capped = truncate(
      [...found].sort((a, b) => a.localeCompare(b)),
      25,
    );
    return renderSection("imports", capped.kept, capped.dropped);
  }

  async tests(targets: readonly ContextTarget[]): Promise<ContextSection | null> {
    const names: string[] = [];
    for (const target of targets) {
      const dir = dirname(target.path);
      const entry = await this.readDir(dir);
      const related = entry.filter(
        (name) =>
          name.endsWith(".test.ts") || name.endsWith(".spec.ts") || name.startsWith("__tests__"),
      );
      const capped = truncate(related, this.budget.maxRelatedTestsPerChangedFile);
      for (const name of capped.kept) names.push(`${dir}/${name}`);
    }
    if (names.length === 0) return null;
    return renderSection("tests", names, 0);
  }

  async config(
    targets: readonly ContextTarget[],
    rulesPath: string,
  ): Promise<ContextSection | null> {
    const found = new Set<string>();
    for (const target of targets) {
      for (const path of await this.findConfigFrom(dirname(target.path), rulesPath))
        found.add(path);
    }
    if (found.size === 0) return null;
    const capped = truncate(
      [...found].sort((a, b) => a.localeCompare(b)),
      this.budget.maxConfigFiles,
    );
    const reads: string[] = [];
    for (const path of capped.kept) {
      const text = await this.readText(path);
      if (text !== null) reads.push(`### ${path}\n${text.slice(0, 400)}`);
    }
    if (reads.length === 0) return null;
    return renderSection("config", reads, capped.dropped);
  }

  /**
   * The nearest ancestor holding a config file, per changed file's directory.
   * The allowlist is fixed; only a directory listing narrows which candidate
   * names exist there — the engine can never be told to read a broader set.
   */
  private async findConfigFrom(dir: string, rulesPath: string): Promise<string[]> {
    const names = [
      "package.json",
      "tsconfig.json",
      "pyproject.toml",
      "go.mod",
      "Cargo.toml",
      "requirements.txt",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc.yml",
    ];
    const found: string[] = [];
    let cursor = dir;
    for (;;) {
      const entries = await this.readDir(cursor);
      for (const name of names) {
        // The workspace root is spelled `.` here, and its config files keep
        // their bare name rather than a `./` prefix.
        const path = cursor === "." ? name : `${cursor}/${name}`;
        if (path === rulesPath) continue;
        if (entries.includes(name) && !isSecretPath(path)) found.push(path);
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return [...new Set(found)];
  }

  async surrounding(targets: readonly ContextTarget[]): Promise<ContextSection | null> {
    const entries: string[] = [];
    for (const target of targets) {
      if (target.status !== "modified" || target.patch === null) continue;
      // Added files are skipped: the diff already carries the whole file, so
      // a base-branch excerpt of a file that never existed would be noise.
      const base = await this.readText(target.path);
      if (base === null) continue;
      const ranges = oldRanges(target.patch);
      if (ranges.length === 0) continue;
      const lines = base.split("\n");
      for (const range of ranges) {
        const start = Math.max(0, range.start - 1 - this.budget.perFileSourceExcerpt);
        const end = range.start - 1 + range.count + this.budget.perFileSourceExcerpt;
        const excerpt = lines.slice(start, end).join("\n");
        entries.push(`### ${target.path} (base-branch source)\n${excerpt}`);
      }
    }
    if (entries.length === 0) return null;
    return renderSection("surrounding", entries, 0);
  }

  async callers(targets: readonly ContextTarget[]): Promise<ContextSection | null> {
    const entries: string[] = [];
    let scanned = 0;
    for (const target of targets) {
      if (target.status === "removed" || target.patch === null) continue;
      const symbols = changedSymbols(addedLines(target));
      if (symbols.length === 0) continue;
      const candidates = await this.walkFrom(dirname(target.path), (next) => {
        if (scanned >= this.budget.maxFilesScannedPerDirectory) return Promise.resolve([]);
        scanned += 1;
        return this.readDir(next);
      });
      const pruned = callerCandidates(candidates, target.path);
      for (const symbol of symbols) {
        let matches = 0;
        for (const candidate of pruned) {
          if (matches >= this.budget.maxMatchesPerSymbol) break;
          const text = await this.readText(candidate);
          if (text === null) continue;
          for (const line of text.split("\n")) {
            if (line.includes(symbol)) {
              entries.push(`${candidate}: ${line.trim()}`);
              matches += 1;
              if (matches >= this.budget.maxCallsitesPerSymbol) break;
            }
          }
        }
      }
    }
    if (entries.length === 0) return null;
    return renderSection("callers", entries, 0);
  }

  /** Walks a directory up to the earliest ancestor whose siblings exist, then into every subdirectory, bounded. */
  private async walkFrom(
    dir: string,
    list: (rel: string) => Promise<readonly string[]>,
  ): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const roots: string[] = [];
    let cursor = dir;
    for (;;) {
      roots.push(cursor);
      const parent = cursor.lastIndexOf("/");
      if (parent <= 0) break;
      cursor = cursor.slice(0, parent);
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const rel = stack.pop();
      if (rel === undefined) break;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const entries = await list(rel);
      for (const entry of entries) {
        const path = `${rel}/${entry}`;
        if (seen.has(path)) continue;
        // A listing entry without its own suffix is treated as a directory to
        // walk into; anything else is a candidate file.
        if (entry.includes(".") && !entry.endsWith("/")) {
          out.push(path);
        } else {
          stack.push(path);
        }
      }
    }
    return [...new Set(out)];
  }

  async history(targets: readonly ContextTarget[]): Promise<ContextSection | null> {
    const entries: string[] = [];
    for (const target of targets) {
      this.tally.reads += 1;
      const text = await this.source.history(target.path, this.budget.maxHistoryChars);
      if (text === null || text.trim().length === 0) continue;
      // Capped again here, not just in the source: a hostile or buggy source
      // must not blow the section's budget past what the run decided.
      const capped =
        text.length <= this.budget.maxHistoryChars
          ? text
          : text.slice(0, this.budget.maxHistoryChars);
      entries.push(`### ${target.path}\n${capped.trimEnd()}`);
    }
    if (entries.length === 0) return null;
    return renderSection("history", entries, 0);
  }
}
