/**
 * The lifecycle duty, driven the way a runner drives it.
 *
 * `main.ts` calls `run()` at import, so it cannot be imported and measured —
 * importing it would run it. What a runner actually does is spawn
 * `lifecycle/dist/index.js` with `INPUT_*` in the environment and read
 * `GITHUB_OUTPUT` afterwards, and that is exactly what happens below.
 *
 * This is also the only place several of PR review batch 1's fixes are
 * exercised end to end rather than against `clock.ts`'s pure functions in
 * isolation: the attribution-gated un-staling (A1), the same-run
 * apply-then-remove guard (A3), `threads:` filtering and budget discipline in
 * an actual sweep (A2, A4), a mid-sweep capacity error (A5), and a dry run
 * reporting the full would-do ledger instead of "Nothing due." (A6). A unit
 * test can show `evaluateTrack` computes the right `toUnstale`; only this can
 * show that nothing downstream removed the label anyway.
 *
 * The bundle is real, rebuilt here so a case can never pass against a stale
 * artifact. GitHub is a local HTTP server — `@actions/github` reads its base
 * URL from `GITHUB_API_URL` — so nothing in this file reaches a real network.
 * Unlike every other duty's own integration suite, there is no model stub:
 * `main.ts`'s own doc comment is the reason — this duty never calls one.
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { fingerprint, markerFor } from "../../core/marker.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DUTY = join(ROOT, "lifecycle");
const BUNDLE = join(DUTY, "dist", "index.js");

const MARKER = markerFor("lifecycle");

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/** A track's marker fingerprint, computed exactly as `clock.ts`'s `fingerprintFor` does — see its own doc comment: only the track's `name` and step index feed the digest, never the rest of the parsed shape. */
function markerFingerprint(trackName: string, stepIndex: number, anchor: Date): string {
  return fingerprint(anchor.toISOString(), [trackName, String(stepIndex)]);
}

/** Two-step track: label after 14d, close after 14d more (cumulative from the label's own firing). Shared by every case that does not need a second track. */
const WARRANT = [
  "version: 1",
  "labels:",
  "  - name: bug",
  "    description: A defect.",
  "lifecycle:",
  "  tracks:",
  "    - name: stale",
  "      steps:",
  "        - label: stale",
  "          after: 14d",
  "        - close: true",
  "          after: 14d",
  "  exempt:",
  "    labels: [pinned]",
  "duties:",
  "  lifecycle: [label, comment, close]",
].join("\n");

/** `threads:` narrowed to pull requests only, otherwise identical to `WARRANT`. */
const PRS_ONLY_WARRANT = WARRANT.replace("lifecycle:\n", "lifecycle:\n  threads: prs\n");

/** Two tracks: one whose due `close` is blocked by `exempt.comments`, one an unrelated `when:` reminder. */
const TWO_TRACK_WARRANT = [
  "version: 1",
  "labels:",
  "  - name: bug",
  "    description: A defect.",
  "lifecycle:",
  "  tracks:",
  "    - name: closing",
  "      resets: author",
  "      steps:",
  "        - say: true",
  "          after: 14d",
  "        - close: true",
  "          after: 14d",
  "    - name: reminder",
  "      when: needs-attention",
  "      steps:",
  "        - say: true",
  "          after: 14d",
  "  exempt:",
  "    labels: [pinned]",
  "    comments: 1",
  "duties:",
  "  lifecycle: [label, comment, close]",
].join("\n");

beforeAll(async () => {
  // Built rather than assumed: CI runs `pnpm test` before `pnpm build`, so a
  // case driving the committed bundle would be driving whatever was committed
  // last rather than the source under review.
  //
  // Only this duty's bundle is rebuilt, and never anyone else's: the
  // integration tests run in parallel workers, and two of them rebuilding the
  // same outfile at once could hand a spawned child a half-written bundle to
  // crash on — esbuild writes an outfile in place rather than atomically.
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs"), "lifecycle"], {
    cwd: ROOT,
  });
}, 120_000);

// ---------------------------------------------------------------------------
// The stub standing in for GitHub.
// ---------------------------------------------------------------------------

interface ThreadRecord {
  title: string;
  body: string;
  labels: string[];
  closed: boolean;
  milestone: string | null;
  assignees: string[];
  authorLogin: string;
  createdAt: string;
  isPullRequest: boolean;
  draft: boolean;
  comments: { id: number; body: string; login: string; bot: boolean; createdAt: string }[];
  events: {
    event: string;
    label?: string;
    login: string;
    bot: boolean;
    createdAt: string;
  }[];
}

function thread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    title: "A thread",
    body: "Some body text.",
    labels: [],
    closed: false,
    milestone: null,
    assignees: [],
    authorLogin: "carol",
    createdAt: daysAgo(90).toISOString(),
    isPullRequest: false,
    draft: false,
    comments: [],
    events: [],
    ...over,
  };
}

interface State {
  ownLogin: string;
  /**
   * `GET /user` answers 403 instead of a login — what a GitHub App
   * installation token, which every default `GITHUB_TOKEN` is, actually gets
   * back. The stub answered 200 unconditionally, which is why the duty
   * shipped with a run-ending throw on the path every consumer takes.
   */
  ownLoginForbidden: boolean;
  threads: Map<number, ThreadRecord>;
  /** The order a sweep's listing hands threads back in — `main.ts` re-sorts oldest-first itself, so this need not be pre-sorted. */
  listing: number[];
  repositoryLabels: string[];
  effects: {
    applied: { number: number; label: string }[];
    removed: { number: number; label: string }[];
    comments: { number: number; body: string }[];
    closed: number[];
  };
  /** A thread number whose standing read answers 429 — simulates GitHub's own capacity running out mid-sweep (D12). */
  capacityFailAt: number | null;
  /**
   * A thread number whose label write answers a bare 403 — a permission
   * failure, not weather, arriving after an earlier thread in the same sweep
   * was already labelled. D12's other side: this one is configuration, so it
   * stays red rather than stopping the walk quietly.
   */
  writeForbiddenAt: number | null;
}

type Stub = State & { readonly url: string; close(): Promise<void> };

async function startStub(): Promise<Stub> {
  const state: State = {
    ownLogin: "reeve[bot]",
    ownLoginForbidden: false,
    threads: new Map(),
    listing: [],
    repositoryLabels: ["bug", "stale", "pinned", "needs-attention"],
    effects: { applied: [], removed: [], comments: [], closed: [] },
    capacityFailAt: null,
    writeForbiddenAt: null,
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
  const query = new URLSearchParams((request.url ?? "").split("?")[1] ?? "");
  const method = request.method ?? "GET";
  const raw = await readAll(request);

  if (method === "GET" && path === "/user") {
    if (stub.ownLoginForbidden) {
      send(response, 403, { message: "Resource not accessible by integration" });
      return;
    }
    send(response, 200, { login: stub.ownLogin });
    return;
  }

  const single = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
  if (method === "GET" && single) {
    const number = Number(single[1]);
    if (stub.capacityFailAt === number) {
      send(response, 429, { message: "rate limited" });
      return;
    }
    const record = stub.threads.get(number);
    if (record === undefined) {
      send(response, 404, { message: "Not Found" });
      return;
    }
    send(response, 200, {
      number,
      title: record.title,
      body: record.body,
      labels: record.labels.map((name) => ({ name })),
      state: record.closed ? "closed" : "open",
      user: { login: record.authorLogin, type: "User" },
      milestone: record.milestone === null ? null : { title: record.milestone },
      assignees: record.assignees.map((login) => ({ login })),
      created_at: record.createdAt,
      ...(record.isPullRequest ? { pull_request: {} } : {}),
    });
    return;
  }

  if (method === "PATCH" && single) {
    const number = Number(single[1]);
    const payload = parsed(raw) as { state?: string; state_reason?: string };
    const record = stub.threads.get(number);
    if (
      record !== undefined &&
      payload.state === "closed" &&
      payload.state_reason === "not_planned"
    ) {
      record.closed = true;
      stub.effects.closed.push(number);
    }
    send(response, 200, { number });
    return;
  }

  const pull = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
  if (method === "GET" && pull) {
    const record = stub.threads.get(Number(pull[1]));
    send(response, 200, { draft: record?.draft === true });
    return;
  }

  const comments = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
  if (method === "GET" && comments) {
    const number = Number(comments[1]);
    const record = stub.threads.get(number);
    const page = Number(query.get("page") ?? "1");
    send(
      response,
      200,
      page === 1
        ? (record?.comments ?? []).map((entry) => ({
            id: entry.id,
            body: entry.body,
            user: { login: entry.login, type: entry.bot ? "Bot" : "User" },
            created_at: entry.createdAt,
          }))
        : [],
    );
    return;
  }
  if (method === "POST" && comments) {
    const number = Number(comments[1]);
    const payload = parsed(raw) as { body?: string };
    const body = payload.body ?? "";
    stub.effects.comments.push({ number, body });
    const record = stub.threads.get(number);
    if (record !== undefined) {
      record.comments.push({
        id: record.comments.length + 1,
        body,
        login: stub.ownLogin,
        bot: true,
        createdAt: new Date().toISOString(),
      });
    }
    send(response, 201, { id: 1, body });
    return;
  }

  const events = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events$/.exec(path);
  if (method === "GET" && events) {
    const number = Number(events[1]);
    const record = stub.threads.get(number);
    const page = Number(query.get("page") ?? "1");
    send(
      response,
      200,
      page === 1
        ? (record?.events ?? []).map((entry) => ({
            event: entry.event,
            label: entry.label !== undefined ? { name: entry.label } : undefined,
            actor: { login: entry.login, type: entry.bot ? "Bot" : "User" },
            created_at: entry.createdAt,
          }))
        : [],
    );
    return;
  }

  const labels = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels\/([^/]+)$/.exec(path);
  if (method === "DELETE" && labels) {
    const number = Number(labels[1]);
    const name = decodeURIComponent(labels[2] ?? "");
    stub.effects.removed.push({ number, label: name });
    const record = stub.threads.get(number);
    if (record !== undefined) record.labels = record.labels.filter((entry) => entry !== name);
    send(response, 200, {});
    return;
  }

  const labelsAdd = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/.exec(path);
  if (method === "POST" && labelsAdd) {
    const number = Number(labelsAdd[1]);
    if (stub.writeForbiddenAt === number) {
      // No rate-limit headers: a bare 403 is a permission failure, which
      // `isCapacityError` must not read as weather.
      send(response, 403, { message: "Resource not accessible by integration" });
      return;
    }
    const payload = parsed(raw) as { labels?: string[] };
    const names = payload.labels ?? [];
    for (const name of names) stub.effects.applied.push({ number, label: name });
    const record = stub.threads.get(number);
    if (record !== undefined) {
      for (const name of names) if (!record.labels.includes(name)) record.labels.push(name);
    }
    send(
      response,
      200,
      (record?.labels ?? []).map((name) => ({ name })),
    );
    return;
  }

  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
    const page = Number(query.get("page") ?? "1");
    send(
      response,
      200,
      page === 1
        ? stub.listing
            .map((number) => stub.threads.get(number))
            .filter((record): record is ThreadRecord => record !== undefined)
            .map((record, index) => ({
              number: stub.listing[index],
              title: record.title,
              body: record.body,
              labels: record.labels.map((name) => ({ name })),
              created_at: record.createdAt,
              ...(record.isPullRequest ? { pull_request: {} } : {}),
            }))
        : [],
    );
    return;
  }

  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) {
    const page = Number(query.get("page") ?? "1");
    send(
      response,
      200,
      (page === 1 ? stub.repositoryLabels : []).map((name) => ({ name, description: null })),
    );
    return;
  }

  send(response, 404, { message: `no stub for ${method} ${path}` });
}

function parsed(raw: string): unknown {
  return raw.length === 0 ? {} : JSON.parse(raw);
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

function baseInputs(warrant: string): Record<string, string> {
  return {
    "github-token": "stub-token",
    number: "42",
    warrant,
    "dry-run": "false",
    sweep: "false",
    since: "",
    limit: "30",
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
    GITHUB_EVENT_NAME: "issues",
    ...extra,
  };
  const settings = { ...baseInputs(warrantPath), ...inputs };
  for (const [name, value] of Object.entries(settings)) {
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

// ---------------------------------------------------------------------------

let stub: Stub;

beforeEach(async () => {
  stub = await startStub();
  scratch = await mkdtemp(join(tmpdir(), "reeve-lifecycle-"));
  warrantPath = join(scratch, "reeve.yml");
  await writeFile(warrantPath, WARRANT);
  stub.threads.set(42, thread());
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the action", () => {
  it("applies a due step's label and reports it on every output", async () => {
    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([{ number: 42, label: "stale" }]);
    expect(run.outputs.labeled).toBe("1");
    expect(run.outputs.reminded).toBe("false");
    expect(run.outputs.closed).toBe("false");
    expect(run.outputs.skipped).toBe("false");
  });

  it("is a green no-op naming the missing key when the warrant writes no `lifecycle:` policy", async () => {
    await writeFile(
      warrantPath,
      "version: 1\nlabels:\n  - name: bug\n    description: A defect.\n",
    );

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([]);
    expect(run.outputs.skipped).toBe("true");
    expect(run.summary).toContain("no `lifecycle:` key");
  });

  it("fails loudly when the warrant cannot be read, before spending anything", async () => {
    const run = await runAction(stub, { warrant: join(scratch, "nowhere.yml") });

    expect(run.code).toBe(1);
    expect(run.log).toContain("this run has no authority");
    expect(stub.effects.applied).toEqual([]);
  });

  it("changes nothing on a dry run, but reports the full would-do ledger", async () => {
    const run = await runAction(stub, { "dry-run": "true" });

    expect(run.code).toBe(0);
    // Nothing was actually written to the stub...
    expect(stub.effects.applied).toEqual([]);
    expect(stub.effects.comments).toEqual([]);
    expect(stub.effects.closed).toEqual([]);
    // ...but the ledger this run computed is reported in full, not the
    // pre-fix `NOTHING_DONE` early return.
    expect(run.outputs.labeled).toBe("1");
    expect(run.summary).toContain("**dry run**, nothing was applied");
    expect(run.summary).toContain("labeled `stale`");
  });

  it("never touches an already-closed thread named directly", async () => {
    stub.threads.set(42, thread({ closed: true, labels: [] }));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([]);
    expect(stub.effects.closed).toEqual([]);
    expect(run.outputs.skipped).toBe("true");
    expect(run.log + run.summary).toContain("already closed");
  });

  it(
    "the clock-hand exception: never removes a label a human hand-applied, even once it reads " +
      "as stale",
    async () => {
      // `stale` is on the thread, but the most recent `labeled` event for it
      // was raised by a human, not this run's own login — A1's attribution
      // gate. Pre-fix, `clock.ts` queued any present-but-unfired label for
      // removal with no attribution check at all.
      stub.threads.set(
        42,
        thread({
          labels: ["stale"],
          events: [
            {
              event: "labeled",
              label: "stale",
              login: "alice",
              bot: false,
              createdAt: daysAgo(30).toISOString(),
            },
          ],
        }),
      );

      const run = await runAction(stub);

      expect(run.code).toBe(0);
      expect(stub.effects.removed).toEqual([]);
      expect(run.outputs.unstaled).toBe("0");
      expect(stub.threads.get(42)?.labels).toContain("stale");
    },
  );

  it("never removes a due step's own label in the same run it (re)applies it", async () => {
    // Our own bot applied `stale` 30 days ago; a later human comment (from
    // someone other than the thread's author, so it still counts under the
    // default `resets: any`) moved the track's anchor past that firing
    // evidence, so the step reads as not-yet-fired and becomes due again —
    // the exact same-run apply-then-remove hazard A3 closes.
    stub.threads.set(
      42,
      thread({
        labels: ["stale"],
        events: [
          {
            event: "labeled",
            label: "stale",
            login: stub.ownLogin,
            bot: true,
            createdAt: daysAgo(30).toISOString(),
          },
        ],
        comments: [
          {
            id: 1,
            body: "Still relevant, please keep open.",
            login: "maintainer-bob",
            bot: false,
            createdAt: daysAgo(20).toISOString(),
          },
        ],
      }),
    );

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.removed).toEqual([]);
    expect(run.outputs.unstaled).toBe("0");
    // The step still fires — the label is (re)applied, not silently
    // dropped — it is only ever removal that the same run must not do.
    expect(stub.effects.applied).toEqual([{ number: 42, label: "stale" }]);
  });

  it("posts an unrelated track's due reminder even while another track's close is blocked", async () => {
    await writeFile(warrantPath, TWO_TRACK_WARRANT);

    // One `Date` instance, reused for both the thread's `createdAt` and the
    // fingerprint below — two separate `daysAgo(60)` calls would each read
    // `Date.now()` afresh and could round-trip to different milliseconds,
    // which would make the marker's fingerprint simply never match.
    const threadCreatedAt = daysAgo(60);
    const closingFp = markerFingerprint("closing", 0, threadCreatedAt);
    stub.threads.set(
      42,
      thread({
        createdAt: threadCreatedAt.toISOString(),
        authorLogin: "carol",
        labels: ["needs-attention"],
        comments: [
          {
            id: 1,
            body: `Still checking in.\n\n${MARKER.render(closingFp)}`,
            login: stub.ownLogin,
            bot: true,
            createdAt: daysAgo(40).toISOString(),
          },
          // From a maintainer, not the thread's author — trips
          // `exempt.comments` (which blocks only `close` steps) without
          // resetting `closing`'s own `resets: author` anchor.
          {
            id: 2,
            body: "Any update on this?",
            login: "maintainer-bob",
            bot: false,
            createdAt: daysAgo(10).toISOString(),
          },
        ],
        events: [
          {
            event: "labeled",
            label: "needs-attention",
            login: "maintainer-bob",
            bot: false,
            createdAt: daysAgo(20).toISOString(),
          },
        ],
      }),
    );

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    // `closing`'s close step is due (anchored on the marker above, 40 days
    // ago, plus a 14d step) but blocked by the human comment guard.
    expect(stub.effects.closed).toEqual([]);
    // `reminder`'s own due step is a different track entirely, and fires.
    expect(stub.effects.comments).toHaveLength(1);
    expect(run.outputs.reminded).toBe("true");
    expect(run.outputs.closed).toBe("false");
  });
});

describe("the sweep", () => {
  beforeEach(() => {
    stub.threads.delete(42);
  });

  it("filters a `threads:` kind mismatch out of the listing for free — it never consumes `limit`", async () => {
    // Five pull requests (kind-mismatched under the default `threads:
    // issues`), older than the two real, due issues — so the sweep's
    // oldest-first walk meets every mismatched thread first. Pre-fix, every
    // examined thread — including the exempt ones — consumed `limit`, so a
    // sweep whose oldest backlog happened to be mismatched threads could
    // starve the real candidates behind them forever, never reaching them at
    // all.
    for (let index = 0; index < 5; index += 1) {
      const number = 600 + index;
      stub.threads.set(
        number,
        thread({ isPullRequest: true, createdAt: daysAgo(100 + index).toISOString() }),
      );
      stub.listing.push(number);
    }
    stub.threads.set(701, thread({ createdAt: daysAgo(50).toISOString() }));
    stub.threads.set(702, thread({ createdAt: daysAgo(40).toISOString() }));
    stub.listing.push(701, 702);

    const run = await runAction(stub, { sweep: "true", number: "", limit: "2" });

    expect(run.code).toBe(0);
    expect(run.outputs.processed).toBe("2");
    expect(run.outputs.skipped).toBe("5");
    expect(run.outputs.remaining).toBe("0");
    expect(stub.effects.applied.map((entry) => entry.number).sort()).toEqual([701, 702]);
  });

  it("sweeps only pull requests under `threads: prs`, leaving every issue alone", async () => {
    await writeFile(warrantPath, PRS_ONLY_WARRANT);

    stub.threads.set(801, thread({ isPullRequest: false, createdAt: daysAgo(90).toISOString() }));
    stub.threads.set(802, thread({ isPullRequest: true, createdAt: daysAgo(80).toISOString() }));
    stub.listing.push(801, 802);

    const run = await runAction(stub, { sweep: "true", number: "" });

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([{ number: 802, label: "stale" }]);
    expect(run.outputs.skipped).toBe("1");
  });

  it(
    "stops mid-sweep on a capacity error, keeps what it already did, and reports a starved, " +
      "still-green run",
    async () => {
      stub.threads.set(901, thread({ createdAt: daysAgo(90).toISOString() }));
      stub.threads.set(902, thread({ createdAt: daysAgo(80).toISOString() }));
      stub.threads.set(903, thread({ createdAt: daysAgo(70).toISOString() }));
      stub.listing.push(901, 902, 903);
      // Oldest-first, so 901 succeeds before this one stops the sweep — 903
      // is never even attempted.
      stub.capacityFailAt = 902;

      const run = await runAction(stub, { sweep: "true", number: "" });

      // D12: capacity is weather, not a broken configuration — still green.
      expect(run.code).toBe(0);
      expect(run.outputs.starved).toBe("true");
      expect(run.outputs.processed).toBe("1");
      expect(stub.effects.applied).toEqual([{ number: 901, label: "stale" }]);
      expect(run.summary).toContain("Stopped early");
    },
  );

  it("goes red on a permission failure mid-sweep, and still reports the threads it had already done", async () => {
    // D12's other side, and the accumulator's whole reason for being mutated
    // in place (`sweep.ts`: "a value returned only on success cannot be read by
    // a caller that never got the return"). A bare 403 is configuration, not
    // weather, so the walk does not stop politely — it throws. What must
    // survive the throw is the work already committed to the forge and the
    // run's own account of it: a red job that reported zero would tell a
    // maintainer nothing about the thread it had already labelled.
    stub.threads.set(911, thread({ createdAt: daysAgo(90).toISOString() }));
    stub.threads.set(912, thread({ createdAt: daysAgo(80).toISOString() }));
    stub.threads.set(913, thread({ createdAt: daysAgo(70).toISOString() }));
    stub.listing.push(911, 912, 913);
    stub.writeForbiddenAt = 912;

    const run = await runAction(stub, { sweep: "true", number: "" });

    expect(run.code).not.toBe(0);
    // The first thread's label stands — nothing rolls a committed write back.
    expect(stub.effects.applied).toEqual([{ number: 911, label: "stale" }]);
    // And the run says so, on the outputs and on the page, rather than
    // reporting an empty sweep.
    expect(run.outputs.processed).toBe("1");
    expect(run.outputs.labeled).toBe("1");
    expect(run.summary).toContain("#911");
    expect(run.log).toContain("Resource not accessible by integration");
  });

  it("works the backlog oldest-first however the listing hands it over", async () => {
    // The listing's order is GitHub's business and it is not the sweep's: a
    // clock check wants the thread that has waited longest first, so the walk
    // sorts by creation date rather than trusting the order it was handed. A
    // listing served newest-first must therefore produce exactly the same
    // work, in exactly the same order, as one served oldest-first.
    stub.threads.set(921, thread({ createdAt: daysAgo(90).toISOString() }));
    stub.threads.set(922, thread({ createdAt: daysAgo(60).toISOString() }));
    stub.threads.set(923, thread({ createdAt: daysAgo(30).toISOString() }));
    // Newest first — the reverse of the order the walk has to work in.
    stub.listing.push(923, 922, 921);

    const run = await runAction(stub, { sweep: "true", number: "" });

    expect(run.code).toBe(0);
    expect(run.outputs.processed).toBe("3");
    expect(stub.effects.applied).toEqual([
      { number: 921, label: "stale" },
      { number: 922, label: "stale" },
      { number: 923, label: "stale" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Two guards that nothing observed, both confirmed by mutation to be
// unobserved: the whole-step capability check, and the recursion guard.
// ---------------------------------------------------------------------------

/** A body carrying `propose`'s marker — what Reeve's own proposal PR looks like. */
function proposalBody(): string {
  return `A proposal.\n\n${markerFor("propose").render(fingerprint("proposal", ["lifecycle"]))}`;
}

describe("the whole-step capability gate", () => {
  /**
   * `checkRequired` (`main.ts:308`) is the only thing standing between a
   * warrant that grants nothing and a track that labels, comments and closes.
   * An auditor forced it to report no missing capability and the entire
   * repository stayed green — every lifecycle step was ungated and nothing
   * anywhere noticed. Each case below asserts by what reached the stub, so a
   * gate turned into a constant has to fail one of them.
   */
  const WITHOUT = (granted: string): string =>
    WARRANT.replace("  lifecycle: [label, comment, close]", `  lifecycle: ${granted}`);

  it("applies no label when `label` is not granted", async () => {
    await writeFile(warrantPath, WITHOUT("[comment, close]"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([]);
  });

  it("closes nothing when `close` is not granted", async () => {
    // The second step of the fixture's track closes. A run that reached it
    // without the capability would end somebody's thread on a grant nobody
    // wrote.
    stub.threads.set(42, thread({ labels: ["stale"], createdAt: daysAgo(90).toISOString() }));
    await writeFile(warrantPath, WITHOUT("[label, comment]"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.closed).toEqual([]);
  });

  it("writes nothing at all when the warrant grants the duty nothing", async () => {
    await writeFile(warrantPath, WITHOUT("[none]"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([]);
    expect(stub.effects.comments).toEqual([]);
    expect(stub.effects.closed).toEqual([]);
  });

  it("says which capability is missing rather than failing silently", async () => {
    // A step that cannot run is a configuration problem a maintainer has to
    // be able to find. Silence would read as "nothing was due".
    await writeFile(warrantPath, WITHOUT("[comment, close]"));

    const run = await runAction(stub);

    expect(run.log + run.summary).toContain("label");
  });
});

describe("the Reeve-proposal recursion guard", () => {
  /**
   * Reeve acting on its own proposal pull request is the infinite-loop failure
   * mode: a run labels its own PR, which is a change, which wakes the next
   * run. `isReeveProposalPr` is the guard, and an auditor replaced it with
   * `false` in three duties at once with the whole suite still green.
   */
  it("touches nothing on Reeve's own proposal pull request", async () => {
    // `threads: prs`, deliberately. Under the default warrant a pull request
    // is skipped because it is a pull request, so these cases would pass
    // whatever the guard did — the last case in this block is what proves
    // this fixture actually reaches a PR at all.
    await writeFile(warrantPath, PRS_ONLY_WARRANT);
    stub.threads.set(
      42,
      thread({ isPullRequest: true, body: proposalBody(), createdAt: daysAgo(90).toISOString() }),
    );

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([]);
    expect(stub.effects.comments).toEqual([]);
    expect(stub.effects.closed).toEqual([]);
  });

  it("names the reason rather than reporting an ordinary skip", async () => {
    await writeFile(warrantPath, PRS_ONLY_WARRANT);
    stub.threads.set(
      42,
      thread({ isPullRequest: true, body: proposalBody(), createdAt: daysAgo(90).toISOString() }),
    );

    const run = await runAction(stub);

    expect(run.log + run.summary).toContain("own proposal pull request");
  });

  it("still acts on an ordinary pull request that carries no proposal marker", async () => {
    // The other half, and the control for the two above: the guard must
    // recognise its OWN pull request, not stand down on every one. Without
    // this, a guard that always refused — or a fixture that never reached a
    // pull request at all — would pass both cases above.
    await writeFile(warrantPath, PRS_ONLY_WARRANT);
    stub.threads.set(
      42,
      thread({
        isPullRequest: true,
        body: "An ordinary PR.",
        createdAt: daysAgo(90).toISOString(),
      }),
    );

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([{ number: 42, label: "stale" }]);
  });
});

// ---------------------------------------------------------------------------
// The `label` gate on the un-staling path (`main.ts:370`).
//
// Every existing case in this file asserts `unstaled === "0"` — none has ever
// observed a removal actually happening. So the gate around it was
// unobservable rather than unasserted: an auditor forced it open and the whole
// repository stayed green, because no fixture ever reached the loop it guards.
//
// The clock-hand exception is the narrowest write this duty has — the one
// place Reeve removes a label at all — and D3 makes it narrow on purpose: only
// a label this run's own actor applied, only in the direction of un-staling.
// A removal performed without the `label` grant would be a write outside the
// warrant on the single path where a write is hardest to justify.
// ---------------------------------------------------------------------------

describe("the `label` gate on un-staling", () => {
  /**
   * A track whose `when:` label is absent, so it has no anchor to run from —
   * `trackStart` returns null (`clock.ts:109`) and the whole track's labels are
   * collected for un-staling. That is the un-stale path with the fewest moving
   * parts: the step never fires, and the leftover label is ours to clean up.
   */
  const WHEN_WARRANT = [
    "version: 1",
    "labels:",
    "  - name: bug",
    "    description: A defect.",
    "lifecycle:",
    "  tracks:",
    "    - name: stale",
    "      when: needs-attention",
    "      steps:",
    "        - label: stale",
    "          after: 14d",
    "duties:",
    "  lifecycle: [label, comment, close]",
  ].join("\n");

  /** A thread carrying a `stale` this run's own actor applied, on a track with no anchor. */
  async function ownStaleWithoutAnchor(): Promise<void> {
    await writeFile(warrantPath, WHEN_WARRANT);
    stub.threads.set(
      42,
      thread({
        // No `needs-attention`, so the track never started; `stale` is a
        // leftover from a run when it had.
        labels: ["stale"],
        events: [
          {
            event: "labeled",
            label: "stale",
            login: stub.ownLogin,
            bot: true,
            createdAt: daysAgo(30).toISOString(),
          },
        ],
      }),
    );
  }

  it("removes the label this run's own actor left behind, when `label` is granted", async () => {
    // The case that makes the gate observable at all. Without it every
    // assertion below passes against a duty that simply never removes
    // anything — which is exactly the state this file was in.
    await ownStaleWithoutAnchor();

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.removed).toEqual([{ number: 42, label: "stale" }]);
    expect(run.outputs.unstaled).toBe("1");
  });

  it("removes nothing when `label` is withheld", async () => {
    await ownStaleWithoutAnchor();
    await writeFile(
      warrantPath,
      WHEN_WARRANT.replace("lifecycle: [label, comment, close]", "lifecycle: [comment, close]"),
    );

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.removed).toEqual([]);
    expect(run.outputs.unstaled).toBe("0");
  });

  it("says how many labels it left standing rather than removing them silently", async () => {
    await ownStaleWithoutAnchor();
    await writeFile(
      warrantPath,
      WHEN_WARRANT.replace("lifecycle: [label, comment, close]", "lifecycle: [comment, close]"),
    );

    const run = await runAction(stub);

    expect(run.log + run.summary).toContain("`label` is withheld");
  });

  it("removes nothing on a dry run, but still reports what it would have removed", async () => {
    await ownStaleWithoutAnchor();

    const run = await runAction(stub, { "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(stub.effects.removed).toEqual([]);
    expect(run.outputs.unstaled).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// A token that cannot answer `GET /user`.
//
// `GITHUB_TOKEN` is a GitHub App installation token, and `GET /user` answers
// 403 "Resource not accessible by integration" for every one of those — so
// this is the path EVERY consumer takes unless they configured a personal
// access token. The un-caught 403 failed the run before it reached its first
// thread; catching it alone would have been worse, because `isOwnActor`
// refuses to match an unknown identity, so no marker this duty posted would
// ever be recognised as its own and every talking step would be re-posted on
// every run. These cases pin the third answer: the run completes, computes
// its whole ledger, and writes nothing.
// ---------------------------------------------------------------------------

describe("a token that cannot answer `GET /user`", () => {
  const WHEN_WARRANT = [
    "version: 1",
    "labels:",
    "  - name: bug",
    "    description: A defect.",
    "lifecycle:",
    "  tracks:",
    "    - name: stale",
    "      when: needs-attention",
    "      steps:",
    "        - label: stale",
    "          after: 14d",
    "duties:",
    "  lifecycle: [label, comment, close]",
  ].join("\n");

  beforeEach(() => {
    stub.ownLoginForbidden = true;
  });

  it("completes the run instead of dying on the 403", async () => {
    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.log).not.toContain("Resource not accessible by integration");
  });

  it("still computes the full ledger — the pipeline runs, only the writes are withheld", async () => {
    const run = await runAction(stub);

    expect(run.outputs.labeled).toBe("1");
    expect(run.summary).toContain("labeled `stale`");
  });

  it("writes nothing at all to the thread", async () => {
    // The same thread the first case in this file labels for real. Without an
    // identity there is no attribution, and a duty that cannot attribute what
    // it already did must not do more.
    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.applied).toEqual([]);
    expect(stub.effects.comments).toEqual([]);
    expect(stub.effects.closed).toEqual([]);
  });

  it("says why it withheld them, rather than reading as a quiet no-op", async () => {
    const run = await runAction(stub);

    expect(run.log).toContain("cannot name itself");
  });

  it("removes no clock-hand label either, even one a bot plainly left behind", async () => {
    // The thread the `label` gate suite un-stales with a resolved identity.
    // With none, `isOwnActor` refuses the match and the observe-only fallback
    // would refuse the write in any case — belt and braces, deliberately.
    await writeFile(warrantPath, WHEN_WARRANT);
    stub.threads.set(
      42,
      thread({
        labels: ["stale"],
        events: [
          {
            event: "labeled",
            label: "stale",
            login: stub.ownLogin,
            bot: true,
            createdAt: daysAgo(30).toISOString(),
          },
        ],
      }),
    );

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.removed).toEqual([]);
    expect(run.outputs.unstaled).toBe("0");
  });
});
