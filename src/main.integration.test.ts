/**
 * The root action, driven the way a runner drives it.
 *
 * Its entry point calls `run()` at import, so it cannot be imported and
 * measured directly — see `src/doctor/run.ts`'s own doc comment for why that
 * is true of `doctor: true` too, not only of the refusal. What a runner
 * actually does is spawn `dist/index.js` with `INPUT_*` in the environment
 * and read `GITHUB_OUTPUT`/`GITHUB_STEP_SUMMARY` afterwards, and that is
 * exactly what happens below.
 *
 * Only one collaborator is real: the bundle, rebuilt here so a case can never
 * pass against a stale artifact. GitHub is a local HTTP server answering the
 * one endpoint `doctor: true` ever reads — `@actions/github` takes its base
 * URL from `GITHUB_API_URL` — and there is no provider stub at all, because
 * this action never asks a model anything.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(ROOT, "dist", "index.js");

const TAXONOMY =
  "version: 1\n" +
  "labels:\n" +
  "  - name: bug\n" +
  "    description: A defect.\n" +
  "  - name: docs\n" +
  "    description: Documentation is wrong or missing.\n";

beforeAll(async () => {
  // Built rather than assumed: CI runs `pnpm test` before `pnpm build`, so a
  // case driving the committed bundle would be driving whatever was
  // committed last rather than the source under review.
  //
  // Only this bundle is rebuilt, and never anyone else's: the integration
  // tests run in parallel workers, and two of them rebuilding the same
  // outfile at once could hand a spawned child a half-written bundle to crash
  // on — esbuild writes an outfile in place rather than atomically.
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs"), "root"], {
    cwd: ROOT,
  });
}, 120_000);

// ---------------------------------------------------------------------------
// The stub standing in for GitHub.
// ---------------------------------------------------------------------------

interface State {
  /** The repository's own label list, which the warrant is checked against. */
  repositoryLabels: string[];
  /** When set, every `GET .../labels` answers this status instead of the list. */
  labelsStatus: number | null;
}

type Stub = State & { readonly url: string; close(): Promise<void> };

async function startStub(): Promise<Stub> {
  const state: State = { repositoryLabels: ["bug", "docs"], labelsStatus: null };

  const server = createServer((request, response) => {
    handle(state, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url =
    typeof address === "object" && address !== null
      ? `http://127.0.0.1:${String(address.port)}`
      : "";

  // `state` itself, not a copy of it: a case mutates `stub.labelsStatus`
  // after this returns, and the running server's `handle` closure has to see
  // that same write rather than a snapshot taken at start time.
  return Object.assign(state, {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  });
}

function handle(state: State, request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? "").split("?")[0] ?? "";
  const method = request.method ?? "GET";

  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) {
    if (state.labelsStatus !== null) {
      send(response, state.labelsStatus, { message: "stubbed failure" });
      return;
    }
    send(
      response,
      200,
      state.repositoryLabels.map((name) => ({ name, description: "d" })),
    );
    return;
  }

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

// ---------------------------------------------------------------------------
// Driving the bundle.
// ---------------------------------------------------------------------------

interface Run {
  readonly code: number | null;
  readonly log: string;
  readonly outputs: Record<string, string>;
  readonly summary: string;
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
    GITHUB_EVENT_NAME: "issues",
    GITHUB_ACTION_REF: "v0.1",
    ...extra,
  };
  const settings: Record<string, string> = {
    duty: "",
    doctor: "false",
    "github-token": "stub-token",
    warrant: warrantPath,
    ...inputs,
  };
  for (const [name, value] of Object.entries(settings)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }

  const child = spawn(process.execPath, [BUNDLE], {
    cwd: extra.GITHUB_WORKSPACE ?? ROOT,
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

/** `GITHUB_OUTPUT` as the runner reads it back — see `triage/main.integration.test.ts`'s copy for why it is parsed rather than asserted as raw text. */
function readOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(/^([^\r\n<]+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm)) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) outputs[name] = value;
  }
  return outputs;
}

let stub: Stub;

beforeEach(async () => {
  stub = await startStub();
  scratch = await mkdtemp(join(tmpdir(), "reeve-root-"));
  warrantPath = join(scratch, "reeve.yml");
  await writeFile(warrantPath, TAXONOMY);
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the root action", () => {
  it("still refuses, unchanged, when `doctor` is false", async () => {
    const run = await runAction(stub, { doctor: "false" });

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("is not a duty");
    expect(run.outputs.problems).toBeUndefined();
  });

  it("still refuses naming the duty when `doctor` is false and `duty` names one", async () => {
    const run = await runAction(stub, { doctor: "false", duty: "triage" });

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("`triage` is a duty, but it is not this action.");
    expect(run.log).toContain("uses: ecoma-io/reeve/triage@v0.1");
  });

  it("names lifecycle's own is-a-duty refusal text, exactly the same shape as every other shipped duty", async () => {
    const run = await runAction(stub, { doctor: "false", duty: "lifecycle" });

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("`lifecycle` is a duty, but it is not this action.");
    expect(run.log).toContain("uses: ecoma-io/reeve/lifecycle@v0.1");
  });

  it("fails clean, naming the accepted spellings, when `doctor` is not a recognised boolean", async () => {
    const run = await runAction(stub, { doctor: "yes" });

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("true | True | TRUE | false | False | FALSE");
    expect(run.log).not.toContain("TypeError");
    expect(run.log).not.toMatch(/\n\s*at /);
  });

  it("is green with `problems: 0` when the warrant is healthy", async () => {
    const run = await runAction(stub, { doctor: "true" });

    expect(run.code).toBe(0);
    expect(run.outputs.problems).toBe("0");
    expect(run.summary).toContain("## Reeve · doctor");
    expect(run.summary).toContain("### Problems");
    expect(run.summary).toContain("None — nothing here would refuse a duty at runtime.");
    expect(run.summary).toContain("### Effective authority");
  });

  it("is red with a `problems` count when the warrant names a label the repository does not have", async () => {
    await writeFile(
      warrantPath,
      "version: 1\nlabels:\n  - name: bug\n    description: A defect.\n  - name: missing\n    description: Not real.\n",
    );

    const run = await runAction(stub, { doctor: "true" });

    expect(run.code).not.toBe(0);
    expect(run.outputs.problems).toBe("1");
    expect(run.summary).toContain("### Problems");
    expect(run.summary).toContain("`missing`");
  });

  it("stays green, and names the endpoint, when the labels check fails on capacity", async () => {
    stub.labelsStatus = 503;

    const run = await runAction(stub, { doctor: "true" });

    expect(run.code).toBe(0);
    expect(run.outputs.problems).toBe("0");
    expect(run.summary).toContain("GET /repos/{owner}/{repo}/labels");
    expect(run.summary).toContain("not performed");
  });

  it("fails red when the labels endpoint refuses this run's token", async () => {
    stub.labelsStatus = 401;

    const run = await runAction(stub, { doctor: "true" });

    expect(run.code).not.toBe(0);
    expect(run.outputs.problems).toBe("1");
    expect(run.summary).toContain("HTTP 401");
  });

  it("scopes the report to one duty when `duty` names it", async () => {
    const run = await runAction(stub, { doctor: "true", duty: "lifecycle" });

    expect(run.code).toBe(0);
    expect(run.summary).toContain("scoped to `lifecycle`.");
    expect(run.summary).not.toContain("| `triage` |");
  });

  it("is red, naming the missing checkout, when the workspace is empty and the warrant is absent at its default path", async () => {
    // The runner that populates a workspace is `actions/checkout`; an empty
    // workspace is a runner this repository's files never reached. The warrant
    // is absent at its default path, so the report can only call this level 0
    // if it mistakes "never checked out" for "this repository wrote no
    // warrant" — the exact blind spot this finding closes.
    const emptyWorkspace = join(scratch, "empty-workspace");
    await mkdir(emptyWorkspace);

    const run = await runAction(
      stub,
      { doctor: "true", warrant: ".github/reeve.yml" },
      { GITHUB_WORKSPACE: emptyWorkspace },
    );

    expect(run.code).not.toBe(0);
    expect(run.outputs.problems).toBe("1");
    expect(run.summary).toContain("### Problems");
    expect(run.summary).toContain("actions/checkout");
    expect(run.summary).not.toContain("narrowest authority");
  });
});
