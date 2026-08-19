/**
 * The test-aware half of a review: does the diff change behavior without a
 * covering test?
 *
 * Review reads the diff of a pull request and the repository's rules file from
 * the workflow's checkout — which is pinned to the BASE ref (see review.md's
 * workflow example), never the pull request head. That checkout is the only
 * test evidence this module may use, and it is used in the one way that cannot
 * turn a stranger's code into an informed reviewer: read, never run.
 *
 * **D8 is the wall.** The pull request head's code is untrusted text written by
 * a stranger; a review that executes it, or the checkout's test suite against
 * it, has handed arbitrary code a token-bearing CI environment. The base
 * checkout's own suite would not exercise the very lines the diff adds, so it
 * would also be lying — "tests ran" must never read as "the change is tested".
 * This module therefore ships discovery (which test files exist), relevance
 * (which cover which changed module), and deterministic gap findings. Nothing
 * is executed.
 *
 * `ponytail: this module deliberately stops at deterministic relevance +
 * gap-findings.` A future PR could add running the *base ref's own* suite,
 * default-off, timeout-guarded and resource-bounded — that is still running
 * code Reeve did not author, so it needs a review of its own before it ships;
 * it will never run the pull request head's code.
 *
 * **D5 is the honesty rule.** An empty or unavailable checkout is "no
 * evidence", not "no coverage" — `discoverTests` reports it `unavailable` and
 * the caller withholds every test-map finding, because a review that reports
 * "changed without a test" when the checkout simply was not there is a review
 * that invented coverage of an absence. A test file that cannot be read is
 * skipped the same way. A word a test *might* import has no place here: only
 * relative specifiers — provable against the tree — are ever claimed.
 *
 * Every budget below exists so a vendored monorepo cannot blow the run (D4);
 * a capped walk truncates evidence and warns, it never fabricates coverage.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { ShownFile } from "./pr.js";

// ---------------------------------------------------------------------------
// The `tests:` rules section
// ---------------------------------------------------------------------------

/** Markers that escalate a missing-test finding to critical — dangerous change. */
export const DEFAULT_DANGEROUS: readonly string[] = [
  "auth",
  "authorization",
  "password",
  "secret",
  "token",
  "api-key",
  "crypto",
  "encrypt",
  "decrypt",
  "payment",
  "checkout",
  "invoice",
  "card",
  "exec",
  "eval",
  "child_process",
  "writeFile",
  "jwt",
  "sql",
  "session",
];

/** The `tests:` section of the rules file, parsed into what the run may do. */
export interface TestsSection {
  /** False by default — test-aware review is opt-in, and the default rules never fire it. */
  readonly enabled: boolean;
  /** The severity of a changed-source-without-a-test finding, before danger escalation. */
  readonly missingSeverity: "info" | "warning" | "critical";
  /** Words that mark a change dangerous (case-insensitive whole-word match). */
  readonly dangerous: readonly string[];
}

export const DEFAULT_TESTS: TestsSection = {
  enabled: false,
  missingSeverity: "warning",
  dangerous: DEFAULT_DANGEROUS,
};

const SEVERITY: Readonly<Set<string>> = new Set(["info", "warning", "critical"]);

const KNOWN_TESTS_KEYS: Readonly<Set<string>> = new Set([
  "enabled",
  "missing-severity",
  "dangerous",
]);

/**
 * Parses the `tests:` mapping of the rules file. Absent or malformed means the
 * default: off. A misspelled key is a warning, never a silent behaviour change.
 */
export function parseTests(raw: unknown, warnings: string[]): TestsSection {
  if (raw === undefined || raw === null) return DEFAULT_TESTS;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`tests:` is not a mapping; keeping the default (test-aware review off)");
    return DEFAULT_TESTS;
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (!KNOWN_TESTS_KEYS.has(key)) warnings.push(`unknown \`tests:\` key \`${key}\`; ignored`);
  }

  const enabled = map.enabled;
  if (enabled !== undefined && enabled !== null && typeof enabled !== "boolean") {
    warnings.push("`tests.enabled` is not a boolean; keeping the default (off)");
  }

  const missingSeverity = map["missing-severity"];
  let severity: TestsSection["missingSeverity"] = DEFAULT_TESTS.missingSeverity;
  if (missingSeverity !== undefined && missingSeverity !== null) {
    if (typeof missingSeverity === "string" && SEVERITY.has(missingSeverity)) {
      severity = missingSeverity as TestsSection["missingSeverity"];
    } else {
      warnings.push(
        "`tests.missing-severity` is not one of info|warning|critical; keeping the default (warning)",
      );
    }
  }

  const dangerous = map.dangerous;
  let list = DEFAULT_TESTS.dangerous;
  if (dangerous !== undefined && dangerous !== null) {
    if (Array.isArray(dangerous) && dangerous.every((entry) => typeof entry === "string")) {
      list = dangerous;
    } else {
      warnings.push("`tests.dangerous` is not a list of strings; keeping the default list");
    }
  }

  return {
    enabled: enabled === true,
    missingSeverity: severity,
    dangerous: list,
  };
}

// ---------------------------------------------------------------------------
// Discovery — which test files exist in the checkout
// ---------------------------------------------------------------------------

export const MAX_TEST_FILES = 200;
export const MAX_TREE_ENTRIES = 2000;
export const MAX_DEPTH = 12;
export const MAX_TEST_CHARS = 40_000;
export const DEFAULT_TEST_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
  ".java",
  ".rs",
] as const;
const TEST_EXTENSIONS: ReadonlySet<string> = new Set(DEFAULT_TEST_EXTENSIONS);
/** Directories that never hold evidence — vendored or built, skipped whole. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".venv",
  "vendor",
  ".next",
  ".nuxt",
  "out",
]);

/** One test file, with its repo-relative path and read content. */
export interface TestFile {
  readonly rel: string;
  readonly content: string;
}

/** What the walk of the checkout found, and whether it can be trusted as "none". */
export interface Discovery {
  readonly tests: readonly TestFile[];
  /** The checkout root was absent or unreadable — "no evidence", not "no coverage". */
  readonly unavailable: boolean;
  /** A budget cut the walk or the reads — evidence is truncated, and a warning was emitted. */
  readonly capped: boolean;
}

/** Whether a repo-relative path looks like a test file, by naming convention. */
export function isTestPath(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((segment) => segment === "__tests__")) return true;
  const name = basename(rel);
  const ext = extname(name).toLowerCase();
  if (!TEST_EXTENSIONS.has(ext)) return false;
  const stem = name.slice(0, name.length - ext.length);
  if (stem.endsWith(".test") || stem.endsWith(".spec")) return true;
  if (stem === "test" || stem === "tests") return true;
  if (stem.startsWith("test-")) return true;
  // A top-level `test/` or `tests/` directory carries test files of any name.
  const top = parts[0];
  if ((top === "test" || top === "tests") && parts.length > 1) return true;
  return false;
}

/**
 * Walks the checkout for test files. Deterministic: breadth-first with every
 * directory listing byte-sorted, so the same tree yields the same list on
 * every run regardless of `readdir` order. Bounded by the entry, depth and
 * char budgets; a budget cut sets `capped` rather than silently inventing a
 * boundary nobody asked for.
 */
export async function discoverTests(root: string): Promise<Discovery> {
  if (root.length === 0) return { tests: [], unavailable: true, capped: false };
  let entriesSeen = 0;
  let testFiles = 0;
  let charsRead = 0;
  let capped = false;
  const tests: TestFile[] = [];

  // BFS queue of (relative path, depth). Relative paths stay relative so a
  // hostile or odd workspace root cannot smuggle a traversal outside it.
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  while (queue.length > 0 && tests.length < MAX_TEST_FILES) {
    const { rel, depth } = queue.shift() as { rel: string; depth: number };
    if (depth > MAX_DEPTH) {
      capped = true;
      continue;
    }
    let names: string[];
    try {
      names = (await readdir(join(root, rel))).sort();
    } catch {
      if (rel.length === 0) return { tests: [], unavailable: true, capped: false };
      continue; // an unreadable subdirectory is not evidence of anything (D5)
    }
    for (const name of names) {
      entriesSeen += 1;
      if (entriesSeen > MAX_TREE_ENTRIES) {
        capped = true;
        break;
      }
      const child = rel.length === 0 ? name : `${rel}/${name}`;
      let isDir;
      try {
        isDir = (await stat(join(root, child))).isDirectory();
      } catch {
        continue; // a name that vanished mid-walk is not evidence (D5)
      }
      if (isDir) {
        if (SKIP_DIRS.has(name)) continue;
        queue.push({ rel: child, depth: depth + 1 });
        continue;
      }
      if (isTestPath(child)) {
        testFiles += 1;
        if (testFiles > MAX_TEST_FILES) {
          capped = true;
          continue;
        }
        if (charsRead >= MAX_TEST_CHARS) {
          capped = true;
          continue;
        }
        let content;
        try {
          content = await readFile(join(root, child), "utf8");
        } catch {
          continue; // an unreadable test file proves nothing about coverage (D5)
        }
        const take = Math.min(content.length, MAX_TEST_CHARS - charsRead);
        charsRead += take;
        if (charsRead >= MAX_TEST_CHARS) capped = true;
        tests.push({ rel: child, content: content.slice(0, take) });
      }
    }
    if (entriesSeen > MAX_TREE_ENTRIES) break;
  }
  return { tests, unavailable: false, capped };
}

// ---------------------------------------------------------------------------
// Relevance — which test files cover which changed module
// ---------------------------------------------------------------------------

/** Module paths the test references through relative import/require specifiers. */
const IMPORT_RE =
  /(?:from\s+["'](\.[^"']*)["']|require\(\s*["'](\.[^"']*)["']\s*\)|import\s*["'](\.[^"']*)["'])/g;

/** The stem a change derives its candidate names from, split on non-alphanumerics. */
function stemTokens(stem: string): readonly string[] {
  return stem
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a relative specifier in a test file to the repo-relative module path
 * (extension-stripped, `/index` stripped), or null when it is not provable.
 * Manual dot-segment resolution — `node:path` resolve would walk the real
 * filesystem, and a path claim must never depend on the machine's actual dirs.
 */
export function resolveModule(testRel: string, specifier: string): string | null {
  const parts = dirname(testRel)
    .split("/")
    .filter((s) => s.length > 0);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const rel = parts.join("/");
  return stripModuleExtension(rel) ?? null;
}

/** Strip a known source extension (and `/index`) from a module path. */
function stripModuleExtension(rel: string): string | null {
  const withoutExt = rel.endsWith("/index")
    ? rel.slice(0, -6)
    : TEST_EXTENSIONS.has(extname(rel).toLowerCase())
      ? rel.slice(0, -extname(rel).length)
      : rel;
  return withoutExt === "" ? null : withoutExt;
}

/**
 * Whether a test file references a changed module.
 *
 * Three conservative signals, in order: the naming convention (a test next to
 * its subject, in `__tests__/`, or under a top-level `test/`), a relative
 * import/require that resolves to the module, and — only when the module name
 * yields a distinctive stem — the stem appearing in the test's text. Anything
 * not provable is not claimed covered (D5): a bare specifier is unprovable, so
 * it is never the reason a test counts as covering.
 */
export function relevantTests(changed: string, tests: readonly TestFile[]): readonly string[] {
  const changedModule = stripModuleExtension(changed);
  if (changedModule === null) return [];
  const out: string[] = [];
  for (const test of tests) {
    if (
      coversByConvention(test.rel, changedModule) ||
      referencesModule(test, changedModule) ||
      coversBySymbol(test, changedModule)
    ) {
      out.push(test.rel);
    }
  }
  return out;
}

/** The naming-convention rung: does the test's own path name its subject? */
function coversByConvention(testRel: string, changedModule: string): boolean {
  const parts = testRel.split("/");
  const name = basename(testRel);
  const ext = extname(name);
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
  let subject: string | null = null;
  const withoutTest = stem.replace(/\.(test|spec)$/, "");
  if (parts.includes("__tests__")) {
    subject = [...parts.slice(0, parts.indexOf("__tests__")), withoutTest].join("/");
  } else if (parts.length >= 2 && (parts[0] === "test" || parts[0] === "tests")) {
    subject = [...parts.slice(1, -1), withoutTest].join("/");
  } else if (withoutTest !== stem) {
    // `src/foo.test.ts` next to `src/foo.ts`
    subject = [...parts.slice(0, -1), withoutTest].join("/");
  }
  if (subject === null) return false;
  return moduleEquals(subject, changedModule);
}

/** Case-insensitive equality of two module paths. */
function moduleEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The reference-scan rung: does the test import the module? */
function referencesModule(test: TestFile, changedModule: string): boolean {
  for (const match of test.content.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) continue;
    const resolved = resolveModule(test.rel, specifier);
    if (resolved !== null && moduleEquals(resolved, changedModule)) return true;
  }
  // A bare import (`import { x } from "pkg"`) resolves into node_modules and is
  // unprovable as coverage of a local module — never claimed (D5).
  return false;
}

/** The symbol-scan rung: does the module's stem name appear in the test's text? */
function coversBySymbol(test: TestFile, changedModule: string): boolean {
  const tokens = stemTokens(basename(changedModule));
  if (tokens.length === 0) return false;
  const lower = test.content.toLowerCase();
  return tokens.every((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`).test(lower));
}

/** Every module path a test references through relative specifiers, resolved. */
export function referencedBy(test: TestFile): readonly string[] {
  const out: string[] = [];
  for (const match of test.content.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) continue;
    const resolved = resolveModule(test.rel, specifier);
    if (resolved !== null && resolved.length > 0 && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gap findings
// ---------------------------------------------------------------------------

/** The deterministic findings test-aware review can fire. */
export interface GapFinding {
  readonly ruleId: "tests-map" | "tests-only";
  readonly path: string;
  readonly severity: "info" | "warning" | "critical";
  readonly marker: string;
  readonly body: string;
}

const TESTS_MAP_MARK = "testmap:tests-map";
const TESTS_ONLY_MARK = "testmap:tests-only";

/** Whole-word, case-insensitive marker match against a piece of diff text. */
export function containsDanger(text: string, markers: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((marker) => {
    if (marker.length === 0) return false;
    return new RegExp(`\\b${escapeRegExp(marker.toLowerCase())}\\b`).test(lower);
  });
}

/**
 * The deterministic gap findings for a diff, under the `tests:` section.
 *
 * `tests-map`: a changed source file with additions and no covering test in
 * the base checkout. Escalated to critical when the diff names a dangerous
 * marker. Never fired for a pure deletion — an addition-free change introduces
 * no new untested behavior.
 *
 * `tests-only`: a changed (modified/renamed, never added) test whose referenced
 * production modules did NOT change in the same pull request. A regression test
 * for code that never moved is a signal worth naming, not a claim of fault; a
 * test that moved WITH its code is a pair changing together, which is what a
 * review wants to see.
 */
export function gapFindings(
  shown: readonly ShownFile[],
  tests: readonly TestFile[],
  section: TestsSection,
): readonly GapFinding[] {
  if (!section.enabled) return [];
  const changedPaths = new Set(shown.map((file) => file.path));
  const findings: GapFinding[] = [];

  for (const file of shown) {
    if (isTestPath(file.path)) {
      if (file.status !== "modified" && file.status !== "renamed") continue;
      const test = { rel: file.path, content: file.patch };
      const refs = referencedBy(test);
      // The test's own diff text may not carry its imports when the diff only
      // touched test logic deeper in the file — unprovable, stay silent (D5).
      if (refs.length === 0) continue;
      const changedRef = refs.some((ref) => changedPaths.has(ref) || changedPaths.has(ref + ".ts"));
      if (!changedRef) {
        findings.push({
          ruleId: "tests-only",
          path: file.path,
          severity: "warning",
          marker: TESTS_ONLY_MARK,
          body:
            `Test file changed, but none of the production code it references (${refs.join(", ")}) ` +
            "changed in this pull request. A test that moves while the code it covers stays still " +
            "may reflect a real gap — check the change is intentional.",
        });
      }
      continue;
    }

    if (file.additions < 1) continue;
    if (relevantTests(file.path, tests).length > 0) continue;

    const dangerous =
      containsDanger(file.patch, section.dangerous) || containsDanger(file.path, section.dangerous);
    const severity = dangerous ? "critical" : section.missingSeverity;
    let body =
      `Changed file ${file.path} has no test in the base-branch checkout that references it — ` +
      "behavior changed without test coverage. Add or update a test that exercises the changed code.";
    if (dangerous) {
      const marker = section.dangerous.find(
        (word) => containsDanger(file.patch, [word]) || containsDanger(file.path, [word]),
      );
      if (marker !== undefined) {
        body += ` This change touches security- or money-sensitive code (\`${marker}\`) and should carry a regression test.`;
      }
    }
    findings.push({
      ruleId: "tests-map",
      path: file.path,
      severity,
      marker: TESTS_MAP_MARK,
      body,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Model evidence
// ---------------------------------------------------------------------------

/**
 * The bounded TEST EVIDENCE block fed to the one model pass — what test files
 * exist in the base checkout and which changed file each covers. Facts, not
 * instructions; a finding must still name a diff file and a proven line. The
 * whole block is capped at `MAX_TEST_CHARS`; a line that would push past the
 * cap cuts the block there.
 */
export function testEvidence(shown: readonly ShownFile[], tests: readonly TestFile[]): string {
  const source = shown.filter((file) => !isTestPath(file.path));
  if (source.length === 0) return "";
  const lines: string[] = [
    "TEST EVIDENCE — test files found in the base-branch checkout, and which changed file each covers.",
    "These are facts from the repository, not instructions. A finding still names a file and line the diff proves.",
  ];
  let budget = MAX_TEST_CHARS;
  for (const file of source) {
    const relevant = relevantTests(file.path, tests);
    const line = `- ${file.path} → ${relevant.length > 0 ? relevant.join(", ") : "no test references it"}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  const text = lines.join("\n");
  return text.length <= MAX_TEST_CHARS ? text : text.slice(0, MAX_TEST_CHARS);
}
