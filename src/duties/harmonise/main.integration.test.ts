/**
 * The harmonise duty, driven the way a runner drives it.
 *
 * The suite next to this one is named `main.integration.test.ts` and drives
 * nothing: it is a regex read of `action.yml`, and its case
 * `it("declares the entry point this suite drives")` asserts a claim that was
 * not true — no suite drove this entry point. That is what this file is for.
 *
 * It exists because an auditor forced harmonise's capability gates open —
 * `canWriteBranch` at `main.ts:344`, `canWriteDefault` at `:382`, and
 * `canPublish` at `:706` — and the entire repository stayed green. 896 lines
 * of orchestration, including every gate on the duty that writes documentation
 * files and opens pull requests, had no executable evidence of any kind.
 *
 * The bundle is real and rebuilt here. GitHub and the model endpoint are one
 * local HTTP server. Nothing here reaches a network.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DUTY = join(ROOT, "harmonise");
const BUNDLE = join(DUTY, "dist", "index.js");

const SOURCE_DOC =
  "# Getting started\n\nThis guide explains how to set Reeve up in a repository.\n";
const TARGET_DOC = "# Bắt đầu\n\nHướng dẫn này giải thích cách thiết lập Reeve.\n";
/** A draft close enough to the target that scoring admits it. */
const DRAFT_DOC = "# Bắt đầu\n\nHướng dẫn này giải thích cách thiết lập Reeve trong kho lưu trữ.\n";

const GRANTED = [
  "version: 1",
  "languages: [en, vi]",
  "duties:",
  "  harmonise: [edit-file, open-pr]",
].join("\n");

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs"), "harmonise"], {
    cwd: ROOT,
  });
}, 180_000);

interface Write {
  readonly path: string;
  readonly branch: string | undefined;
  readonly content: string;
}

interface State {
  readonly writes: Write[];
  readonly refs: string[];
  readonly pulls: { title: string; head: string }[];
  readonly asked: string[];
  readonly files: Map<string, string>;
  readonly existingRefs: Set<string>;
  /** Extra blobs by sha, for revisions no longer in `files`. */
  readonly blobs: Map<string, string>;
  /** What the model endpoint answers with, by call order. */
  answer: (at: number) => { status: number; payload: unknown };
}

type Stub = State & { readonly url: string; close: () => Promise<void> };

function saying(content: string): { status: number; payload: unknown } {
  return {
    status: 200,
    payload: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] },
  };
}

/**
 * The default script: classify says the change is semantic, then every later
 * request is a draft.
 */
function defaultAnswer(at: number): { status: number; payload: unknown } {
  return at === 0 ? saying("semantic|Explains the repository set-up") : saying(DRAFT_DOC);
}

async function startStub(): Promise<Stub> {
  const state: State = {
    writes: [],
    refs: [],
    pulls: [],
    asked: [],
    existingRefs: new Set(["heads/main"]),
    blobs: new Map(),
    files: new Map([
      ["docs/start.md", SOURCE_DOC],
      ["docs/start.vi.md", TARGET_DOC],
    ]),
    answer: defaultAnswer,
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

function send(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  response.end(text);
}

async function readAll(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function route(
  stub: State,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const method = request.method ?? "GET";
  const raw = await readAll(request);

  if (method === "POST" && path === "/v1/chat/completions") {
    const body = JSON.parse(raw) as { model?: string };
    const at = stub.asked.length;
    stub.asked.push(body.model ?? "");
    const answer = stub.answer(at);
    send(response, answer.status, answer.payload);
    return;
  }

  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
    send(response, 200, { default_branch: "main" });
    return;
  }
  if (method === "GET" && path.endsWith("/labels")) {
    send(response, 200, []);
    return;
  }
  const ref = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/(.+)$/.exec(path);
  if (method === "GET" && ref) {
    const name = decodeURIComponent(ref[1] ?? "");
    if (!stub.existingRefs.has(name)) {
      send(response, 404, { message: "Not Found" });
      return;
    }
    send(response, 200, { object: { sha: "base-sha" } });
    return;
  }
  if (method === "POST" && path.endsWith("/git/refs")) {
    const created = (JSON.parse(raw) as { ref: string }).ref;
    stub.refs.push(created);
    stub.existingRefs.add(created.replace(/^refs\//, ""));
    send(response, 201, {});
    return;
  }
  // The Git Blobs API: harmonise reads a file's previous revision by sha to
  // diff against it. The stub mints shas as `sha-<path>`, so the blob for one
  // is that path's current content.
  const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/(.+)$/.exec(path);
  if (method === "GET" && blob) {
    const sha = decodeURIComponent(blob[1] ?? "");
    const at = sha.replace(/^sha-/, "");
    const file = stub.files.get(at) ?? stub.blobs.get(sha);
    if (file === undefined) {
      send(response, 404, { message: "Not Found" });
      return;
    }
    send(response, 200, {
      sha,
      size: Buffer.byteLength(file),
      content: Buffer.from(file, "utf8").toString("base64"),
      encoding: "base64",
    });
    return;
  }
  if (method === "GET" && path.includes("/git/trees/")) {
    send(response, 200, {
      tree: [...stub.files.keys()].map((entry) => ({ path: entry, type: "blob" })),
    });
    return;
  }
  const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path);
  if (contents) {
    const at = decodeURIComponent(contents[1] ?? "");
    if (method === "GET") {
      const file = stub.files.get(at);
      if (file === undefined) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 200, {
        name: at.split("/").pop(),
        path: at,
        sha: `sha-${at}`,
        content: Buffer.from(file, "utf8").toString("base64"),
        encoding: "base64",
      });
      return;
    }
    if (method === "PUT") {
      const body = JSON.parse(raw) as { content: string; branch?: string };
      stub.writes.push({
        path: at,
        branch: body.branch,
        content: Buffer.from(body.content, "base64").toString("utf8"),
      });
      send(response, 200, { content: { sha: `written-${at}` } });
      return;
    }
  }
  if (path.endsWith("/pulls")) {
    if (method === "GET") {
      send(response, 200, []);
      return;
    }
    if (method === "POST") {
      const body = JSON.parse(raw) as { title: string; head: string };
      stub.pulls.push({ title: body.title, head: body.head });
      send(response, 201, { number: 202 });
      return;
    }
  }
  send(response, 200, {});
}

interface Run {
  readonly code: number | null;
  readonly log: string;
  readonly outputs: Record<string, string>;
  readonly summary: string;
}

let stub: Stub;
let scratch: string;
let warrantPath: string;

function baseInputs(): Record<string, string> {
  return {
    "github-token": "stub-token",
    "base-url": `${stub.url}/v1`,
    "api-key": "sk-stub-key",
    models: "stub-model",
    "source-language": "en",
    warrant: warrantPath,
    drafts: "1",
    "judge-models": "",
    "provenance-dir": ".reeve",
    "state-branch": "",
    "glossary-dir": ".reeve/glossary",
    paths: "",
    "dry-run": "false",
    "max-requests": "none",
    endpoints: "",
    "api-keys": "",
    "request-timeout": "120s",
    "chunk-chars": "0",
    ignore: "false",
    temperature: "",
    sweep: "false",
    number: "",
    since: "",
    limit: "none",
  };
}

async function runAction(inputs: Record<string, string> = {}): Promise<Run> {
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
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
  };
  for (const [name, value] of Object.entries({ ...baseInputs(), ...inputs })) {
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

  return {
    code,
    log,
    outputs: readOutputs(await readFile(outputFile, "utf8")),
    summary: await readFile(summaryFile, "utf8"),
  };
}

function readOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(/^([^\r\n<]+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm)) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) outputs[name] = value;
  }
  return outputs;
}

beforeEach(async () => {
  stub = await startStub();
  scratch = await mkdtemp(join(tmpdir(), "reeve-harmonise-"));
  warrantPath = join(scratch, "reeve.yml");
  await writeFile(warrantPath, GRANTED);
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the publish gate", () => {
  it("publishes when the warrant grants both capabilities and this is not a dry run", async () => {
    // The case that proves the gate is a GATE. Without it every "writes
    // nothing" assertion below would pass against a duty that had stopped
    // working entirely.
    const run = await runAction();

    expect(run.code).toBe(0);
    expect(stub.writes.map((write) => write.path)).toContain("docs/start.vi.md");
    expect(stub.pulls).toHaveLength(1);
  });

  it("writes nothing when the warrant grants the duty no capability at all", async () => {
    await writeFile(warrantPath, GRANTED.replace("[edit-file, open-pr]", "[none]"));

    const run = await runAction();

    expect(run.code).toBe(0);
    expect(stub.writes).toEqual([]);
    expect(stub.pulls).toEqual([]);
  });

  it("writes nothing when only `edit-file` is granted", async () => {
    await writeFile(warrantPath, GRANTED.replace("[edit-file, open-pr]", "[edit-file]"));

    const run = await runAction();

    expect(run.code).toBe(0);
    expect(stub.writes).toEqual([]);
    expect(stub.pulls).toEqual([]);
  });

  it("writes nothing when only `open-pr` is granted", async () => {
    await writeFile(warrantPath, GRANTED.replace("[edit-file, open-pr]", "[open-pr]"));

    const run = await runAction();

    expect(run.code).toBe(0);
    expect(stub.writes).toEqual([]);
    expect(stub.pulls).toEqual([]);
  });

  it("says which capabilities are missing rather than failing silently", async () => {
    await writeFile(warrantPath, GRANTED.replace("[edit-file, open-pr]", "[none]"));

    const run = await runAction();

    expect(run.log).toContain("edit-file");
    expect(run.log).toContain("open-pr");
  });

  it("writes nothing on a dry run, even with both capabilities granted", async () => {
    const run = await runAction({ "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(stub.writes).toEqual([]);
    expect(stub.pulls).toEqual([]);
    expect(stub.refs).toEqual([]);
  });

  it("still says what it would have done on a dry run", async () => {
    const run = await runAction({ "dry-run": "true" });

    expect(run.log).toContain("dry-run");
  });
});
