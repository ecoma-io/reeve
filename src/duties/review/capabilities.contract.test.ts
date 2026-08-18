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
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, type Capability } from "../../core/warrant.js";
import { DEFAULT_CAPABILITIES, REVIEW_CAPABILITIES } from "./capabilities.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The capabilities that would let a duty change source, not just talk about it. */
const SOURCE_MUTATION: readonly Capability[] = ["edit-file", "open-pr"];

const source = (file: string): Promise<string> => readFile(join(HERE, file), "utf8");

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
  it("no_review_module_imports_a_file_writing_port", async () => {
    // `writeContentsFile`/`createOrUpdateFileContents` is the Contents API —
    // the only way this codebase changes a file in a repository. No module in
    // this duty may reach it, and the import is the thing to catch, because a
    // capability check can be added later while an import cannot be un-held.
    for (const file of [
      "main.ts",
      "publish.ts",
      "threads.ts",
      "pr.ts",
      "context.ts",
      "findings.ts",
      "verify.ts",
      "rules.ts",
      "risk.ts",
      "packs.ts",
      "passes.ts",
      "testmap.ts",
      "disposition.ts",
      "summary.ts",
      "verdict.ts",
      "architecture.ts",
      "evidence.ts",
      "providers.ts",
    ]) {
      const text = await source(file);
      expect(text).not.toContain("createOrUpdateFileContents");
      expect(text).not.toContain("writeContentsFile");
      // `pulls.create(` exactly — `pulls.createReviewComment(` is this duty's
      // own inline comment and is not a pull request.
      expect(text).not.toMatch(/\bpulls\.create\s*\(/);
      expect(text).not.toMatch(/\bpulls\.merge\b/);
      expect(text).not.toMatch(/\bgit\.createRef\b/);
    }
  });

  it("the_review_thread_port_declares_only_the_three_review_comment_methods", async () => {
    // The port is the answer to "what can this reach?", so it is read from the
    // interface rather than from the call sites.
    const text = await source("threads.ts");
    const port = text.slice(
      text.indexOf("export interface ReviewThreadApi"),
      text.indexOf("/** This duty's own inline thread"),
    );
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

  it("the_repository_context_reader_never_writes_to_the_workspace", async () => {
    // Context reads source to inform the review. A write here would turn the
    // read-only half of the duty into a source mutator without any warrant
    // capability being involved at all.
    const text = await source("context.ts");
    for (const forbidden of ["writeFile", "appendFile", "mkdir", "rm(", "unlink", "rename"]) {
      expect(text).not.toContain(forbidden);
    }
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
    for (const file of ["main.ts", "testmap.ts", "passes.ts", "rules.ts", "risk.ts", "packs.ts"]) {
      const text = await source(file);
      expect(text).not.toMatch(/from "node:child_process"/);
      expect(text).not.toContain("execSync(");
    }
  });
});
