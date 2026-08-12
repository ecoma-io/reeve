/**
 * The translate duty, driven the way a runner drives it.
 *
 * Its entry point calls `run()` at import, so it cannot be imported and measured —
 * importing it would run it. What a runner actually does is spawn
 * `translate/dist/index.js` with `INPUT_*` in the environment and read
 * `GITHUB_OUTPUT` afterwards, and that is exactly what happens below. It is the only place the
 * wiring is exercised at all: the modules underneath each have their own tests,
 * and none of them can catch an input read under the wrong name or an output
 * that never got written.
 *
 * Two collaborators are real and one is not. The bundle is real, rebuilt here so
 * a case can never pass against a stale artifact. GitHub and the provider are a
 * local HTTP server — `@actions/github` reads its base URL from `GITHUB_API_URL`
 * and `base-url` is an input, so both point at it and nothing in this file
 * reaches a network or a model.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { marker } from "./publish.js";

// A spawn per case, each loading a 3 MB bundle and identifying a language from
// bundled profile data. Comfortably under this, and not worth flaking over.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Where this duty is published from: a repository subdirectory of its own. */
const DUTY = join(ROOT, "translate");
const BUNDLE = join(DUTY, "dist", "index.js");

/** Long enough, and diacritical enough, to be identified without a model. */
const VIETNAMESE =
  "Nút chuyển chế độ tối không lưu lại sau khi tải lại trang, tôi nghĩ nó nên được ghi vào bộ nhớ cục bộ.";
const ENGLISH =
  "The dark mode toggle does not persist after a page reload; I think it should be written to local storage.";
/** Han script throughout, so the cases below can tell it from the other two. */
const CHINESE = "深色模式切换在页面重新加载后不会保留，我认为应该将其写入本地存储。";

const STRUCTURED = [
  VIETNAMESE,
  "",
  "```sh",
  "pnpm build",
  "```",
  "",
  "Chi tiết: https://example.com/docs.",
].join("\n");
const STRUCTURED_ENGLISH = [
  ENGLISH,
  "",
  "```sh",
  "pnpm build",
  "```",
  "",
  "Details: https://example.com/docs.",
].join("\n");

/**
 * A warrant in the shape a maintainer writes one, granting `translate`
 * exactly `edit-body` and nothing else — the same capability the implicit
 * warrant hands it by default, so a case not otherwise concerned with the
 * warrant sees the same behaviour whichever of the two it ran under.
 */
const WARRANT = ["version: 1", "capabilities:", "  translate: [edit-body]"].join("\n");

beforeAll(async () => {
  // Built rather than assumed: CI runs `pnpm test` before `pnpm build`, so a
  // case driving the committed bundle would be driving whatever was committed
  // last rather than the source under review.
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs")], { cwd: ROOT });
}, 120_000);

// ---------------------------------------------------------------------------
// The stub standing in for GitHub and for the provider.
// ---------------------------------------------------------------------------

/** One chat completion request, as the stub saw it. */
interface Ask {
  readonly model: string;
  readonly system: string;
  /**
   * The text being translated. Carried because a run with replies turned on
   * makes several requests for the same target language, and only this tells
   * them apart — a case that scripted an answer per language alone would answer
   * the body's request with the reply's translation and pass anyway.
   */
  readonly user: string;
  readonly authorization: string | null;
}

interface Answer {
  readonly status: number;
  readonly payload: unknown;
}

/** One entry in a sweep's open-thread listing, as the stub returns it. */
interface ListedIssue {
  readonly number: number;
  readonly body: string;
  readonly createdAt: string;
  /** Present, and true, only for the entries a sweep must still translate as a pull request. */
  readonly pullRequest?: boolean;
}

/** Everything a request is answered from, and everything a case may change. */
interface State {
  /**
   * The body of thread #42, read and written exactly as GitHub's would be.
   *
   * One mutable field rather than a fixture and a record of writes, because the
   * behaviour being driven here is a run reading back what the previous run
   * wrote. A stub that answered `GET` from something the `PATCH` had not
   * touched could not tell a loop that terminates from one that does not.
   *
   * Kept as the one field every single-thread case already reaches for —
   * `bodies` below is the general form a sweep needs, keyed by number, and #42
   * is deliberately excluded from it so nothing here has to change.
   */
  body: string;
  /**
   * Every other thread's current body, by number — what a sweep's own re-read
   * inside `publish()` answers with. Seeded from `issues` below, and updated by
   * a `PATCH` the same way `body` is.
   */
  readonly bodies: Map<number, string>;
  /**
   * The open backlog a sweep lists, newest first — the order this suite has to
   * hand it in, since the stub serves it back verbatim rather than sorting it.
   * Empty for every case outside `describe("the sweep", ...)`.
   */
  issues: ListedIssue[];
  /**
   * How many times the listing endpoint was asked, counted so a case can
   * assert it never was — `bodies` cannot answer that, because only a `PATCH`
   * writes it and a sweep that listed without writing would leave it empty.
   */
  listings: number;
  /**
   * The replies, by id, read and written the way GitHub's comment endpoints do.
   *
   * A map rather than a list because the write is addressed by id: a run that
   * translated the third reply into the second one's body would still pass a
   * list-shaped assertion that only counted how many changed.
   */
  readonly replies: Map<number, string>;
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
      // Reported the way an OpenAI-compatible provider reports it, so the run
      // summary is driven by a real response shape rather than by a fixture.
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
  };
}

/**
 * An endpoint that translates into the languages it was given text for, and is
 * out of quota for every other one.
 *
 * Keyed on the target code as the translation prompt spells it — `into English
 * (en)`. Detection's prompt writes a code the other way round (`en (English)`),
 * so a run that reached the model to detect a language falls through to the
 * quota answer and the case says so instead of quietly passing.
 */
function translating(into: Record<string, string>): (ask: Ask) => Answer {
  return (ask) => {
    for (const [code, text] of Object.entries(into)) {
      if (ask.system.includes(`(${code})`)) return saying(text);
    }
    return { status: 429, payload: { error: { message: `no quota for ${ask.model}` } } };
  };
}

/**
 * An endpoint keyed on the text it was sent rather than on the target language.
 *
 * What `translating` cannot express once replies are on: a run translates the
 * body and three replies into the same language, so an answer chosen by target
 * alone would put the reply's translation in the body and the case would still
 * pass. Each entry matches on a distinctive fragment of the source.
 */
function answering(pairs: [source: string, answer: string][]): (ask: Ask) => Answer {
  return (ask) => {
    for (const [source, answer] of pairs) {
      if (ask.user.includes(source)) return saying(answer);
    }
    return { status: 429, payload: { error: { message: `nothing scripted for ${ask.model}` } } };
  };
}

async function startStub(): Promise<Stub> {
  // The state is created before the server so the handler can close over it,
  // and the port and the shutdown are folded onto that same object afterwards —
  // a case sets `stub.body` and the next request reads it.
  const state: State = {
    body: "",
    bodies: new Map(),
    issues: [],
    listings: 0,
    replies: new Map(),
    answer: translating({}),
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
  const query = new URLSearchParams((request.url ?? "").split("?")[1] ?? "");
  const method = request.method ?? "GET";
  const raw = await readAll(request);

  const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
  if (method === "GET" && issue) {
    const number = Number(issue[1]);
    const listed = stub.issues.find((entry) => entry.number === number);
    // A number a sweep's own listing named keeps its own body, seeded from that
    // listing and then from whatever it was last `PATCH`ed to — which is what a
    // sweep's later re-read inside `publish()` has to see, to avoid mistaking
    // the author's own text for something it just wrote. Every other number,
    // which is every single-thread case in the suite above, reads and writes
    // the one `stub.body` field it always has, whatever number it happens to be
    // driving this thread as.
    const body = listed === undefined ? stub.body : (stub.bodies.get(number) ?? listed.body);
    send(response, 200, { number, body });
    return;
  }
  if (method === "PATCH" && issue) {
    const number = Number(issue[1]);
    const written = bodyOf(raw);
    if (stub.issues.some((entry) => entry.number === number)) stub.bodies.set(number, written);
    else stub.body = written;
    send(response, 200, { number, body: written });
    return;
  }

  // This duty has no taxonomy of its own, so the only reason it ever asks for
  // the repository's labels at all is to build the implicit warrant when no
  // file exists — and that warrant's `granted` hands back this duty's own
  // default regardless of what the labels say, so an empty list is the whole
  // stub this suite ever needs here.
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) {
    send(response, 200, []);
    return;
  }

  // A sweep's listing. `page` is honoured so a case could exercise pagination
  // directly, but every case in this suite fits on page one — pagination and
  // the `since` cutoff are exercised in isolation, against `listOpenThreads`
  // itself, in `forge.test.ts`.
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
    stub.listings += 1;
    const page = Number(query.get("page") ?? "1");
    send(
      response,
      200,
      page === 1
        ? stub.issues.map((entry) => ({
            number: entry.number,
            title: "",
            body: entry.body,
            labels: [],
            created_at: entry.createdAt,
            ...(entry.pullRequest === true ? { pull_request: {} } : {}),
          }))
        : [],
    );
    return;
  }

  // Listed newest last, which is GitHub's own order and the one a reader sees.
  const comments = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(path);
  if (method === "GET" && comments) {
    send(
      response,
      200,
      [...stub.replies].map(([id, body]) => ({ id, body })),
    );
    return;
  }

  const comment = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
  if (method === "PATCH" && comment) {
    const id = Number(comment[1]);
    stub.replies.set(id, bodyOf(raw));
    send(response, 200, { id, body: stub.replies.get(id) });
    return;
  }
  // `publish`'s re-read-after-write, for a reply: `createReply`'s second
  // `read()` goes back here rather than answering from the listing it started
  // from — see `core/forge.ts`.
  if (method === "GET" && comment) {
    const id = Number(comment[1]);
    send(response, 200, { id, body: stub.replies.get(id) ?? "" });
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
  const parsed: unknown = JSON.parse(raw);
  const payload = parsed as { model?: unknown; messages?: { role?: string; content?: string }[] };
  const system = payload.messages?.find((message) => message.role === "system")?.content;
  const user = payload.messages?.find((message) => message.role === "user")?.content;
  return { model: String(payload.model), system: system ?? "", user: user ?? "", authorization };
}

function bodyOf(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  const payload = parsed as { body?: unknown };
  return typeof payload.body === "string" ? payload.body : "";
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
  /** Both streams, in one string: workflow commands go to stdout, and a crash
   *  that never reached `setFailed` goes to stderr. A case asserting the run
   *  said something should not have to know which. */
  readonly log: string;
  readonly outputs: Record<string, string>;
  /** The job summary page, as the runner would render it. */
  readonly summary: string;
}

/**
 * One consumer's settings — deliberately not a copy of `action.yml`'s defaults,
 * which the runner supplies and this file never sees. A case names only what it
 * changes.
 */
function baseInputs(stub: Stub, warrant: string): Record<string, string> {
  return {
    "github-token": "stub-token",
    number: "42",
    "base-url": `${stub.url}/v1`,
    "api-key": "sk-stub-key",
    models: "stub-model",
    // The short form, so this suite drives the derivation too: the labels and
    // the scripts below are read off the runtime's own CLDR data inside the
    // bundle, which is the only place the built artifact's ICU is exercised.
    languages: "en, vi",
    warrant,
    apply: "edit-body",
    drafts: "1",
    "judge-models": "",
    "max-body-chars": "6000",
    "chunk-chars": "6000",
    "translate-replies": "false",
    "max-replies": "100",
    "show-attribution": "none",
    "dry-run": "false",
    sweep: "false",
    since: "",
    limit: "50",
    endpoints: "",
    "api-keys": "",
    "request-timeout": "120s",
    temperature: "",
    "max-requests": "none",
  };
}

/** The warrant a case runs against, written where the run can read it. */
let scratch: string;
let warrantPath: string;

/**
 * `cwd` defaults to this repository's own root, where the default warrant
 * path resolves to the real `.github/reeve.yml` sitting there. A case about
 * the *absence* of that file needs a working directory with no such file in
 * it, which is what the `scratch` directory this suite already makes per
 * case is for.
 */
async function runAction(
  stub: Stub,
  inputs: Record<string, string> = {},
  extra: NodeJS.ProcessEnv = {},
  cwd: string = ROOT,
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
  for (const [name, value] of Object.entries({ ...baseInputs(stub, warrantPath), ...inputs })) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }

  const child = spawn(process.execPath, [BUNDLE], {
    cwd,
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

/**
 * `GITHUB_OUTPUT` as the runner reads it back.
 *
 * `@actions/core` writes each output heredoc-style, `name<<delimiter`, so a
 * value containing newlines survives. Parsed rather than asserted as raw text,
 * because the delimiter carries a fresh uuid per line.
 */
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
  stub.body = VIETNAMESE;
  stub.answer = translating({ en: ENGLISH });
  scratch = await mkdtemp(join(tmpdir(), "reeve-translate-"));
  warrantPath = join(scratch, "reeve.yml");
  await writeFile(warrantPath, WARRANT);
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the action", () => {
  it("appends the translation to the body of a thread it has not translated", async () => {
    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.body.startsWith(VIETNAMESE)).toBe(true);
    expect(stub.body).toContain(ENGLISH);
    expect(stub.body).toContain("<summary><b>English</b></summary>");
    expect(stub.body).toContain("Translated from Tiếng Việt.");
  });

  it("names no model in a body by default, so the block stays short", async () => {
    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.body).not.toContain("stub-model");
  });

  it("names the model that translated once the workflow asks for it", async () => {
    const run = await runAction(stub, { "show-attribution": "model" });

    expect(run.code).toBe(0);
    expect(stub.body).toContain("<summary><b>English</b> · <code>stub-model</code></summary>");
  });

  it("shows the name a workflow gave a model, and never the id it was given for", async () => {
    // The point of naming a model is that the id is a maintainer's to keep: a
    // block that printed both would publish the secret next to the cover for it.
    const run = await runAction(stub, {
      models: "stub-model = House model",
      "show-attribution": "model",
    });

    expect(run.code).toBe(0);
    expect(stub.body).toContain("<summary><b>English</b> · <code>House model</code></summary>");
    expect(stub.body).not.toContain("stub-model");
  });

  it("says how the draft won once the workflow asks for the detail", async () => {
    // Three drafts, so there is a contest to report: the whole point of
    // `detail` is the part a single uncontested draft has nothing to say about.
    // Which ranking settles it is left open — the stub answers every draft the
    // same way, so scoring alone can decide it and never reach a judge.
    const run = await runAction(stub, { "show-attribution": "detail", drafts: "3" });

    expect(run.code).toBe(0);
    expect(stub.body).toContain("Translated by `stub-model`.");
    expect(stub.body).toMatch(/Scored \d\.\d\d of 1\.00, best of 3 drafts, decided by \w+\./);
  });

  it("names a judge seat by the name it was given, whichever model filled it", async () => {
    // The seat is the voter, so the fallback model that actually answered votes
    // as `Referee` — and the ids of both stay out of the thread.
    const votes = (ask: Ask): Answer =>
      ask.system.includes("choosing the best") ? saying("1") : translating({ en: ENGLISH })(ask);
    stub.answer = (ask) => (ask.model === "judge-a" ? { status: 429, payload: {} } : votes(ask));

    const run = await runAction(stub, {
      models: "stub-model = House model",
      drafts: "2",
      "judge-models": "judge-a | judge-b = Referee",
      "show-attribution": "detail",
    });

    expect(run.code).toBe(0);
    expect(stub.body).toContain("Votes: `Referee`→`House model`.");
    expect(stub.body).not.toContain("judge-a");
    expect(stub.body).not.toContain("judge-b");
  });

  it("reports the run on the job summary page, where the thread stays clean", async () => {
    // Everything a maintainer wants and no contributor does: which language got
    // what, from which model, and what the whole thing cost. The body itself is
    // left with the default `show-attribution: none`.
    const run = await runAction(stub, { models: "stub-model = House model" });

    expect(run.code).toBe(0);
    expect(run.summary).toContain("## Reeve · translate");
    expect(run.summary).toContain("Thread #42");
    expect(run.summary).toContain("| #42 | English (en) | translated | House model |");
    expect(run.summary).toContain("| Drafting | House model | 1 | — | 100 | 20 | 120 |");
    expect(run.summary).toContain("| **Total** |");
    expect(stub.body).not.toContain("House model");
  });

  it("reports what a language cost even when no model would translate it", async () => {
    // The run that most needs a bill is the one that produced nothing.
    stub.answer = () => ({ status: 429, payload: { error: { message: "out of quota" } } });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.summary).toContain("**no draft**");
    expect(run.summary).toContain("unusable and rotated past");
  });

  it("rotates through the whole roster before starving, and reports it on the output", async () => {
    // D12: capacity is weather. A run that ran the roster dry still publishes
    // whatever it drafted (nothing, here) rather than failing red, and
    // `starved` is how a workflow tells that run from an ordinary one.
    stub.answer = () => ({ status: 429, payload: { error: { message: "out of quota" } } });

    const run = await runAction(stub, { models: "stub-model-a, stub-model-b" });

    expect(run.code).toBe(0);
    expect(stub.asked.map((ask) => ask.model)).toEqual(["stub-model-a", "stub-model-b"]);
    expect(run.outputs.starved).toBe("true");
    expect(run.log).toContain(
      "This run delivered what it could rather than failing red — weather, not a broken " +
        "configuration.",
    );
  });

  it("fails red the instant a model reports an authentication problem, asking no other", async () => {
    // D12's other half: an auth failure is a broken configuration, not
    // weather, so it stops the run immediately — rotating to `stub-model-b`
    // would spend a call proving nothing, since the same key is wrong for both.
    stub.answer = () => ({ status: 401, payload: { error: { message: "invalid api key" } } });

    const run = await runAction(stub, { models: "stub-model-a, stub-model-b" });

    expect(run.code).not.toBe(0);
    expect(stub.asked).toHaveLength(1);
    expect(stub.body).toBe(VIETNAMESE);
    expect(run.log).toContain("stub-model-a: HTTP 401: invalid api key");
  });

  it("keeps the author's own text as the official half, byte-for-byte", async () => {
    // The reason the translation is appended rather than written over: a body
    // GitHub reads `Fixes #1` and a task list out of has to keep working, and
    // the author is answerable for those words rather than for a model's.
    stub.body = `${VIETNAMESE}\n\nFixes #1\n\n- [x] xong`;
    const author = stub.body;

    await runAction(stub);

    expect(stub.body.startsWith(author)).toBe(true);
    expect(marker.split(stub.body).official).toBe(author);
    expect(stub.body).toContain("the version this project answers for");
  });

  it("does not translate the thread into the language it is already written in", async () => {
    const run = await runAction(stub);

    expect(run.outputs.translated).toBe(JSON.stringify(["en"]));
    expect(stub.body).not.toContain("Tiếng Việt</b>");
  });

  it("reports what it did on every output, so a workflow can branch on it", async () => {
    const run = await runAction(stub);

    expect(run.outputs).toEqual({
      "source-language": "vi",
      translated: JSON.stringify(["en"]),
      skipped: JSON.stringify([]),
      "replies-translated": "0",
      starved: "false",
      "budget-exhausted": "false",
      processed: "0",
      remaining: "0",
    });
  });

  it("identifies the source language without contacting a provider to do it", async () => {
    // Script narrowing and the local profile decide, so the only request a
    // one-language run makes is the translation itself. This is the whole
    // reason detection is a ladder, and it is invisible from inside any one
    // module.
    await runAction(stub);

    expect(stub.asked).toHaveLength(1);
    expect(stub.asked[0]?.system).toContain("into English (en)");
  });

  it("sends the api key as a bearer token to the configured endpoint", async () => {
    await runAction(stub);

    expect(stub.asked[0]?.authorization).toBe("Bearer sk-stub-key");
  });

  it("registers the api key for masking before anything can log it", async () => {
    const run = await runAction(stub);

    expect(run.log).toContain("::add-mask::sk-stub-key");
  });

  it("replaces the block it already owns rather than appending a second one", async () => {
    await runAction(stub);
    stub.body = stub.body.replace(VIETNAMESE, `${VIETNAMESE} Thêm một câu.`);
    stub.answer = translating({ en: `${ENGLISH} Edited.` });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.body).toContain("Edited.");
    expect(stub.body.split("reeve:translate")).toHaveLength(2);
  });

  it("spends nothing at all on a rerun of a thread it already translated", async () => {
    // The loop this change creates and the guard that closes it. Writing the
    // body fires `issues: edited`, which the workflow listens for, and the run
    // that event starts must recognise its own output — before it constructs a
    // provider, or an edit-triggered rerun would re-spend the whole budget on
    // every thread in the repository. GitHub declines to start a workflow from
    // its own `GITHUB_TOKEN`, but a PAT and an App installation get no such
    // protection, so termination cannot rest on which token a consumer chose.
    await runAction(stub);
    const written = stub.body;
    stub.asked.length = 0;

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.body).toBe(written);
    expect(stub.asked).toHaveLength(0);
    expect(run.log).toContain("already carries the translation");
  });

  it("translates again once the author edits the text the block was written for", async () => {
    // The other half of the same guard: it must recognise its own output
    // without also refusing to notice that the text no longer means what the
    // published translation says it means.
    await runAction(stub);
    stub.body = stub.body.replace(VIETNAMESE, `${VIETNAMESE} Thêm một câu nữa.`);
    stub.asked.length = 0;
    stub.answer = translating({ en: `${ENGLISH} One more sentence.` });

    await runAction(stub);

    expect(stub.asked).not.toHaveLength(0);
    expect(stub.body).toContain("One more sentence.");
  });

  it("carries a code block and a URL across untouched", async () => {
    stub.body = STRUCTURED;
    stub.answer = translating({ en: STRUCTURED_ENGLISH });

    await runAction(stub);

    expect(stub.body).toContain("```sh\npnpm build\n```");
    expect(stub.body).toContain("https://example.com/docs");
  });

  it("skips the language nothing could translate and still publishes the one that worked", async () => {
    // The failure Reeve is most likely to meet in the wild: a free tier
    // with enough quota for one request and not two. The Chinese translation
    // being unavailable must not cost the thread the English one.
    stub.answer = translating({ en: ENGLISH });

    const run = await runAction(stub, { languages: "en, zh, vi" });

    expect(run.code).toBe(0);
    expect(run.outputs.translated).toBe(JSON.stringify(["en"]));
    expect(run.outputs.skipped).toBe(JSON.stringify(["zh"]));
    expect(stub.body).toContain(ENGLISH);
    expect(stub.body).toContain("Not translated this run: 中文.");
    // A warning rather than an info line: a green run that quietly did less
    // than it was asked to is exactly what has to be visible from the run
    // summary, without opening the log. The provider's own reason goes with it,
    // because the published block deliberately does not carry it.
    expect(run.log).toContain("::warning::#42 zh: no model produced a translation this run.");
    expect(run.log).toContain("HTTP 429");
  });

  it("retries next run the language a provider could not translate this one", async () => {
    // The marker has to record what the run *got*, not what it was configured
    // for. Recording the configured set makes the skip permanent: a language
    // lost to a one-off 429 is claimed as translated, the next run matches its
    // own claim and stops, and the thread never gets it — from a green run,
    // with a warning nobody reads twice.
    stub.answer = translating({ en: ENGLISH });
    await runAction(stub, { languages: "en, zh, vi" });
    expect(stub.body).not.toContain(CHINESE);
    stub.asked.length = 0;

    // Same text, same configuration, quota back.
    stub.answer = translating({ en: ENGLISH, zh: CHINESE });
    const run = await runAction(stub, { languages: "en, zh, vi" });

    expect(run.code).toBe(0);
    expect(stub.asked).not.toHaveLength(0);
    expect(stub.body).toContain(CHINESE);
    expect(stub.body).not.toContain("Not translated this run");
  });

  it("stops once every configured language is actually in the body", async () => {
    // The other half: recording what was achieved must not cost the loop guard
    // it was meant to protect. A run that translated everything writes a marker
    // the next run matches, and that run makes no request.
    stub.answer = translating({ en: ENGLISH, zh: CHINESE });
    await runAction(stub, { languages: "en, zh, vi" });
    const written = stub.body;
    stub.asked.length = 0;

    const run = await runAction(stub, { languages: "en, zh, vi" });

    expect(run.code).toBe(0);
    expect(stub.body).toBe(written);
    expect(stub.asked).toHaveLength(0);
    expect(run.log).toContain("already carries the translation");
  });

  it("says in the published block that the tail of a long body was left behind", async () => {
    stub.body = `${VIETNAMESE}\n\n${VIETNAMESE}`;

    const run = await runAction(stub, { "max-body-chars": String(VIETNAMESE.length) });

    expect(stub.body).toContain("The body was longer than this run's limit");
    expect(run.log).toContain("Raise `max-body-chars`");
  });

  it("translates the tail once the limit that left it behind is raised", async () => {
    // `Raise \`max-body-chars\` to translate the rest` was advice with no
    // effect. The marker hashed the whole body while the run translated a
    // prefix of it, so the raised run matched its own marker and skipped — and
    // the block's promise to have left the tail behind became permanent.
    const long = `${VIETNAMESE}\n\n${VIETNAMESE}`;
    stub.body = long;
    await runAction(stub, { "max-body-chars": String(VIETNAMESE.length) });
    expect(stub.body).toContain("The body was longer than this run's limit");
    stub.asked.length = 0;

    const run = await runAction(stub, { "max-body-chars": String(long.length + 100) });

    expect(run.code).toBe(0);
    expect(stub.asked).not.toHaveLength(0);
    expect(stub.body).not.toContain("The body was longer than this run's limit");
  });

  it("writes nothing and stays green for a thread with an empty body", async () => {
    stub.body = "   \n\n  ";

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.body).toBe("   \n\n  ");
    expect(stub.asked).toHaveLength(0);
    expect(run.outputs).toEqual({
      "source-language": "",
      translated: JSON.stringify([]),
      skipped: JSON.stringify([]),
      "replies-translated": "0",
      starved: "false",
      "budget-exhausted": "false",
      processed: "0",
      remaining: "0",
    });
  });

  it("writes nothing on a dry run, and logs the body it would have written", async () => {
    const run = await runAction(stub, { "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(stub.body).toBe(VIETNAMESE);
    expect(run.log).toContain("reeve:translate");
    expect(run.log).toContain(ENGLISH);
    expect(run.outputs.translated).toBe(JSON.stringify(["en"]));
  });

  it("translates the thread the event names when no number was configured", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "reeve-event-"));
    const eventFile = join(scratch, "event.json");
    await writeFile(eventFile, JSON.stringify({ issue: { number: 7 } }));

    const run = await runAction(stub, { number: "" }, { GITHUB_EVENT_PATH: eventFile });
    await rm(scratch, { recursive: true, force: true });

    expect(run.code).toBe(0);
    expect(stub.body).toContain(ENGLISH);
  });

  it("fails loudly on an event that names no thread, rather than asking for issue NaN", async () => {
    const run = await runAction(stub, { number: "" }, { GITHUB_EVENT_NAME: "schedule" });

    expect(run.code).toBe(1);
    expect(run.log).toContain("::error::");
    expect(run.log).toContain("this event (schedule) names no issue or pull request");
    expect(stub.body).toBe(VIETNAMESE);
  });

  it("fails loudly on a count that is not a whole number", async () => {
    const run = await runAction(stub, { drafts: "0" });

    expect(run.code).toBe(1);
    expect(run.log).toContain("drafts: expected a whole number of 1 or more, got `0`");
    expect(stub.asked).toHaveLength(0);
  });

  it("refuses a chunk size below the floor, rather than paying full overhead per sentence", async () => {
    const run = await runAction(stub, { "chunk-chars": "499" });

    expect(run.code).toBe(1);
    expect(run.log).toContain("chunk-chars: expected a whole number of 500 or more, got `499`");
    expect(stub.asked).toHaveLength(0);
  });

  it("fails loudly on an attribution level it has no rendering for", async () => {
    // Silently falling back to `none` would publish a hundred bodies with less
    // in them than the workflow asked for, and the fingerprint means the run
    // that fixes the spelling will not go back and rewrite them.
    const run = await runAction(stub, { "show-attribution": "verbose" });

    expect(run.code).toBe(1);
    expect(run.log).toContain("show-attribution: expected `none`, `model` or `detail`");
    expect(stub.asked).toHaveLength(0);
  });

  it("fails loudly when no model was configured at all", async () => {
    const run = await runAction(stub, { models: "  " });

    expect(run.code).toBe(1);
    expect(run.log).toContain("models: no entries");
  });

  it("fails loudly on a bare code the runtime knows no language by", async () => {
    // Derivation is what makes `languages: en, vi` legal, and this is the one
    // way it can be wrong: a code CLDR has no name for would otherwise become a
    // language nobody can read the name of. The bundle carries its own ICU, so
    // this is also the only place the derivation is measured against the built
    // artifact rather than against the test runner's runtime.
    const run = await runAction(stub, { languages: "en, qqq" });

    expect(run.code).toBe(1);
    expect(run.log).toContain("`qqq` is not a language code");
    expect(run.log).toContain("code:Label:Script");
  });
});

describe("the action, translating the replies", () => {
  /** A reply in each of the two languages a case might need it in. */
  const VIETNAMESE_REPLY = "Tôi cũng gặp phải lỗi này trên máy của tôi, và nó xảy ra mỗi lần.";
  const ENGLISH_REPLY = "I hit this on my machine too, and it happens every single time.";

  beforeEach(() => {
    // The body is emptied so a case's assertions are about its replies alone —
    // `replies-translated` is a count, and a body translated alongside them
    // would make every number below ambiguous. The one case that cares about
    // both at once sets a body back and scripts per source text.
    stub.body = "";
    stub.replies.set(991, VIETNAMESE_REPLY);
    stub.answer = translating({ en: ENGLISH_REPLY });
  });

  it("leaves every reply alone unless it was asked to translate them", async () => {
    // Off by default, and the cost is why: a forty-reply discussion is forty
    // more texts. A consumer who upgrades must not discover the feature by
    // finding their whole thread rewritten.
    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.replies.get(991)).toBe(VIETNAMESE_REPLY);
    expect(run.outputs["replies-translated"]).toBe("0");
  });

  it("appends the translation to the reply's own body", async () => {
    const run = await runAction(stub, { "translate-replies": "true" });

    expect(run.code).toBe(0);
    expect(stub.replies.get(991)).toContain(ENGLISH_REPLY);
    expect(stub.replies.get(991)).toContain("the version this project answers for");
    expect(marker.split(stub.replies.get(991) ?? "").official).toBe(VIETNAMESE_REPLY);
    expect(run.outputs["replies-translated"]).toBe("1");
  });

  it("writes a reply's translation to that reply and not to the thread body", async () => {
    // The failure that would be invisible in review and catastrophic in a
    // thread: the comment endpoint confused for the issue one. Scripted per
    // source text, so each translation is identifiable wherever it lands.
    stub.body = VIETNAMESE;
    stub.answer = answering([
      [VIETNAMESE.slice(0, 40), ENGLISH],
      [VIETNAMESE_REPLY.slice(0, 40), ENGLISH_REPLY],
    ]);

    await runAction(stub, { "translate-replies": "true" });

    expect(stub.body).toContain(ENGLISH);
    expect(stub.body).not.toContain(ENGLISH_REPLY);
    expect(stub.replies.get(991)).toContain(ENGLISH_REPLY);
    expect(stub.replies.get(991)).not.toContain(ENGLISH);
    expect(marker.split(stub.body).official).toBe(VIETNAMESE);
  });

  it("detects each reply's own language rather than inheriting the thread's", async () => {
    // A Vietnamese issue routinely collects English answers. Translating an
    // English reply into English would publish a block saying nothing, so each
    // reply gets its own detection.
    stub.replies.set(992, ENGLISH_REPLY);
    stub.answer = translating({ en: ENGLISH_REPLY, vi: VIETNAMESE_REPLY });

    const run = await runAction(stub, { "translate-replies": "true" });

    expect(stub.replies.get(991)).toContain("<b>English</b>");
    expect(stub.replies.get(992)).toContain("<b>Tiếng Việt</b>");
    expect(run.outputs["replies-translated"]).toBe("2");
  });

  it("translates a new reply on a thread whose body needs nothing", async () => {
    // The ordinary case for this feature: the body was translated last week,
    // its fingerprint still matches, and the reply is the only thing that
    // changed. A run that returned early on the body would never reach it.
    stub.body = VIETNAMESE;
    stub.answer = answering([
      [VIETNAMESE.slice(0, 40), ENGLISH],
      [VIETNAMESE_REPLY.slice(0, 40), ENGLISH_REPLY],
    ]);
    await runAction(stub, { "translate-replies": "true" });
    const body = stub.body;

    stub.replies.set(992, `${VIETNAMESE_REPLY} Thêm một câu.`);
    stub.answer = answering([[VIETNAMESE_REPLY.slice(0, 40), `${ENGLISH_REPLY} One more.`]]);

    const run = await runAction(stub, { "translate-replies": "true" });

    expect(run.log).toContain("already carries the translation");
    expect(stub.body).toBe(body);
    expect(stub.replies.get(992)).toContain("One more.");
    expect(run.outputs["replies-translated"]).toBe("1");
  });

  it("spends nothing on a rerun of replies it already translated", async () => {
    // Per-reply fingerprints, which is what makes a backfill over a long
    // discussion affordable: the second run costs one listing and no
    // completions at all.
    await runAction(stub, { "translate-replies": "true" });
    const written = stub.replies.get(991);
    stub.asked.length = 0;

    const run = await runAction(stub, { "translate-replies": "true" });

    expect(run.code).toBe(0);
    expect(stub.replies.get(991)).toBe(written);
    expect(stub.asked).toHaveLength(0);
    expect(run.outputs["replies-translated"]).toBe("0");
  });

  it("translates a reply again once its author edits it", async () => {
    await runAction(stub, { "translate-replies": "true" });
    stub.replies.set(991, `${VIETNAMESE_REPLY} Thêm một câu nữa.`);
    stub.answer = translating({ en: `${ENGLISH_REPLY} One more sentence.` });

    const run = await runAction(stub, { "translate-replies": "true" });

    expect(stub.replies.get(991)).toContain("One more sentence.");
    expect(stub.replies.get(991)?.split("reeve:translate")).toHaveLength(2);
    expect(run.outputs["replies-translated"]).toBe("1");
  });

  it("keeps going when one reply is a stack trace with no prose in it", async () => {
    // A reply with no prose in it is not a failure — a stack trace is written
    // the same way in every language, so there is nothing in it to translate —
    // and it must not stop the run before the reply after it.
    stub.replies.set(992, "```\n  at foo (bar.js:1:2)\n```");
    stub.replies.set(993, VIETNAMESE_REPLY);

    const run = await runAction(stub, { "translate-replies": "true" });

    expect(run.code).toBe(0);
    expect(stub.replies.get(993)).toContain(ENGLISH_REPLY);
    expect(run.outputs["replies-translated"]).toBe("2");
  });

  it("keeps going when a provider runs out of quota partway down the thread", async () => {
    // The failure a free tier actually produces. A run that translated the
    // first reply and then hit a limit must publish that one and warn about the
    // rest, not lose it. The body is left empty so the count below is the
    // replies' own.
    stub.body = "";
    let served = 0;
    stub.replies.set(992, `${VIETNAMESE_REPLY} Hai.`);
    stub.replies.set(993, `${VIETNAMESE_REPLY} Ba.`);
    stub.answer = () => {
      served += 1;
      return served > 1
        ? { status: 429, payload: { error: { message: "out of quota" } } }
        : saying(ENGLISH_REPLY);
    };

    const run = await runAction(stub, { "translate-replies": "true" });

    expect(run.code).toBe(0);
    expect(stub.replies.get(991)).toContain(ENGLISH_REPLY);
    expect(stub.replies.get(992)).toBe(`${VIETNAMESE_REPLY} Hai.`);
    expect(run.outputs["replies-translated"]).toBe("1");
    expect(run.log).toContain("no model produced a translation this run");
  });

  it("writes no reply on a dry run, and logs what each would have become", async () => {
    const run = await runAction(stub, { "translate-replies": "true", "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(stub.replies.get(991)).toBe(VIETNAMESE_REPLY);
    expect(run.log).toContain("comment 991 would have become");
    expect(run.log).toContain(ENGLISH_REPLY);
    expect(run.outputs["replies-translated"]).toBe("0");
  });

  it("names the reply in the log, so a thirteen-text run is readable", async () => {
    const run = await runAction(stub, { "translate-replies": "true" });

    expect(run.log).toContain("#42 comment 991");
  });
});

describe("max-requests", () => {
  // A self-imposed ceiling, deliberately unlike `starved`: the roster is
  // healthy the whole time in every case below, and every stop is this run's
  // own budget running out rather than the provider's.

  it(
    "stops translating further languages once the budget is reached, publishing what " +
      "already drafted",
    async () => {
      stub.answer = translating({ en: ENGLISH, zh: CHINESE });

      const run = await runAction(stub, { languages: "en, zh, vi", "max-requests": "1" });

      expect(run.code).toBe(0);
      expect(run.outputs.translated).toBe(JSON.stringify(["en"]));
      expect(run.outputs.skipped).toBe(JSON.stringify(["zh"]));
      expect(run.outputs["budget-exhausted"]).toBe("true");
      expect(stub.body).toContain(ENGLISH);
      expect(stub.body).not.toContain(CHINESE);
      expect(run.log).toContain(
        "#42: `max-requests` was reached, so zh was not attempted this run. " +
          "What was already drafted still publishes.",
      );
    },
  );

  it("stops translating further replies once the budget is reached, leaving the rest alone", async () => {
    const VIETNAMESE_REPLY = "Tôi cũng gặp phải lỗi này trên máy của tôi, và nó xảy ra mỗi lần.";
    const ENGLISH_REPLY = "I hit this on my machine too, and it happens every single time.";
    stub.body = "";
    stub.replies.set(991, VIETNAMESE_REPLY);
    stub.replies.set(992, `${VIETNAMESE_REPLY} Hai.`);
    stub.answer = translating({ en: ENGLISH_REPLY });

    const run = await runAction(stub, { "translate-replies": "true", "max-requests": "1" });

    expect(run.code).toBe(0);
    expect(stub.replies.get(991)).toContain(ENGLISH_REPLY);
    expect(stub.replies.get(992)).toBe(`${VIETNAMESE_REPLY} Hai.`);
    expect(run.outputs["replies-translated"]).toBe("1");
    expect(run.outputs["budget-exhausted"]).toBe("true");
    expect(run.log).toContain(
      "#42: `max-requests` was reached, so its remaining replies were not attempted this run.",
    );
  });

  it(
    "stops a sweep from starting a new thread once the budget is reached, distinctly from " +
      "a starved roster",
    async () => {
      stub.issues = [
        { number: 101, body: VIETNAMESE, createdAt: "2026-01-03T00:00:00Z" },
        { number: 102, body: VIETNAMESE, createdAt: "2026-01-02T00:00:00Z" },
      ];

      const run = await runAction(stub, {
        sweep: "true",
        number: "",
        "max-requests": "1",
      });

      expect(run.code).toBe(0);
      expect(run.outputs.processed).toBe("1");
      expect(run.outputs.remaining).toBe("1");
      expect(run.outputs.starved).toBe("false");
      expect(run.outputs["budget-exhausted"]).toBe("true");
      expect(run.summary).toContain("`max-requests` was reached partway through");
      expect(run.summary).not.toContain("ran out of capacity");
    },
  );

  it("never trips on the default (`none`), whatever this run spends", async () => {
    stub.answer = translating({ en: ENGLISH, zh: CHINESE });

    const run = await runAction(stub, { languages: "en, zh, vi" });

    expect(run.code).toBe(0);
    expect(run.outputs.translated).toBe(JSON.stringify(["en", "zh"]));
    expect(run.outputs["budget-exhausted"]).toBe("false");
  });

  it(
    "reports `budget-exhausted: false` when a thread with a single target language " +
      "spends exactly `max-requests` and has nothing left to deny",
    async () => {
      // The bug this pins: recomputing "exhausted" from the meter's final
      // reading at the end of the run cannot tell this case apart from one
      // where a language really was turned away — both leave the meter
      // sitting exactly at the ceiling. Genuine denial is tracked instead,
      // and this thread's one and only target language never gets turned
      // away — the loop simply runs out of languages to check before it
      // runs out of budget.
      stub.answer = translating({ en: ENGLISH });

      const run = await runAction(stub, { languages: "en, vi", "max-requests": "1" });

      expect(run.code).toBe(0);
      expect(run.outputs.translated).toBe(JSON.stringify(["en"]));
      expect(run.outputs.skipped).toBe(JSON.stringify([]));
      expect(run.outputs["budget-exhausted"]).toBe("false");
    },
  );

  it(
    "reports `budget-exhausted: true` from a sweep whose only candidate denied a " +
      "language inside its own thread, with no next candidate left for the sweep's " +
      "own pre-thread check to ever run again",
    async () => {
      // The other direction of the same bug: the sweep's own pre-thread
      // checkpoint only ever fires before starting a thread, so a denial
      // that happens inside the last (here, the only) candidate's own
      // per-language checkpoint has no later loop iteration to be noticed
      // by. Tracking genuine denial at its source — inside `budgetExhausted`
      // itself — catches it anyway.
      stub.issues = [{ number: 101, body: VIETNAMESE, createdAt: "2026-01-01T00:00:00Z" }];
      stub.answer = translating({ en: ENGLISH, zh: CHINESE });

      const run = await runAction(stub, {
        sweep: "true",
        number: "",
        languages: "en, vi, zh",
        "max-requests": "1",
      });

      expect(run.code).toBe(0);
      expect(run.outputs.processed).toBe("1");
      expect(run.outputs.remaining).toBe("0");
      expect(run.outputs.starved).toBe("false");
      expect(run.outputs["budget-exhausted"]).toBe("true");
    },
  );
});

describe("the sweep", () => {
  /** One entry in the backlog `stub.issues` lists, newest-first order left to the case. */
  function candidate(
    number: number,
    body: string,
    createdAt: string,
    over: Partial<ListedIssue> = {},
  ): ListedIssue {
    return { number, body, createdAt, ...over };
  }

  /**
   * `sweep: true` needs `number` cleared — `baseInputs` sets `number: "42"` for
   * the single-thread suite above, and `readShared` refuses the two together.
   */
  function sweepInputs(over: Record<string, string> = {}): Record<string, string> {
    return { sweep: "true", number: "", ...over };
  }

  it(
    "shrinks the roster run-wide, never retrying a model a capacity failure already " +
      "grounded on an earlier thread",
    async () => {
      stub.issues = [
        candidate(101, VIETNAMESE, "2026-01-03T00:00:00Z"),
        candidate(102, VIETNAMESE, "2026-01-02T00:00:00Z"),
      ];
      stub.answer = () => ({ status: 429, payload: { error: { message: "out of quota" } } });

      const run = await runAction(stub, sweepInputs({ models: "stub-model-a, stub-model-b" }));

      expect(run.code).toBe(0);
      // Both models are asked once each, and only once — on #101. #102 is never
      // reached: `starved` is checked before a thread is processed on every
      // iteration of the loop, against the one `Weather` object the whole run
      // shares, so a roster grounded dry on the first thread stays dry for the
      // rest of it.
      expect(stub.asked.map((ask) => ask.model)).toEqual(["stub-model-a", "stub-model-b"]);
      expect(run.outputs.processed).toBe("1");
      expect(run.outputs.remaining).toBe("1");
      expect(run.outputs.starved).toBe("true");
      expect(run.summary).toContain("| #101 |");
      expect(run.summary).not.toContain("| #102 |");
    },
  );

  it("keeps only threads created on or after a calendar `since` date", async () => {
    stub.issues = [
      candidate(201, VIETNAMESE, "2026-01-10T00:00:00Z"),
      candidate(202, VIETNAMESE, "2025-06-01T00:00:00Z"),
    ];

    const run = await runAction(stub, sweepInputs({ since: "2026-01-01" }));

    expect(run.code).toBe(0);
    expect(run.outputs.processed).toBe("1");
    expect(run.outputs.remaining).toBe("0");
    expect(stub.bodies.get(201)).toContain(ENGLISH);
    expect(run.summary).toContain("| #201 |");
    expect(run.summary).not.toContain("| #202 |");
  });

  it("keeps only threads created within a duration-style `since`", async () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    stub.issues = [candidate(301, VIETNAMESE, recent), candidate(302, VIETNAMESE, old)];

    const run = await runAction(stub, sweepInputs({ since: "90d" }));

    expect(run.code).toBe(0);
    expect(run.outputs.processed).toBe("1");
    expect(run.summary).toContain("| #301 |");
    expect(run.summary).not.toContain("| #302 |");
  });

  it("honours `limit`, and counts what it left behind as `remaining`", async () => {
    stub.issues = [
      candidate(401, VIETNAMESE, "2026-01-03T00:00:00Z"),
      candidate(402, VIETNAMESE, "2026-01-02T00:00:00Z"),
      candidate(403, VIETNAMESE, "2026-01-01T00:00:00Z"),
    ];

    const run = await runAction(stub, sweepInputs({ limit: "2" }));

    expect(run.code).toBe(0);
    expect(run.outputs.processed).toBe("2");
    expect(run.outputs.remaining).toBe("1");
    expect(run.summary).toContain("| #401 |");
    expect(run.summary).toContain("| #402 |");
    expect(run.summary).not.toContain("| #403 |");
  });

  it("skips a thread whose body already carries this duty's marker, at no cost", async () => {
    stub.issues = [
      candidate(
        501,
        `${VIETNAMESE}\n\n<!-- reeve:translate source=deadbeef -->`,
        "2026-01-02T00:00:00Z",
      ),
      candidate(502, VIETNAMESE, "2026-01-01T00:00:00Z"),
    ];

    const run = await runAction(stub, sweepInputs());

    expect(run.code).toBe(0);
    expect(run.outputs.processed).toBe("1");
    expect(run.outputs.skipped).toBe("1");
    expect(run.outputs.remaining).toBe("0");
    // The skip is free: only #502 was ever translated, so only #502 spent a
    // model call.
    expect(stub.asked).toHaveLength(1);
    expect(run.summary).toContain("| #502 |");
    expect(run.summary).not.toContain("| #501 |");
  });

  it("refuses `sweep` combined with `number`, before spending anything", async () => {
    const run = await runAction(stub, { sweep: "true", number: "7" });

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("sweep: cannot be combined with `number`");
    expect(stub.asked).toHaveLength(0);
  });

  it(
    "rehearses the loop on a dry run, publishing nothing but still reporting processed and " +
      "remaining",
    async () => {
      stub.issues = [
        candidate(601, VIETNAMESE, "2026-01-02T00:00:00Z"),
        candidate(602, VIETNAMESE, "2026-01-01T00:00:00Z"),
      ];

      const run = await runAction(stub, sweepInputs({ "dry-run": "true" }));

      expect(run.code).toBe(0);
      expect(run.outputs.processed).toBe("2");
      expect(run.outputs.remaining).toBe("0");
      expect(run.summary).toContain("**Dry run** — nothing was published.");
      // Nothing published: neither fabricated thread was ever `PATCH`ed.
      expect(stub.bodies.size).toBe(0);
    },
  );
});

describe("the warrant", () => {
  it("reads languages from the warrant's own key, ignoring the input entirely", async () => {
    // The stub only ever answers a request for English — so if the input's
    // `zh` were consulted at all, the thread's Vietnamese body would have
    // nothing to be translated into and this would end with no translation.
    // The warrant's `en, vi` is the only reason it exists.
    await writeFile(
      warrantPath,
      [
        "version: 1",
        "capabilities:",
        "  translate: [edit-body]",
        "languages:",
        "  - en",
        "  - vi",
      ].join("\n"),
    );

    const run = await runAction(stub, { languages: "zh" });

    expect(run.code).toBe(0);
    expect(run.outputs.translated).toBe(JSON.stringify(["en"]));
    expect(run.log).toContain(
      `languages: read from \`${warrantPath}\`'s \`languages:\` key, not the \`languages\` input`,
    );
  });

  it("falls back to the languages input when the warrant never mentions the key", async () => {
    // `WARRANT` above carries a `capabilities:` block and no `languages:` key —
    // the ordinary shape a maintainer who has never heard of this feature
    // still runs under, and the input answers exactly as it always has.
    const run = await runAction(stub, { languages: "en, vi" });

    expect(run.code).toBe(0);
    expect(run.outputs.translated).toBe(JSON.stringify(["en"]));
    expect(run.log).not.toContain("read from");
  });

  it("fails red when neither the warrant nor the input names any language", async () => {
    const run = await runAction(stub, { languages: "" });

    expect(run.code).toBe(1);
    expect(run.log).toContain("languages: no language is configured");
    expect(run.log).toContain(`Write \`languages:\` in the warrant (\`${warrantPath}\`)`);
    expect(run.log).toContain("or set the `languages` input");
    expect(stub.asked).toHaveLength(0);
  });

  it("grants translate nothing, spends no model call, and says why, when a written block does not name it", async () => {
    await writeFile(warrantPath, ["version: 1", "capabilities:", "  triage: [label]"].join("\n"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.body).toBe(VIETNAMESE);
    expect(run.outputs.translated).toBe(JSON.stringify([]));
    expect(run.summary).toContain(
      `\`${warrantPath}\`'s \`capabilities:\` block does not name \`translate\`; once that block ` +
        "exists it is the whole answer, so add `translate: [edit-body]` to it (or remove the " +
        "block to return to defaults).",
    );
    expect(run.summary).toContain("No model was asked anything. This is a real answer");
  });

  it("stays green when denied, even with no languages configured anywhere", async () => {
    // The grant question outranks the language question: a denied duty is
    // promised a green no-op, and `languages` is configuration it was never
    // going to use — red-failing over it would fail the run for a key that
    // could not have mattered.
    await writeFile(warrantPath, ["version: 1", "capabilities:", "  triage: [label]"].join("\n"));

    const run = await runAction(stub, { languages: "" });

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(run.summary).toContain("does not name `translate`");
  });

  it("says in the summary why a drafted translation was not published, when `edit-body` is withheld", async () => {
    // `[none]` names the duty and grants it nothing: the pipeline still
    // detects, drafts and judges — the same spend an `apply: none` narrowing
    // costs triage — and only the write is withheld. The summary has to say
    // that, because with `posted` emptied a blocked write and a run where no
    // draft survived would otherwise read identically.
    await writeFile(warrantPath, ["version: 1", "capabilities:", "  translate: [none]"].join("\n"));

    const run = await runAction(stub, { languages: "en, vi" });

    expect(run.code).toBe(0);
    expect(stub.body).toBe(VIETNAMESE);
    expect(stub.asked.length).toBeGreaterThan(0);
    expect(run.summary).toContain("`edit-body` is not permitted this run");
  });

  it("says which half withheld it, once, up front, when `apply` asks for more than the warrant grants", async () => {
    await writeFile(warrantPath, ["version: 1", "capabilities:", "  translate: [none]"].join("\n"));

    const run = await runAction(stub, { languages: "en, vi" });

    expect(run.code).toBe(0);
    expect(run.log).toContain(
      `\`apply\` asks for \`edit-body\`, which \`${warrantPath}\` does not grant to translate.`,
    );
  });

  it("narrows `edit-body` away when `apply` alone withholds it, warrant granting freely", async () => {
    const run = await runAction(stub, { apply: "none", languages: "en, vi" });

    expect(run.code).toBe(0);
    // Detection, drafting and judging still ran and spent — only the write is gated.
    expect(stub.asked.length).toBeGreaterThan(0);
    expect(stub.body).toBe(VIETNAMESE);
    // Nothing was withheld from what `apply` asked for — it asked for nothing —
    // so the upfront warning never fires; only the generic not-published note does.
    expect(run.log).not.toContain("does not grant");
    expect(run.summary).toContain("`edit-body` is not permitted this run");
  });

  it("grants translate nothing in a sweep too, checked once before the listing", async () => {
    await writeFile(warrantPath, ["version: 1", "capabilities:", "  triage: [label]"].join("\n"));
    stub.issues = [{ number: 701, body: VIETNAMESE, createdAt: "2026-01-01T00:00:00Z" }];

    const run = await runAction(stub, { sweep: "true", number: "" });

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(run.outputs.processed).toBe("0");
    expect(run.summary).toContain("does not name `translate`");
    // No listing request was ever made — the short-circuit is before it.
    expect(stub.listings).toBe(0);
  });
});

describe("zero config", () => {
  /**
   * `.github/reeve.yml`, exactly as `warrant`'s own default names it and
   * exactly as `main.ts`'s `DEFAULT_WARRANT_PATH` names it. Passed as an
   * input rather than left to `action.yml`'s default, because this file never
   * goes through a runner that would supply it — but the value has to be the
   * same string, or the run would see it as a path a consumer chose and fail
   * loudly on it instead of running at the narrowest authority.
   */
  const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

  it("keeps its defaults — edit-body, and languages from the input — when no warrant exists", async () => {
    const run = await runAction(stub, { warrant: DEFAULT_WARRANT_PATH }, {}, scratch);

    expect(run.code).toBe(0);
    expect(stub.body).toContain(ENGLISH);
    expect(run.summary).toContain(
      `No \`${DEFAULT_WARRANT_PATH}\` — this duty found no warrant file, and ran on its own ` +
        "defaults (`edit-body`, and whatever `languages` was configured).",
    );
  });
});

describe("the action contract", () => {
  /**
   * Every input `action.yml` declares, read straight out of it.
   *
   * A regex rather than the YAML parser this repository now carries: that one
   * is bundled into the duties to read a warrant at runtime, and reaching for
   * it here would make this suite agree with itself about a file it is
   * checking. The shape being read is two levels deep and fully indented —
   * every input is a key at exactly two spaces inside the `inputs:` block.
   */
  async function declaredInputs(): Promise<string[]> {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");
    const block = /\ninputs:\n([\s\S]*?)\noutputs:\n/.exec(text)?.[1] ?? "";
    return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(([, name]) => name ?? "");
  }

  /**
   * Every input the duty actually reads — its own, and the five it inherits.
   *
   * Both files, because the shared inputs are read once in the core and
   * declared once per duty: a duty that dropped `api-key` from its `action.yml`
   * would still read it, and nothing else would notice.
   */
  async function readInputs(): Promise<string[]> {
    const sources = await Promise.all([
      readFile(join(ROOT, "src", "duties", "translate", "main.ts"), "utf8"),
      readFile(join(ROOT, "src", "core", "inputs.ts"), "utf8"),
    ]);
    // A set, not a list: `number` is read twice in `inputs.ts` — once to check
    // it is not combined with `sweep`, again inside `threadNumber` — and that
    // duplication is harmless plumbing rather than a second, different input.
    return [
      ...new Set(
        [...sources.join("\n").matchAll(/get(?:Boolean)?Input\("([^"]+)"/g)].map(
          ([, name]) => name ?? "",
        ),
      ),
    ];
  }

  it("reads every input it declares, under the name it declared", async () => {
    // The one drift no other test can see: renaming an input in `action.yml`
    // alone leaves the action reading an empty string forever, silently and on
    // every run.
    expect([...(await readInputs())].sort()).toEqual([...(await declaredInputs())].sort());
  });

  it("offers every input to a local run, under the name `pnpm try` reads", async () => {
    // `tools/try.mjs` derives the `.env` key from the input name, so a new
    // input is configurable locally the moment it exists — but nothing would
    // say so, and an undocumented knob is one nobody turns. The example file is
    // the document, and this is what stops it going stale.
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
    // A control character in a source file is not a style question. Git
    // classifies a file holding a NUL as binary, so a pull request touching it
    // renders `Bin 12990 -> 16484 bytes` where the diff belongs — and a module
    // nobody can read a diff of is a module nobody reviewed, however carefully
    // they meant to. It reached `publish.ts` once, as the separator
    // `fingerprint` hashes with, and survived two pull requests over exactly
    // the code that decides what gets written into a public thread.
    //
    // The escape `\u0000` hashes the identical byte and leaves the file text,
    // so this costs the code nothing. Tab, newline and carriage return are
    // ordinary; the rest of C0 is not.
    const offenders: string[] = [];
    for (const file of await readdir(join(ROOT, "src"), { recursive: true })) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(join(ROOT, "src", file), "utf8");
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
