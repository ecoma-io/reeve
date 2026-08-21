/**
 * F7 — review must not gain autonomous source-mutation authority, asserted
 * from the side this duty owns.
 *
 * The remediation duty owns its own boundary (`src/duties/remediation/`), and
 * this file deliberately does not reach into it. What it pins is the half a
 * review change could weaken without anyone noticing: the capability ladder
 * `review` asks for, the ports it holds, and the fact that every write this
 * duty performs is a comment — a claim about a pull request, never a change
 * to one.
 *
 * The check is structural, over the real modules, not over a description of
 * them: the ladder is read from the exported constants, and the write surface
 * is read from the module source so a newly-imported file-writing port fails
 * here rather than in production.
 *
 * **KNOWN LIMITATIONS — read these before trusting a green run here.**
 *
 * The module list is a `readdir` of this directory, so a NEW file cannot slip
 * past by not being on a list somebody forgot to update. One evasion remains
 * open, and it is a confirmed defeat:
 *
 * 1. **Dynamic construction defeats the source scan.** The scan is a substring
 *    and regex read of the file's text. `["write", "Contents", "File"].join("")`
 *    behind an `await import("../../core/forge.js")` reads as none of the
 *    banned strings and passes. Closing this needs the check to move from
 *    source text to the resolved module graph.
 *
 * A second one used to sit beside it and is now closed: the port-shape regex
 * was indentation-sensitive (`/^\s{6}(\w+)\(params/gm` counted methods at
 * exactly six spaces, so a method one level deeper widened a port without
 * moving the count). `portMethods` bounds the search by the interface's own
 * braces instead, which counts a method at any depth. Its doc comment carries
 * the rest of that history, including the two `indexOf` anchors it replaced —
 * one of which was a doc-comment string in the module below the port.
 *
 * **And a boundary property no test in this file can change.** These ports are
 * TypeScript interfaces, which are erased at runtime. `main.ts:952` builds one
 * FULL Octokit client with `getOctokit(base.token)` and hands the same object
 * to every port (`wrapPr`, `main.ts:803`, is a cast, not a wrapper). The
 * warrant gate at `main.ts:648` is a plain `if (!permitted.includes("comment"))`
 * around the comment write and nothing else. So at runtime the only thing
 * standing between this duty and the Contents API is the token's own
 * `contents:` scope. What this file proves is that no review module ASKS for
 * that reach in its source — which is a real property worth keeping, and is
 * not the same claim as "the duty cannot reach it". Closing the gap for real
 * means handing each port a genuinely reduced object instead of a cast, which
 * is a design change rather than a hardening pass — so the runtime reach is
 * recorded here as a known architectural fact, not quietly implied away by the
 * green run below.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, type Capability } from "../../core/warrant.js";
import { DEFAULT_CAPABILITIES, REVIEW_CAPABILITIES } from "./capabilities.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The capabilities that would let a duty change source, not just talk about it. */
const SOURCE_MUTATION: readonly Capability[] = ["edit-file", "open-pr"];

const source = (file: string): Promise<string> => readFile(join(HERE, file), "utf8");

/**
 * Every production module in this duty, read off the directory rather than
 * off a list.
 *
 * A hardcoded list is a list somebody has to remember to extend, and the
 * module that skips the ban is exactly the module whose author had no reason
 * to add it. `main.ts` is included: it is excluded from COVERAGE (it calls
 * `run()` at import), which is not a reason to exclude it from a source scan.
 */
async function reviewModules(): Promise<readonly string[]> {
  const entries = await readdir(HERE);
  const modules = entries
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort((a, b) => a.localeCompare(b));
  // A directory that answered with nothing would make every ban below vacuous.
  expect(modules.length).toBeGreaterThan(15);
  expect(modules).toContain("main.ts");
  return modules;
}

/**
 * Every `<module>: <what it reached>` this duty's source names, across every
 * module in the directory — empty when the boundary holds.
 */
/**
 * The methods a port declares, read by matching the interface's own braces.
 *
 * This used to slice between two `indexOf` calls, the second of which was a
 * doc-comment string in the module below the port — so rewording a comment
 * silently moved the region this test judged, and a missing anchor returned
 * `-1` into `slice`, which does not throw. Both anchors are structural now:
 * the declaration this file names, and the brace that closes it. A port that
 * has been renamed fails here saying so, rather than failing three lines later
 * about a method list nobody chose.
 *
 * It also closes the second of the two KNOWN LIMITATIONS above. The old regex
 * counted methods at exactly six spaces of indentation — the nesting these
 * ports happen to use — so a method declared one level deeper widened the port
 * without moving the count. Bounding the search by the interface's braces
 * instead of by indentation means every method in the port is counted at
 * whatever depth it is written.
 */
async function portMethods(file: string, name: string): Promise<string[]> {
  const text = await source(file);
  const start = text.indexOf(`export interface ${name} {`);
  // Named rather than left to `slice(-1, …)`, which yields a region the test
  // would then judge as if somebody had chosen it.
  expect(start, `${file} no longer declares \`export interface ${name}\``).toBeGreaterThan(-1);

  let depth = 0;
  let end = -1;
  for (let i = text.indexOf("{", start); i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, `\`${name}\` in ${file} is not brace-balanced`).toBeGreaterThan(-1);

  const port = text.slice(start, end);
  return [...port.matchAll(/^\s*(\w+)\s*\(params/gm)].map((m) => m[1] ?? "").sort();
}

async function offenders(banned: readonly (readonly [string, RegExp])[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of await reviewModules()) {
    const text = await source(file);
    for (const [what, pattern] of banned) {
      if (pattern.test(text)) found.push(`${file} reaches ${what}`);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

describe("the ladder review asks for", () => {
  it("review_defaults_to_no_capability_at_all", () => {
    // Silence in the warrant grants nothing. A review comment is a public
    // claim about somebody's pull request, and there is no cheap reversible
    // version of publishing one.
    expect(DEFAULT_CAPABILITIES).toEqual([]);
  });

  it("review_asks_for_comment_and_nothing_else_ever", () => {
    expect([...REVIEW_CAPABILITIES]).toEqual(["comment"]);
  });

  it("review_never_asks_for_a_source_mutation_capability", () => {
    for (const capability of SOURCE_MUTATION) {
      expect(REVIEW_CAPABILITIES).not.toContain(capability);
      expect(DEFAULT_CAPABILITIES).not.toContain(capability);
    }
  });

  it("review_never_asks_for_propose_either_that_is_a_different_dutys_ladder", () => {
    // Remediation proposes; review reports. A review that could `propose`
    // would be one warrant edit away from being the duty that also applies.
    expect(REVIEW_CAPABILITIES).not.toContain("propose");
  });

  it("every_capability_review_asks_for_is_one_the_warrant_grammar_knows", () => {
    // A ladder naming a capability the warrant cannot grant is inert — and an
    // inert grant that reads like authority is the failure mode this guards.
    for (const capability of REVIEW_CAPABILITIES) expect(CAPABILITIES).toContain(capability);
  });
});

describe("the write surface review actually holds", () => {
  it("no_review_modules_source_names_a_file_writing_or_pr_opening_call", async () => {
    // `writeContentsFile`/`createOrUpdateFileContents` is the Contents API —
    // the only way this codebase changes a file in a repository. No module in
    // this duty may name one, and the source mention is what is caught,
    // because a capability check can be added later while a reach cannot be
    // un-held. Every module in the directory is scanned, including any added
    // after this test was written.
    //
    // Collected into an offender list rather than asserted per file, so a
    // failure names every module that reached rather than only the first —
    // the same shape `harmonise/main.integration.test.ts` uses for its own
    // whole-tree scan.
    const banned: readonly [string, RegExp][] = [
      ["the Contents API", /\bcreateOrUpdateFileContents\b/],
      ["a file commit", /\bwriteContentsFile\b/],
      // `pulls.create(` exactly — `pulls.createReviewComment(` is this duty's
      // own inline comment and is not a pull request.
      ["opening a pull request", /\bpulls\.create\s*\(/],
      ["merging", /\bpulls\.merge\b/],
      ["pushing a ref", /\bgit\.createRef\b/],
    ];
    expect(await offenders(banned)).toEqual([]);
  });

  it("no_review_modules_source_names_a_workspace_write", async () => {
    // The workspace half of the same claim, and it now covers every module
    // rather than only `context.ts`. A review that wrote to the checkout would
    // be mutating source with no warrant capability involved at all.
    //
    // Matched as CALLS, not as words: `testmap.ts` legitimately carries
    // "writeFile" as one of the danger words it looks for in a diff, the same
    // way it carries "child_process".
    //
    // One scoped exemption: `sarif.ts` holds the duty's single `writeFile` —
    // the SARIF rendering, into the runner's temp directory, never the
    // checkout. The exemption is by module and by verb, and the companion
    // test below pins that module's target so the carve-out cannot quietly
    // widen into what this guard exists to refuse.
    const verbs = ["writeFile", "appendFile", "unlink", "rmdir", "mkdir", "rename", "rm"];
    const banned = verbs.map((verb): [string, RegExp] => [
      `${verb}()`,
      new RegExp(`\\b${verb}\\s*\\(`),
    ]);
    const held = (await offenders(banned)).filter(
      (offence) => offence !== "sarif.ts reaches writeFile()",
    );
    expect(held).toEqual([]);
  });

  it("the_sarif_emission_targets_runner_temp_and_never_names_the_workspace", async () => {
    // The companion to the exemption above: the one module allowed a
    // `writeFile` derives its target from `RUNNER_TEMP` (with the OS temp
    // directory as the only fallback) and never mentions the checkout at all
    // — a SARIF rendering that landed in `GITHUB_WORKSPACE` would be exactly
    // the workspace mutation the guard exists to refuse.
    const text = await source("sarif.ts");
    expect(text).toContain("RUNNER_TEMP");
    expect(text).not.toContain("GITHUB_WORKSPACE");
    // The single write call, and it writes the module's own rendering.
    expect([...text.matchAll(/\bwriteFile\s*\(/g)]).toHaveLength(1);
  });

  it("the_review_thread_port_declares_only_the_three_review_comment_methods", async () => {
    // The port is the answer to "what can this reach?", so it is read from the
    // interface rather than from the call sites.
    expect(await portMethods("threads.ts", "ReviewThreadApi")).toEqual(
      ["createReviewComment", "listReviewComments", "updateReviewComment"].sort(),
    );
  });

  it("the_summary_comment_port_declares_only_the_three_issue_comment_methods", async () => {
    expect(await portMethods("publish.ts", "ReviewCommentApi")).toEqual(
      ["createComment", "listComments", "updateComment"].sort(),
    );
  });

  it("the_pull_request_port_is_read_only", async () => {
    expect(await portMethods("pr.ts", "PrApi")).toEqual(["get", "listFiles"].sort());
  });
});

describe("remediation stays a proposal, from the review side of the boundary", () => {
  it("review_hands_remediation_a_comment_envelope_and_nothing_executable", async () => {
    // The envelope is base64 JSON of findings and SHAs (`publish.ts`'s
    // `encodeEnvelope`). It is data a later duty reads back — never a command,
    // a patch, or a path this duty asks anyone to write.
    const text = await source("publish.ts");
    // The envelope is base64 of a JSON serialisation, matched as that shape
    // rather than as one literal expression: the previous spelling pinned
    // `Buffer.from(JSON.stringify(previous)` including the local variable's
    // name, so renaming a local — which changes nothing about what crosses
    // the boundary — failed this test.
    expect(text).toMatch(/Buffer\.from\(\s*JSON\.stringify\(/);
    expect(text).toMatch(/toString\(\s*"base64"\s*\)/);
    // Matched as calls and imports, not as bare substrings. `not.toContain("exec")`
    // fails on any identifier that merely spells it — `execute`, `executed`,
    // a regex `.exec(` — which is a red suite for a module that reaches
    // nothing, and trains a reader to edit the test rather than look.
    const executable: readonly (readonly [string, RegExp])[] = [
      ["a shell", /\bexec(File|Sync)?\s*\(/],
      ["a spawned process", /\bspawn(Sync)?\s*\(/],
      ["the child-process module", /["']node:child_process["']/],
    ];
    for (const [what, pattern] of executable) {
      expect(pattern.test(text), `publish.ts reaches ${what}`).toBe(false);
    }
  });

  it("only_the_context_engine_runs_a_subprocess_and_only_git_log", async () => {
    // `context.ts` reads a file's recent history to inform the review. That is
    // the ONE subprocess this duty runs, and its shape is the containment: a
    // literal argv through `execFile` (never a shell), the repository root
    // passed as `-C` rather than by changing directory, and a `--` separator
    // so a path can never be read as a git option.
    const context = await source("context.ts");
    expect(context).toContain('import { execFile } from "node:child_process"');
    expect(context).toContain('"git",');
    expect(context).toContain('["-C", root, "log", "--oneline", "-n", "5", "--", rel]');
    expect(context).toContain("maxBuffer");
    for (const shell of ["execSync", "spawnSync", "{ shell:", "shell: true"]) {
      expect(context).not.toContain(shell);
    }
    // `exec` on its own (a shell) is never imported — only `execFile`.
    expect(context).not.toMatch(/import \{[^}]*\bexec\b[^}]*\} from "node:child_process"/);

    // Every other module in the duty runs nothing at all. Matched on the
    // IMPORT rather than the word, because `testmap.ts` legitimately carries
    // "child_process" as one of the danger words it looks for in a diff.
    for (const file of (await reviewModules()).filter((name) => name !== "context.ts")) {
      const text = await source(file);
      expect(text).not.toMatch(/from "node:child_process"/);
      expect(text).not.toContain("execSync(");
    }
  });
});
