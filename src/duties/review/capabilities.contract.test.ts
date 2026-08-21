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
 * past by not being on a list somebody forgot to update. That is the only
 * evasion this file closes. Two others remain open, both confirmed defeats:
 *
 * 1. **Dynamic construction defeats the source scan.** The scan is a substring
 *    and regex read of the file's text. `["write", "Contents", "File"].join("")`
 *    behind an `await import("../../core/forge.js")` reads as none of the
 *    banned strings and passes. Closing this needs the check to move from
 *    source text to the resolved module graph.
 * 2. **The port-shape regex is indentation-sensitive.** `/^\s{6}(\w+)\(params/gm`
 *    counts methods declared at exactly six spaces, which is the nesting every
 *    port in this duty happens to use. A method declared one level deeper —
 *    `rest.repos.contents.put()` at eight spaces — widens the port without
 *    changing the count this test reads.
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
    const text = await source("threads.ts");
    const port = text.slice(
      text.indexOf("export interface ReviewThreadApi"),
      text.indexOf("/** This duty's own inline thread"),
    );
    // KNOWN LIMITATION: this counts methods at exactly six spaces of
    // indentation — the nesting every port here uses. A method declared one
    // level deeper widens the port without moving this count. See the module
    // doc; closing it needs a type-level check, not a text one.
    const methods = [...port.matchAll(/^\s{6}(\w+)\(params/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual(
      ["createReviewComment", "listReviewComments", "updateReviewComment"].sort(),
    );
  });

  it("the_summary_comment_port_declares_only_the_three_issue_comment_methods", async () => {
    const text = await source("publish.ts");
    const port = text.slice(
      text.indexOf("export interface ReviewCommentApi"),
      text.indexOf("const COMMENT_PAGE"),
    );
    const methods = [...port.matchAll(/^\s{6}(\w+)\(params/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual(["createComment", "listComments", "updateComment"].sort());
  });

  it("the_pull_request_port_is_read_only", async () => {
    const text = await source("pr.ts");
    const port = text.slice(
      text.indexOf("export interface PrApi"),
      text.indexOf("/** A pull request as this duty reads it. */"),
    );
    const methods = [...port.matchAll(/^\s{6}(\w+)\(params/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual(["get", "listFiles"].sort());
  });
});

describe("remediation stays a proposal, from the review side of the boundary", () => {
  it("review_hands_remediation_a_comment_envelope_and_nothing_executable", async () => {
    // The envelope is base64 JSON of findings and SHAs (`publish.ts`'s
    // `encodeEnvelope`). It is data a later duty reads back — never a command,
    // a patch, or a path this duty asks anyone to write.
    const text = await source("publish.ts");
    expect(text).toContain("Buffer.from(JSON.stringify(previous)");
    for (const forbidden of ["exec", "spawn", "child_process"]) {
      expect(text).not.toContain(forbidden);
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
