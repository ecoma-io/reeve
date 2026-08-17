/**
 * The review duty, driven the way a runner drives it.
 *
 * Its entry point calls `run()` at import, so it cannot be imported and
 * measured — importing it would run it. What a runner actually does is spawn
 * `review/dist/index.js` with `INPUT_*` in the environment and read
 * `GITHUB_OUTPUT` afterwards, and that is exactly what happens below.
 *
 * It is also the only place the guards that are code rather than input are
 * exercised end to end: a draft is skipped under `trigger: pr` and reviewed
 * under `prod`; a Reeve proposal PR stops clean; the confidence floor withholds
 * the comment while the findings still reach the job summary; a rerun on the
 * same PR replaces its own comment in place — or recognises the same findings
 * and changes nothing — and a run whose model never delivered a readable
 * verdict refuses to stamp the diff all-clear. A unit test can show
 * `reconcile` classes findings; only this can show nothing downstream posted a
 * false all-clear it should not have.
 *
 * Two collaborators are real and one is not. The bundle is real, rebuilt here
 * so a case can never pass against a stale artifact. GitHub and the provider
 * are a local HTTP server — `@actions/github` reads its base URL from
 * `GITHUB_API_URL` and `base-url` is an input, so both point at it and
 * nothing in this file reaches a network or a model.
 */
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// A spawn per case, each loading a multi-megabyte bundle. Comfortably under
// this, and not worth flaking over.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Where this duty is published from: a repository subdirectory of its own. */
const DUTY = join(ROOT, "review");
const BUNDLE = join(DUTY, "dist", "index.js");

const ENGLISH =
  "This pull request fixes the crash on save. I have tested it locally and it resolves the issue.";

/** A warrant granting `review` the only comment capability it has. */
const WARRANT = ["version: 1", "duties:", "  review: [comment]"].join("\n");
/** A written block that never mentions `review` at all — the denied gate. */
const UNNAMED = ["version: 1", "duties:", "  triage: [label]"].join("\n");
/** A written block naming `review` but granting it nothing at all. */
const NOTHING = ["version: 1", "duties:", "  review: [none]"].join("\n");

/** A diff whose new-file lines the stub serves and the model may cite. */
const PATCH_ONE = "@@ -1 +12,2 @@\n+const one = 1;\n+const two = 2;";
/** A second state for the same file, so a rerun can move the diff. */
const PATCH_TWO = "@@ -1 +14,2 @@\n+const one = 1;\n+const two = 2;\n+const three = 3;";

beforeAll(async () => {
  // Built rather than assumed: CI runs `pnpm test` before `pnpm build`, so a
  // case driving the committed bundle would be driving whatever was committed
  // last rather than the source under review.
  //
  // Only this duty's bundle is rebuilt, and never anyone else's: the
  // integration tests run in parallel workers, and two of them rebuilding the
  // same outfile at once could hand a spawned child a half-written bundle to
  // crash on — esbuild writes an outfile in place rather than atomically.
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs"), "review"], {
    cwd: ROOT,
  });
}, 120_000);

// ---------------------------------------------------------------------------
// The stub standing in for GitHub and for the provider.
// ---------------------------------------------------------------------------

/** One chat completion request, as the stub saw it. */
interface Ask {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly authorization: string | null;
}

interface Answer {
  readonly status: number;
  readonly payload: unknown;
}

/** One comment on the pull request, as the stub's listing holds it. */
interface Comment {
  readonly id: number;
  body: string;
  readonly login: string;
  readonly type: "User" | "Bot";
}

interface Pull {
  title: string;
  body: string;
  draft: boolean;
  merged: boolean;
  state: string;
  headSha: string;
  files: File[];
}

interface File {
  readonly filename: string;
  readonly status?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly patch?: string | null;
}

/** Everything a request is answered from, and everything a case may change. */
interface State {
  pull: Pull;
  comments: Comment[];
  nextCommentId: number;
  answer: (ask: Ask) => Answer;
  readonly asked: Ask[];
}

type Stub = State & { readonly url: string; close(): Promise<void> };

/** A completion the provider answered normally. */
function saying(content: string, finishReason = "stop"): Answer {
  return {
    status: 200,
    payload: {
      choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
  };
}

type Stage = "detect" | "review";

/** Which of this duty's stages a request belongs to, read off its own system message. */
function stageOf(ask: Ask): Stage {
  if (ask.system.includes("You identify which language")) return "detect";
  if (ask.system.includes("You are a security review pass")) return "review";
  if (ask.system.includes("You are reviewing a pull request")) return "review";
  throw new Error(`a request nothing in this suite recognised: ${ask.system.slice(0, 120)}`);
}

/**
 * An endpoint that answers every stage a sensible default, overridable per
 * stage. A case names only the stage it cares about; every other one gets an
 * answer that keeps the run moving rather than one it has to script itself.
 */
function stageAnswer(
  overrides: Partial<Record<Stage, string | ((ask: Ask) => Answer)>> = {},
): (ask: Ask) => Answer {
  return (ask) => {
    const stage = stageOf(ask);
    const over = overrides[stage];
    if (over !== undefined) return typeof over === "string" ? saying(over) : over(ask);
    return stage === "detect"
      ? saying("en")
      : saying(JSON.stringify({ findings: [], confidence: 0.9 }));
  };
}

async function startStub(): Promise<Stub> {
  const state: State = {
    pull: {
      title: "Fix the crash",
      body: ENGLISH,
      draft: false,
      merged: false,
      state: "open",
      headSha: "abc123",
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: PATCH_ONE,
        },
      ],
    },
    comments: [],
    nextCommentId: 1,
    answer: stageAnswer(),
    asked: [],
  };

  const server = createServer((request, response) => {
    void route(state, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub server did not open a port");
  }

  return Object.assign(state, {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  });
}

async function route(
  stub: State,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const method = request.method ?? "GET";
  const raw = await readAll(request);

  const pull = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
  if (method === "GET" && pull) {
    send(response, 200, {
      number: Number(pull[1]),
      title: stub.pull.title,
      body: stub.pull.body,
      state: stub.pull.state,
      draft: stub.pull.draft,
      merged: stub.pull.merged,
      head: { sha: stub.pull.headSha },
      base: { sha: "base1" },
      user: { login: "author", type: "User" },
      labels: [],
    });
    return;
  }

  const files = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/.exec(path);
  if (method === "GET" && files) {
    // One page, whole: the listing walk stops at any short page.
    send(
      response,
      200,
      stub.pull.files.map((file) => ({ ...file })),
    );
    return;
  }

  const comments = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(path);
  if (method === "GET" && comments) {
    send(
      response,
      200,
      stub.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.login, type: comment.type },
      })),
    );
    return;
  }
  if (method === "POST" && comments) {
    const payload = parsed(raw) as { body?: string };
    const comment: Comment = {
      id: stub.nextCommentId,
      body: payload.body ?? "",
      login: "reeve[bot]",
      type: "Bot",
    };
    stub.nextCommentId += 1;
    stub.comments.push(comment);
    send(response, 201, { id: comment.id, body: comment.body });
    return;
  }

  const update = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
  if (method === "PATCH" && update) {
    const payload = parsed(raw) as { body?: string };
    const found = stub.comments.find((comment) => comment.id === Number(update[1]));
    if (found) found.body = payload.body ?? "";
    send(response, 200, { id: Number(update[1]), body: found?.body ?? "" });
    return;
  }

  if (method === "POST" && path === "/v1/chat/completions") {
    const ask = askOf(raw, request.headers.authorization ?? null);
    stub.asked.push(ask);
    const answered = stub.answer(ask);
    send(response, answered.status, answered.payload);
    return;
  }

  send(response, 404, { message: `no stub for ${method} ${path}` });
}

function askOf(raw: string, authorization: string | null): Ask {
  const payload = parsed(raw) as {
    model?: unknown;
    messages?: { role?: string; content?: string }[];
  };
  const system = payload.messages?.find((message) => message.role === "system")?.content;
  const user = payload.messages?.find((message) => message.role === "user")?.content;
  return { model: String(payload.model), system: system ?? "", user: user ?? "", authorization };
}

function parsed(raw: string): unknown {
  return JSON.parse(raw);
}

async function readAll(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  response.end(text);
}

// ---------------------------------------------------------------------------
// Driving the bundle.
// ---------------------------------------------------------------------------

interface Run {
  readonly code: number | null;
  readonly log: string;
  readonly outputs: Record<string, string>;
  readonly summary: string;
}

/**
 * One consumer's settings — deliberately not a copy of `action.yml`'s
 * defaults, which the runner supplies and this file never sees. A case names
 * only what it changes.
 */
function baseInputs(
  stub: Stub,
  warrant: string,
  rules: string,
  packs: string,
): Record<string, string> {
  return {
    "github-token": "stub-token",
    number: "42",
    "base-url": `${stub.url}/v1`,
    "api-key": "sk-stub-key",
    models: "stub-model",
    warrant,
    "rules-path": rules,
    "packs-path": packs,
    trigger: "pr",
    "max-diff-chars": "4000",
    "max-context-chars": "4000",
    confidence: "0.6",
    profile: "default",
    endpoints: "",
    "api-keys": "",
    "request-timeout": "120s",
    temperature: "",
    "dry-run": "false",
  };
}

let scratch: string;
let warrantPath: string;
let rulesPath: string;
let packsPath: string;

async function runAction(
  stub: Stub,
  inputs: Record<string, string> = {},
  extra: NodeJS.ProcessEnv = {},
): Promise<Run> {
  const outputFile = join(scratch, "outputs");
  const summaryFile = join(scratch, "summary.md");
  await writeFile(outputFile, "");
  await writeFile(summaryFile, "");

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: "ecoma-io/reeve",
    GITHUB_API_URL: stub.url,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_EVENT_NAME: "pull_request",
    ...extra,
  };
  for (const [name, value] of Object.entries({
    ...baseInputs(stub, warrantPath, rulesPath, packsPath),
    ...inputs,
  })) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }

  const child = spawn(process.execPath, [BUNDLE], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (log += chunk));
  child.stderr.on("data", (chunk: string) => (log += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

  const outputs = readOutputs(await readFile(outputFile, "utf8"));
  const summary = await readFile(summaryFile, "utf8");
  return { code, log, outputs, summary };
}

/** `GITHUB_OUTPUT` as the runner reads it back. See `translate`'s identical helper for why. */
function readOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(/^([^\r\n<]+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm)) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) outputs[name] = value;
  }
  return outputs;
}

/** An `inputs` override naming a second warrant file beside the default one. */
async function writtenAt(contents: string): Promise<string> {
  const path = join(scratch, "alternate.yml");
  await writeFile(path, contents);
  return path;
}

// ---------------------------------------------------------------------------

let stub: Stub;

beforeEach(async () => {
  stub = await startStub();
  scratch = await mkdtemp(join(tmpdir(), "reeve-review-"));
  warrantPath = join(scratch, "reeve.yml");
  rulesPath = join(scratch, "reeve-rules.yml");
  packsPath = join(scratch, "reeve-packs");
  await writeFile(warrantPath, WARRANT);
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the action", () => {
  it("reviews and posts one comment with the verdict, in the diff's language", async () => {
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 13,
            snippet: "const two = 2;",
            body: "This repeats the constant above.",
          },
        ],
        confidence: 0.8,
      }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    const posted = stub.comments[0]?.body ?? "";
    expect(posted).toContain("### New findings (1)");
    expect(posted).toContain("This repeats the constant above.");
    expect(posted).toContain("<!-- reeve:review source=");
    expect(posted).toContain("<sub>");
    expect(run.outputs.commented).toBe("true");
    expect(run.outputs["head-sha"]).toBe("abc123");
    expect(run.outputs.findings).toBe("1");
    expect(run.summary).toContain("### Verdict");
    expect(run.summary).toContain("This repeats the constant above.");
  });

  it("posts nothing but still reports when the rerun finds the same review unchanged", async () => {
    const state = (confidence: number, body: string) =>
      JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 13,
            snippet: "const two = 2;",
            body,
          },
        ],
        confidence,
      });
    stub.answer = stageAnswer({ review: state(0.8, "This repeats the constant above.") });

    const first = await runAction(stub);
    expect(first.code).toBe(0);
    expect(stub.comments).toHaveLength(1);

    // Second run: the same finding at the same position reconciles as
    // `persists`, which re-renders the comment ("Still standing") and replaces
    // the old one — the thread's history is preserved, nothing is stacked.
    const second = await runAction(stub);
    expect(second.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    expect(second.outputs.commented).toBe("true");
    expect(stub.comments[0]?.body).toContain("### Still standing (1)");

    // Third run: nothing moved since, so the fingerprint is identical and the
    // comment is left alone — the literal `unchanged` disposition.
    const third = await runAction(stub);
    expect(third.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    expect(third.outputs.commented).toBe("false");
    expect(third.summary).toContain("unchanged");
  });

  it("replaces its own comment in place when the findings moved, instead of stacking a second", async () => {
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 13,
            snippet: "const two = 2;",
            body: "First claim.",
          },
        ],
        confidence: 0.8,
      }),
    });

    await runAction(stub);
    expect(stub.comments).toHaveLength(1);

    stub.pull.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: PATCH_TWO,
      },
    ];
    // The changed diff has line 14 now, and the model says the code moved under it.
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 14,
            snippet: "const three = 3;",
            body: "Second claim.",
          },
        ],
        confidence: 0.8,
      }),
    });

    const second = await runAction(stub);

    expect(second.code).toBe(0);
    expect(stub.comments).toHaveLength(1); // still one comment — replaced, not stacked
    expect(stub.comments[0]?.body).toContain("Second claim.");
    // The claim moved line with the code under it — same rule, same file, new
    // line — so it is `changed`, not `resolved`: the thread keeps its history
    // and the finding keeps its identity across line movement.
    expect(stub.comments[0]?.body).toContain("### Changed (1)");
    expect(stub.comments[0]?.body).toContain("Second claim.");
    expect(second.outputs.commented).toBe("true");
  });

  it("marks the old finding resolved when the diff moved on without it", async () => {
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 13,
            snippet: "const two = 2;",
            body: "This repeats the constant above.",
          },
        ],
        confidence: 0.8,
      }),
    });

    await runAction(stub);
    expect(stub.comments[0]?.body).toContain("New findings (1)");

    // The diff moves on: the second hunk's earlier lines are deleted under the
    // finding, so line 13 is no longer proven by the patch.
    stub.pull.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 3,
        patch: "@@ -1 +12,1 @@\n+const one = 1;" + "\n@@ -18 +14,1 @@\n+const four = 4;",
      },
    ];
    // The model still reviews the moved-on diff, but has nothing to say now.
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const second = await runAction(stub);

    expect(second.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    expect(stub.comments[0]?.body).toContain("### Resolved (1)");
    expect(second.outputs.commented).toBe("true");
  });

  it("never churns a finding's status when the same diff is reread and the model goes quiet", async () => {
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 13,
            snippet: "const two = 2;",
            body: "This repeats the constant above.",
          },
        ],
        confidence: 0.8,
      }),
    });

    await runAction(stub);
    expect(stub.comments[0]?.body).toContain("New findings (1)");

    // Same diff, same SHA; the model has nothing to add. The position still
    // stands, so the finding must survive as `persists` — never a ghost
    // `resolved` that a third run would then flip to `reopened`.
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const second = await runAction(stub);
    expect(second.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    expect(stub.comments[0]?.body).toContain("### Still standing (1)");
    expect(stub.comments[0]?.body).not.toContain("### Resolved (1)");

    const third = await runAction(stub);
    expect(third.outputs.commented).toBe("false"); // nothing moved — unchanged
  });

  it("skips a draft green under `trigger: pr`, and reviews it under `prod`", async () => {
    stub.pull.draft = true;

    const skipped = await runAction(stub);

    expect(skipped.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(stub.asked).toHaveLength(0);
    expect(skipped.outputs.commented).toBe("false");
    expect(skipped.outputs.note).toContain("draft");
    expect(skipped.summary).toContain("draft");

    const reviewed = await runAction(stub, { trigger: "prod" });

    expect(reviewed.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
  });

  it("stops clean on a merged pull request", async () => {
    stub.pull.merged = true;

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.note).toContain("already merged");
    expect(run.summary).toContain("already merged");
  });

  it("stops clean on a closed pull request", async () => {
    stub.pull.state = "closed";

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(run.outputs.note).toContain("closed");
    expect(run.summary).toContain("closed");
  });

  it("never reviews Reeve's own proposal pull request", async () => {
    stub.pull.body = "<!-- reeve:propose source=abc123 -->\n\nAdding the billing area.";

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.note).toContain("proposal");
  });

  it("fires the blocked-phrase pre-check before any model is asked", async () => {
    await writeFile(
      rulesPath,
      [
        "version: 1",
        "blocked:",
        "  - phrase: TODO-FIXME",
        "    severity: critical",
        "    note: Must be resolved.",
      ].join("\n"),
    );
    stub.pull.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +12,2 @@\n+const todo = TODO-FIXME;\n+const two = 2;",
      },
    ];
    // The deterministic finding is guaranteed; the model has nothing to add.
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    const posted = stub.comments[0]?.body ?? "";
    expect(posted).toContain("### New findings (1)");
    expect(posted).toContain("critical");
    expect(posted).toContain("Must be resolved.");
    expect(stub.asked.some((ask) => stageOf(ask) === "review")).toBe(true); // the model still saw the diff
    expect(run.outputs.findings).toBe("1");
  });

  it("fires the architecture pre-check before any model is asked", async () => {
    await writeFile(
      rulesPath,
      [
        "version: 1",
        "architecture:",
        "  layers:",
        "    domain: [src/domain/**]",
        "    infrastructure: [src/infra/**]",
        "  edges:",
        "    - from: domain",
        "      to: infrastructure",
        "      severity: critical",
        "      note: Domain must not depend on infra.",
      ].join("\n"),
    );
    stub.pull.files = [
      {
        filename: "src/domain/svc.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch:
          '@@ -1 +12,2 @@\n+import { db } from "../infra/db";\n+export function run(): void {}',
      },
    ];
    // The deterministic architecture finding is guaranteed; the model has
    // nothing to add.
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    const posted = stub.comments[0]?.body ?? "";
    expect(posted).toContain("### New findings (1)");
    expect(posted).toContain("critical");
    expect(posted).toContain("Domain must not depend on infra.");
    expect(posted).toContain("imports src/infra/db");
    // The model still saw the diff — the deterministic finding is decided
    // before it, not instead of it.
    expect(stub.asked.some((ask) => stageOf(ask) === "review")).toBe(true);
    expect(run.outputs.findings).toBe("1");
  });

  it("reports no architecture finding for a dependency in the allowed direction", async () => {
    await writeFile(
      rulesPath,
      [
        "version: 1",
        "architecture:",
        "  layers:",
        "    domain: [src/domain/**]",
        "    infrastructure: [src/infra/**]",
        "  edges:",
        "    - from: domain",
        "      to: infrastructure",
        "      severity: critical",
        "      note: Domain must not depend on infra.",
      ].join("\n"),
    );
    stub.pull.files = [
      {
        filename: "src/infra/db.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch:
          '@@ -1 +12,2 @@\n+import { svc } from "../domain/svc";\n+export function db(): void {}',
      },
    ];
    // infra → domain is allowed by the rule (direction matters), and the
    // model has nothing to add — the run posts the empty chrome.
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.outputs.commented).toBe("true");
    expect(run.outputs.findings).toBe("0");
    const posted = stub.comments[0]?.body ?? "";
    expect(posted).toContain("No issues to report");
  });

  it("composes a referenced pack's blocked phrase into the deterministic findings", async () => {
    // The rules file composes a pack by reference; the pack's `blocked`
    // phrase fires on the diff before any model is asked.
    await writeFile(rulesPath, ["version: 1", "packs:", "  - pack: go/concurrency@1.0"].join("\n"));
    await mkdir(join(packsPath, "go"), { recursive: true });
    await writeFile(
      join(packsPath, "go", "concurrency.yml"),
      [
        "version: 1.0",
        "blocked:",
        "  - phrase: TODO-FIXME",
        "    severity: warning",
        "    note: From the pack.",
      ].join("\n"),
    );
    stub.pull.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +12,2 @@\n+const todo = TODO-FIXME;\n+const two = 2;",
      },
    ];
    stub.answer = stageAnswer({ review: JSON.stringify({ findings: [], confidence: 0.9 }) });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    const posted = stub.comments[0]?.body ?? "";
    expect(posted).toContain("### New findings (1)");
    expect(posted).toContain("From the pack.");
    expect(run.outputs.findings).toBe("1");
  });

  it("fails red when a referenced pack is missing", async () => {
    await writeFile(rulesPath, ["version: 1", "packs:", "  - pack: security/owasp"].join("\n"));
    stub.pull.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+const x = 1;",
      },
    ];
    stub.answer = stageAnswer({ review: JSON.stringify({ findings: [], confidence: 0.9 }) });

    const run = await runAction(stub);

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("security/owasp");
  });

  it("fails red when a pack attempts to carry authority", async () => {
    await writeFile(rulesPath, ["version: 1", "packs:", "  - pack: evil/attempt"].join("\n"));
    await mkdir(join(packsPath, "evil"), { recursive: true });
    await writeFile(join(packsPath, "evil", "attempt.yml"), "duties:\n  review: [comment]\n");
    stub.pull.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+const x = 1;",
      },
    ];
    stub.answer = stageAnswer({ review: JSON.stringify({ findings: [], confidence: 0.9 }) });

    const run = await runAction(stub);

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("evil/attempt");
  });

  it("lets a local rule id override the same id a pack defines", async () => {
    await writeFile(
      rulesPath,
      [
        "version: 1",
        "rules:",
        "  - id: shared",
        "    name: Local shared",
        "    body: The local definition wins.",
        "packs:",
        "  - pack: go/concurrency",
      ].join("\n"),
    );
    await mkdir(join(packsPath, "go"), { recursive: true });
    await writeFile(
      join(packsPath, "go", "concurrency.yml"),
      [
        "rules:",
        "  - id: shared",
        "    name: Pack shared",
        "    body: The pack definition loses.",
      ].join("\n"),
    );
    stub.pull.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+const x = 1;",
      },
    ];
    // The model cites the shared rule; the folded rule text a finding renders
    // comes from the composed pool, where the local definition won.
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "shared",
            severity: "warning",
            path: "src/a.ts",
            line: 1,
            snippet: "const x = 1;",
            body: "The local story.",
          },
        ],
        confidence: 0.9,
      }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments[0]?.body ?? "").toContain("The local story.");
    expect(stub.asked.find((ask) => stageOf(ask) === "review")?.system ?? "").toContain(
      "Local shared",
    );
  });
  it("withholds when a rules value is the sole reason nothing was shown — a rules-skipped diff is never stamped clean", async () => {
    // The rules file's own list is the only thing keeping every file from the
    // model. The empty chrome must not vouch for a diff nothing was shown of.
    await writeFile(rulesPath, ["version: 1", "ignore:", "  paths:", "    - src/**"].join("\n"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.commented).toBe("false");
    expect(run.outputs.findings).toBe("0");
    expect(run.summary).toContain("### Coverage");
    expect(run.summary).toContain("ignored");
    expect(run.summary).toContain("src/a.ts");
  });

  it("defangs a mention inside a model-written finding before it is posted", async () => {
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 13,
            snippet: "const two = 2;",
            body: "Mention @alice and see #42.",
          },
        ],
        confidence: 0.8,
      }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    const posted = stub.comments[0]?.body ?? "";
    expect(posted).toContain("@<!---->alice");
    expect(posted).toContain("#<!---->42");
    expect(posted).not.toContain("@alice");
  });

  it("skips a generated file under the built-in suffixes, and the repo's rules can add their own", async () => {
    stub.pull.files = [
      {
        filename: "bundle.min.js",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+minified();",
      },
    ];

    // Built-in `.min.js` already means generated: the file never reaches the
    // model, and the coverage table says why.
    const flagged = await runAction(stub);

    expect(flagged.code).toBe(0);
    expect(stub.comments[0]?.body).toContain("No issues to report");
    expect(flagged.summary).toContain("### Coverage");
    expect(flagged.summary).toContain("generated");
    expect(flagged.summary).toContain("bundle.min.js");

    // A repository that does not treat a suffix as generated says so in its
    // rules — then the file is a normal file to review, skipped only when the
    // repo's own list names it.
    await writeFile(
      rulesPath,
      [
        "version: 1",
        "generated:",
        "  - .custom-gen",
        "ignore:",
        "  files:",
        "    - bundle.min.js",
      ].join("\n"),
    );
    const clean = await runAction(stub, {}); // same stub, same PR
    expect(clean.code).toBe(0);
    expect(clean.summary).toContain("ignored");
    expect(clean.summary).toContain("bundle.min.js");
  });

  it("reports ignored and capped files in the coverage table, and reviews what is left", async () => {
    await writeFile(
      rulesPath,
      ["version: 1", "ignore:", "  files:", "    - src/skip.ts"].join("\n"),
    );
    stub.pull.files = [
      {
        filename: "src/skip.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@\n+skip me",
      },
      {
        filename: "src/huge.ts",
        status: "added",
        additions: 400,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+X".repeat(6000),
      },
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: PATCH_ONE,
      },
    ];

    const run = await runAction(stub, { "max-diff-chars": "1000" });

    expect(run.code).toBe(0);
    expect(run.outputs.findings).toBe("0");
    expect(run.outputs.commented).toBe("true");
    expect(run.summary).toContain("### Coverage");
    expect(run.summary).toContain("ignored");
    expect(run.summary).toContain("capped");
    expect(run.summary).toContain("src/huge.ts");
  });

  it("discards a finding that names a line the diff cannot prove", async () => {
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 999,
            snippet: "no",
            body: "Invented a line nobody showed it.",
          },
        ],
        confidence: 0.8,
      }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.outputs.findings).toBe("0");
  });

  it("withholds the comment below the confidence floor but still reports the findings", async () => {
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "src/a.ts",
            line: 13,
            snippet: "const two = 2;",
            body: "This repeats the constant above.",
          },
        ],
        confidence: 0.4,
      }),
    });

    const run = await runAction(stub, { confidence: "0.6" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.commented).toBe("false");
    expect(run.outputs.findings).toBe("1"); // reconciled and counted
    // The floor decision is named in the log; the page shows the reconciliation
    // the comment would have carried, and says the write did not happen.
    expect(run.log).toContain("below the");
    expect(run.summary).toContain("Posted | nothing to post");
    expect(run.summary).toContain("This repeats the constant above.");
  });

  it("refuses to stamp an all-clear when the diff was reviewed but the verdict never arrived", async () => {
    stub.answer = stageAnswer({
      review: "this is not json",
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0); // the empty chrome is not posted
    expect(run.outputs.commented).toBe("false");
    expect(run.outputs.findings).toBe("0");
    // The page names the unreadable answer and says nothing was posted — a
    // diff nobody reviewed is not stamped all-clear.
    expect(run.summary).toContain("Unreadable");
    expect(run.summary).toContain("discarded");
    expect(run.summary).toContain("Posted | nothing to post");
  });

  it("rotates past a model that is out of capacity and reports it as weather, not a red failure", async () => {
    stub.answer = stageAnswer({
      review: (ask) =>
        ask.model === "stub-model-a"
          ? { status: 429, payload: { error: { message: "out of quota" } } }
          : saying(JSON.stringify({ findings: [], confidence: 0.9 })),
    });

    const run = await runAction(stub, { models: "stub-model-a, stub-model-b" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    expect(run.outputs.starved).toBe("false");
  });

  it("fails red the instant a model reports an authentication problem", async () => {
    stub.answer = stageAnswer({
      review: () => ({ status: 401, payload: { error: { message: "invalid api key" } } }),
    });

    const run = await runAction(stub);

    expect(run.code).not.toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.log).toContain("HTTP 401");
  });

  it("grants nothing and spends nothing when a written block does not name it", async () => {
    const run = await runAction(stub, { warrant: await writtenAt(UNNAMED) });

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.commented).toBe("false");
    expect(run.summary).toContain("does not name `review`");
  });

  it("grants nothing when the warrant names it but hands it an empty list", async () => {
    const run = await runAction(stub, { warrant: await writtenAt(NOTHING) });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.commented).toBe("false");
    // `[none]` is a decision about the duty, not silence about it: the run
    // still reviews and reports, but the single write it would have made is
    // withheld.
    expect(run.outputs.findings).toBe("0");
    expect(run.summary).toContain("nothing to post");
    expect(run.log).toContain("not granted");
  });

  it("writes every output and posts nothing on a dry run", async () => {
    const run = await runAction(stub, { "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.commented).toBe("false");
    expect(run.outputs.findings).toBe("0");
    expect(run.log).toContain("would have received");
  });
});

describe("the context engine", () => {
  /** Writes a workspace source tree into the scratch checkout and lets the run read it. */
  async function withWorkspace(files: Record<string, string>): Promise<NodeJS.ProcessEnv> {
    for (const [rel, text] of Object.entries(files)) {
      const path = join(scratch, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    return { GITHUB_WORKSPACE: scratch };
  }

  it("reads the workspace and carries bounded context into the review prompt", async () => {
    const extra = await withWorkspace({
      "src/util.ts": "export function keeper(): void {}\n",
      "src/util.test.ts": "import { keeper } from './util';\nit('runs', () => { keeper(); });\n",
    });
    stub.pull.files = [
      {
        filename: "src/util.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+export function keeper(): void {}",
      },
    ];
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const run = await runAction(stub, {}, extra);

    expect(run.code).toBe(0);
    const ask = stub.asked.find((entry) => stageOf(entry) === "review");
    expect(ask?.user).toContain("keeper");
    expect(ask?.user).toContain("src/util.test.ts");
    // The context is evidence inside the same nonce fence, never a second header shape.
    expect(ask?.user).toContain("untrusted-diff");
  });

  it("drops the context sections when the diff is capped, never half-showing one", async () => {
    const extra = await withWorkspace({
      "src/util.ts": "export function keeper(): void {}\n",
    });
    stub.pull.files = [
      {
        filename: "src/util.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+export function keeper(): void {}",
      },
    ];
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const run = await runAction(stub, { "max-context-chars": "1" }, extra);

    expect(run.code).toBe(0);
    const ask = stub.asked.find((entry) => stageOf(entry) === "review");
    // The diff still shows; the supplementary sections are dropped whole.
    expect(ask?.user).toContain("DIFF");
    expect(ask?.user).not.toContain("SYMBOLS DEFINED");
    // The summary names the context reads.
    expect(run.summary).toContain("Context");
  });

  it("never surfaces a secret file in the context", async () => {
    const extra = await withWorkspace({
      "src/util.ts": "export function keeper(): void {}\n",
      ".env": "API_KEY=super-secret-value\n",
      "credentials.yml": "user: pass\n",
    });
    stub.pull.files = [
      {
        filename: "src/util.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+export function keeper(): void {}",
      },
    ];
    stub.answer = stageAnswer({
      review: JSON.stringify({ findings: [], confidence: 0.9 }),
    });

    const run = await runAction(stub, {}, extra);

    expect(run.code).toBe(0);
    const ask = stub.asked.find((entry) => stageOf(entry) === "review");
    expect(ask?.user).not.toContain("super-secret-value");
    expect(ask?.user).not.toContain("API_KEY=");
  });

  it("still requires a finding to be diff-proven even when context names other files", async () => {
    const extra = await withWorkspace({
      "src/util.ts": "export function keeper(): void {}\n",
      "context-only.ts": "export const unproven = 1;\n",
    });
    stub.pull.files = [
      {
        filename: "src/util.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+export function keeper(): void {}",
      },
    ];
    // The model overreaches to a file the diff never showed — the answer is unreadable.
    stub.answer = stageAnswer({
      review: JSON.stringify({
        findings: [
          {
            rule: "dedup",
            severity: "warning",
            path: "context-only.ts",
            line: 1,
            snippet: "x",
            body: "Context must not authorise a finding about a file the diff never showed.",
          },
        ],
        confidence: 0.9,
      }),
    });

    const run = await runAction(stub, {}, extra);

    expect(run.code).toBe(0);
    // No finding about the unproven file was posted.
    expect(stub.comments[0]?.body ?? "").not.toContain("context-only.ts");
    expect(run.outputs.findings).toBe("0");
  });
});

describe("the action contract", () => {
  /**
   * Every input `action.yml` declares, read straight out of it.
   *
   * A regex rather than the YAML parser this repository carries: that one is
   * bundled into the duties to read a warrant at runtime, and reaching for it
   * here would make this suite agree with itself about a file it is checking.
   */
  async function declaredInputs(): Promise<string[]> {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");
    const block = /\ninputs:\n([\s\S]*?)\noutputs:\n/.exec(text)?.[1] ?? "";
    return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(([, name]) => name ?? "");
  }

  /**
   * Every input the duty actually reads — its own, plus the two functions it
   * reaches into `core/inputs.ts` for: `readCore`, which reads the inputs
   * every duty declares, and `threadNumber`.
   *
   * Only those two bodies are scanned there, not the whole file: `review` is
   * deliberately built on `readCore` and not on `readShared` (see
   * `readSettings`'s doc comment in `main.ts`), so `sweep`, `since` and
   * `limit` — which `readShared` reads and this duty never calls — must not
   * be credited to it just for living in the same shared file.
   */
  async function readInputs(): Promise<string[]> {
    const [own, shared] = await Promise.all([
      readFile(join(ROOT, "src", "duties", "review", "main.ts"), "utf8"),
      readFile(join(ROOT, "src", "core", "inputs.ts"), "utf8"),
    ]);
    const readCoreFn = /export function readCore\([^]*?\n}/.exec(shared)?.[0] ?? "";
    const threadNumberFn = /export function threadNumber\(\)[^]*?\n}/.exec(shared)?.[0] ?? "";
    return [
      ...new Set(
        [
          ...`${own}\n${readCoreFn}\n${threadNumberFn}`.matchAll(
            /get(?:Boolean)?Input\("([^"]+)"/g,
          ),
        ].map(([, name]) => name ?? ""),
      ),
    ];
  }

  it("reads every input it declares, under the name it declared", async () => {
    expect([...(await readInputs())].sort()).toEqual([...(await declaredInputs())].sort());
  });

  it("offers every input to a local run, under the name `pnpm try` reads", async () => {
    const text = await readFile(join(ROOT, ".env.example"), "utf8");
    const documented = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name);

    for (const input of await declaredInputs()) {
      expect(documented).toContain(input.replace(/-/g, "_").toUpperCase());
    }
  });

  it("declares the entry point this suite drives", async () => {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");

    expect(text).toContain("main: dist/index.js");
  });

  it("keeps every source file reviewable as text", async () => {
    // Shared with every other duty's suite, and repeated here rather than
    // trusted to run elsewhere: a control character in a source file is not a
    // style question, and this duty's own files are exactly the ones this
    // brief added. See `translate/main.integration.test.ts`'s identical case
    // for the full rationale.
    const offenders: string[] = [];
    for (const file of await readdir(join(ROOT, "src", "duties", "review"))) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(join(ROOT, "src", "duties", "review", file), "utf8");
      // eslint-disable-next-line no-control-regex -- finding one is the point
      const found = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(text);
      if (found !== null) {
        const at = found[0].codePointAt(0) ?? 0;
        offenders.push(`${file} holds U+${at.toString(16).padStart(4, "0").toUpperCase()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
