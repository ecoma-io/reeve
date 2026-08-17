/**
 * The remediation duty, driven the way a runner drives it.
 *
 * Its entry point calls `run()` at import, so it cannot be imported and
 * measured — importing it would run it. What a runner actually does is spawn
 * `remediation/dist/index.js` with `INPUT_*` in the environment and read
 * `GITHUB_OUTPUT` afterwards, and that is exactly what happens below.
 *
 * It is also the only place the boundary guards that are code rather than
 * input are exercised end to end: a run whose warrant grants `propose`
 * derives proposal records from the review envelope; an over-grant of
 * `edit-file` or `open-pr` fails red naming the capability; a missing or
 * corrupt envelope is a clean stop; and — the load-bearing assertion — the
 * stub's route table exposes no write, so a run that attempted to mutate
 * would have hit a 404 and failed. Remediation never touches a mutation
 * route.
 *
 * Two collaborators are real and one is not. The bundle is real, rebuilt here
 * so a case can never pass against a stale artifact. GitHub is a local HTTP
 * server — `@actions/github` reads its base URL from `GITHUB_API_URL`, so the
 * run points at it and nothing in this file reaches a network. There is no
 * provider at all: this duty asks no model.
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// A spawn per case, each loading a multi-megabyte bundle. Comfortably under
// this, and not worth flaking over.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Where this duty is published from: a repository subdirectory of its own. */
const DUTY = join(ROOT, "remediation");
const BUNDLE = join(DUTY, "dist", "index.js");

/** A warrant granting `remediation` the one proposal capability it has. */
const WARRANT = ["version: 1", "duties:", "  remediation: [propose]"].join("\n");
/** A written block that never mentions `remediation` at all — the denied gate. */
const UNNAMED = ["version: 1", "duties:", "  triage: [label]"].join("\n");
/** A written block granting a capability this proposal-only run must refuse red. */
const OVERGRANTED = ["version: 1", "duties:", "  remediation: [edit-file]"].join("\n");

/** A review envelope payload, built with review's real encoder — test tooling may import it. */
import { encodeEnvelope as reviewEncodeEnvelope } from "../review/publish.js";
import { markerFor } from "../../core/marker.js";

const REVIEW_MARKER = markerFor("review");

/** One comment on the pull request, as the stub's listing holds it. */
interface Comment {
  readonly id: number;
  readonly body: string;
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
}

/** Everything a request is answered from, and everything a case may change. */
interface State {
  pull: Pull;
  comments: Comment[];
  /** Every mutation the stub has seen — the no-create proof counts these. */
  mutations: string[];
}

type Stub = State & { readonly url: string; close(): Promise<void> };

import type { Previous } from "../review/findings.js";

/** A review envelope comment body carrying one standing finding. */
function envelopeComment(
  findings: readonly Previous["findings"][number][] = [],
  resolved: readonly Previous["findings"][number][] = [],
): string {
  const previous: Previous = {
    findings: [...findings, ...resolved],
    reviewedShas: ["abc123"],
  };
  const payload = `${"a".repeat(16)} ${reviewEncodeEnvelope(previous)}`;
  return [REVIEW_MARKER.render(payload), "The review body."].join("\n\n");
}

function standingFinding(
  over: Partial<Previous["findings"][number]> = {},
): Previous["findings"][number] {
  return {
    id: "blocked:src/app.ts:13",
    ruleId: "blocked",
    ruleName: "No debugger",
    ruleBody: "Debugger statements must not land.",
    path: "src/app.ts",
    line: 13,
    severity: "warning",
    body: "debugger; statement on line 13.",
    marker: "",
    wasResolved: false,
    ...over,
  };
}

async function startStub(): Promise<Stub> {
  const state: State = {
    pull: {
      title: "Fix the crash",
      body: "This pull request fixes the crash on save.",
      draft: false,
      merged: false,
      state: "open",
      headSha: "abc123",
    },
    comments: [
      { id: 1, body: envelopeComment([standingFinding()]), login: "reeve[bot]", type: "Bot" },
    ],
    mutations: [],
  };

  const server = createServer((request, response) => {
    route(state, request, response);
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

function route(stub: State, request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const method = request.method ?? "GET";

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

  // Anything else is a mutation or a read this duty must never make — the
  // boundary proof. Record it and 404, the same loud failure a harness wants.
  stub.mutations.push(`${method} ${path}`);
  send(response, 404, { message: `no stub for ${method} ${path}` });
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  response.end(text);
}

beforeAll(async () => {
  // Built rather than assumed: CI runs `pnpm test` before `pnpm build`, so a
  // case driving the committed bundle would be driving whatever was committed
  // last rather than the source under review. Only this duty's bundle is
  // rebuilt, and never anyone else's.
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs"), "remediation"], {
    cwd: ROOT,
  });
}, 120_000);

interface Run {
  readonly code: number | null;
  readonly log: string;
  readonly outputs: Record<string, string>;
  readonly summary: string;
}

function baseInputs(warrant: string): Record<string, string> {
  return {
    "github-token": "stub-token",
    number: "42",
    warrant,
    "dry-run": "false",
  };
}

let scratch: string;
let warrantPath: string;

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
  for (const [name, value] of Object.entries({ ...baseInputs(warrantPath), ...inputs })) {
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

/** `GITHUB_OUTPUT` as the runner reads it back. */
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

let stub: Stub;

beforeEach(async () => {
  stub = await startStub();
  scratch = await mkdtemp(join(tmpdir(), "reeve-remediation-"));
  warrantPath = join(scratch, "reeve.yml");
  await writeFile(warrantPath, WARRANT);
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the action", () => {
  it("derives one proposal per standing finding, records it, and never mutates", async () => {
    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.outputs.proposed).toBe("true");
    expect(run.outputs.proposals).toBe("1");
    expect(run.outputs.note).toBe("");
    expect(run.summary).toContain("## Remediation");
    expect(run.summary).toContain("blocked:src/app.ts:13");
    expect(run.summary).toContain("Debugger statements must not land.");
    expect(run.summary).toContain("nothing was written");
    // The boundary proof: the stub's route table exposed no write, and the run
    // made no request beyond the one comment read.
    expect(stub.mutations).toEqual([]);
  });

  it("skips resolved findings — only standing ones are actionable", async () => {
    stub.comments = [
      {
        id: 1,
        body: envelopeComment([], [standingFinding({ wasResolved: true })]),
        login: "reeve[bot]",
        type: "Bot",
      },
    ];

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.outputs.proposed).toBe("false");
    expect(run.outputs.proposals).toBe("0");
    expect(run.summary).toContain("No remediation proposals");
  });

  it("stops clean when no review envelope exists on the pull request", async () => {
    stub.comments = [];

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.outputs.proposed).toBe("false");
    expect(run.outputs.proposals).toBe("0");
    expect(run.outputs.note).toContain("no review envelope");
    expect(stub.mutations).toEqual([]);
  });

  it("stops clean when the envelope is corrupt — absent input, not a failure", async () => {
    stub.comments = [
      {
        id: 1,
        body: REVIEW_MARKER.render(`${"a".repeat(16)} not-valid-base64!!!`),
        login: "reeve[bot]",
        type: "Bot",
      },
    ];

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.outputs.proposed).toBe("false");
    expect(run.outputs.proposals).toBe("0");
    expect(run.summary).toContain("No remediation proposals");
  });

  it("fails red when the warrant grants a capability this proposal-only run must refuse", async () => {
    const run = await runAction(stub, { warrant: await writtenAt(OVERGRANTED) });

    expect(run.code).not.toBe(0);
    expect(run.outputs.proposed).toBe("false");
    expect(run.outputs.proposals).toBe("0");
    expect(run.log).toContain("`edit-file`");
    expect(run.log).toContain("proposal-only");
    expect(stub.mutations).toEqual([]);
  });

  it("grants nothing and proposes nothing when a written block does not name it", async () => {
    const run = await runAction(stub, { warrant: await writtenAt(UNNAMED) });

    expect(run.code).toBe(0);
    expect(run.outputs.proposed).toBe("false");
    expect(run.outputs.proposals).toBe("0");
    expect(run.summary).toContain("does not name `remediation`");
    expect(stub.mutations).toEqual([]);
  });

  it("honors dry-run: derives and reports, writes nothing anywhere", async () => {
    const run = await runAction(stub, { "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(run.outputs.proposed).toBe("true");
    expect(run.outputs.proposals).toBe("1");
    expect(run.summary).toContain("**Dry run**");
    expect(stub.mutations).toEqual([]);
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
   * Every input the duty actually reads — its own, plus `threadNumber` from
   * `core/inputs.ts`. Remediation deliberately does not use `readCore` (which
   * demands `base-url` and `models` this duty does not declare), so only its
   * own `readSettings` and the shared `threadNumber` are scanned.
   */
  async function readInputs(): Promise<string[]> {
    const [own, shared] = await Promise.all([
      readFile(join(ROOT, "src", "duties", "remediation", "main.ts"), "utf8"),
      readFile(join(ROOT, "src", "core", "inputs.ts"), "utf8"),
    ]);
    const threadNumberFn = /export function threadNumber\(\)[^]*?\n}/.exec(shared)?.[0] ?? "";
    return [
      ...new Set(
        [...`${own}\n${threadNumberFn}`.matchAll(/get(?:Boolean)?Input\("([^"]+)"/g)].map(
          ([, name]) => name ?? "",
        ),
      ),
    ];
  }

  it("reads every input it declares, under the name it declared", async () => {
    expect([...(await readInputs())].sort()).toEqual([...(await declaredInputs())].sort());
  });

  it("declares the entry point this suite drives", async () => {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");

    expect(text).toContain("main: dist/index.js");
  });
});
