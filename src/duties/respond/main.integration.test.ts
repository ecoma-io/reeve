/**
 * The respond duty, driven the way a runner drives it.
 *
 * Its entry point calls `run()` at import, so it cannot be imported and
 * measured — importing it would run it. What a runner actually does is spawn
 * `respond/dist/index.js` with `INPUT_*` in the environment and read
 * `GITHUB_OUTPUT` afterwards, and that is exactly what happens below.
 *
 * It is also the only place the guards that are code rather than input are
 * exercised end to end: never over a human, never twice on the same thread —
 * however many times the issue was edited — never on a bot's own issue, never
 * on a thread the cheap screen already dropped as spam. A unit test can show
 * `draft.ts` writes what it is handed; only this can show nothing downstream
 * posted it when it should not have.
 *
 * Two collaborators are real and one is not. The bundle is real, rebuilt here
 * so a case can never pass against a stale artifact. GitHub and the provider
 * are a local HTTP server — `@actions/github` reads its base URL from
 * `GITHUB_API_URL` and `base-url` is an input, so both point at it and
 * nothing in this file reaches a network or a model.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// A spawn per case, each loading a multi-megabyte bundle and identifying a
// language from bundled profile data. Comfortably under this, and not worth
// flaking over.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Where this duty is published from: a repository subdirectory of its own. */
const DUTY = join(ROOT, "respond");
const BUNDLE = join(DUTY, "dist", "index.js");

/** Long enough, and diacritical enough, to be identified without a model. */
const VIETNAMESE =
  "Nút chuyển chế độ tối không lưu lại sau khi tải lại trang, tôi nghĩ nó nên được ghi vào bộ nhớ cục bộ.";
const ENGLISH =
  "The dark mode toggle does not persist after a page reload; I think it should be written to local storage.";

const REPLY = "Thanks for filing this — could you share which browser and OS you are on?";

/** A warrant granting `respond` exactly what its own default withholds. */
const WARRANT = ["version: 1", "capabilities:", "  respond: [comment]"].join("\n");
/** A written block that never mentions `respond` at all. */
const UNNAMED_WARRANT = ["version: 1", "capabilities:", "  triage: [label]"].join("\n");

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
  readonly user: string;
  readonly authorization: string | null;
}

interface Answer {
  readonly status: number;
  readonly payload: unknown;
}

/** One reply, as the stub's comment listing holds it. */
interface Comment {
  readonly id: number;
  body: string;
  readonly login: string;
  readonly type: "User" | "Bot";
}

/** Everything a request is answered from, and everything a case may change. */
interface State {
  title: string;
  body: string;
  author: { login: string; type: "User" | "Bot" };
  labels: string[];
  repositoryLabels: string[];
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

type Stage = "screen" | "detect" | "draft" | "judge" | "pivot";

/** Which of this duty's stages a request belongs to, read off its own system message. */
function stageOf(ask: Ask): Stage {
  if (ask.system.includes("worth a maintainer's")) return "screen";
  if (ask.system.includes("You identify which language")) return "detect";
  if (ask.system.includes("writing the first reply")) return "draft";
  if (ask.system.includes("You are choosing the best of")) return "judge";
  if (ask.system.includes("Translate the title and body")) return "pivot";
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

    switch (stage) {
      case "screen":
        return saying("keep");
      case "detect":
        return saying("en");
      case "draft":
        return saying(JSON.stringify({ text: REPLY, confidence: 0.9 }));
      case "judge":
        return saying("1");
      case "pivot":
        return saying(JSON.stringify({ title: "translated title", body: "translated body" }));
    }
  };
}

async function startStub(): Promise<Stub> {
  const state: State = {
    title: "Crash on save",
    body: ENGLISH,
    author: { login: "reporter", type: "User" },
    labels: [],
    repositoryLabels: [],
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

  const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
  if (method === "GET" && issue) {
    send(response, 200, {
      number: Number(issue[1]),
      title: stub.title,
      body: stub.body,
      labels: stub.labels.map((name) => ({ name })),
      state: "open",
      user: { login: stub.author.login, type: stub.author.type },
    });
    return;
  }

  const comments = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(path);
  if (method === "GET" && comments) {
    send(
      response,
      200,
      // GitHub's own order: oldest first.
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

  // Only reached by a case exercising the implicit warrant — a written file
  // always answers `respond`'s capabilities without this endpoint at all.
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) {
    send(
      response,
      200,
      stub.repositoryLabels.map((name) => ({ name, description: null })),
    );
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
 * only what it changes. `apply` is `comment` here rather than the input's own
 * `none`, so a case not otherwise concerned with the double gate sees the
 * warrant's own grant settle the question by itself.
 */
function baseInputs(
  stub: Stub,
  warrant: string,
  corrections: string,
  guidance: string,
): Record<string, string> {
  return {
    "github-token": "stub-token",
    number: "42",
    "base-url": `${stub.url}/v1`,
    "api-key": "sk-stub-key",
    models: "stub-model",
    "judge-models": "",
    drafts: "1",
    languages: "en, vi, zh",
    warrant,
    apply: "comment",
    confidence: "0.75",
    guidance,
    corrections,
    "max-body-chars": "6000",
    "dry-run": "false",
    "screen-models": "",
    about: "",
    endpoints: "",
    "api-keys": "",
    "request-timeout": "120s",
    temperature: "",
  };
}

let scratch: string;
let warrantPath: string;
let correctionsPath: string;
let guidancePath: string;

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
  for (const [name, value] of Object.entries({
    ...baseInputs(stub, warrantPath, correctionsPath, guidancePath),
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

/** One correction, written into the store the way a maintainer's run would. */
async function remember(correction: Record<string, unknown>): Promise<void> {
  await mkdir(correctionsPath, { recursive: true });
  await writeFile(
    join(correctionsPath, "2026-08.ndjson"),
    `${JSON.stringify({
      thread: 7,
      at: "2026-08-01T00:00:00Z",
      title: "Crash when the save button is pressed twice quickly",
      excerpt: "Double-clicking save throws a null reference.",
      language: "en",
      proposed: ["bug"],
      decided: ["bug"],
      by: "ana",
      note: "Known double-submit issue — ask for the OS and browser.",
      pivot: null,
      ...correction,
    })}\n`,
  );
}

// ---------------------------------------------------------------------------

let stub: Stub;

beforeEach(async () => {
  stub = await startStub();
  scratch = await mkdtemp(join(tmpdir(), "reeve-respond-"));
  warrantPath = join(scratch, "reeve.yml");
  correctionsPath = join(scratch, "corrections");
  guidancePath = join(scratch, "guidance.md");
  await writeFile(warrantPath, WARRANT);
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the action", () => {
  it("drafts, judges and posts a first reply in the author's own language", async () => {
    stub.body = VIETNAMESE;
    stub.answer = stageAnswer({
      draft: JSON.stringify({ text: REPLY, confidence: 0.92 }),
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    const posted = stub.comments[0]?.body ?? "";
    expect(posted).toContain(REPLY);
    // The thread is Vietnamese, and chrome follows the language of the reply
    // it wraps — see src/core/chrome.ts's doc comment.
    expect(posted).toContain("Phản hồi này do [Reeve]");
    expect(posted).toContain("không phải do maintainer viết");
    expect(posted).toContain("<!-- reeve:respond source=");
    expect(posted).toContain("được viết bằng");
    expect(run.outputs.responded).toBe("true");
    expect(run.outputs["respond-text"]).toBe(REPLY);
    expect((run.outputs.language ?? "").length).toBeGreaterThan(0);
  });

  it("elects a winner through a panel when more than one draft is asked for", async () => {
    let count = 0;
    stub.answer = stageAnswer({
      draft: () => {
        count += 1;
        return saying(
          JSON.stringify({ text: `Draft ${String(count)}.`, confidence: 0.8 + count / 100 }),
        );
      },
      judge: "2",
    });

    const run = await runAction(stub, { drafts: "2", "judge-models": "judge-model" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    expect(stub.comments[0]?.body).toContain("decided by judges");
    expect(stub.comments[0]?.body).toContain("Votes: `judge-model`");
  });

  it("keeps the draft off the thread when the double gate withholds `comment`", async () => {
    const run = await runAction(stub, { apply: "none" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.responded).toBe("false");
    expect(run.outputs["respond-text"]).toBe(REPLY);
    expect(run.summary).toContain("`comment` was not granted");
    // Report-only dogfooding: `respond-text` is invisible to anyone reading
    // only the job summary, so the confident, withheld draft has to be
    // legible there too, fenced under the verdict.
    expect(run.summary).toContain(`\`\`\`\n${REPLY}\n\`\`\``);
  });

  it("never speaks over a human who already replied", async () => {
    stub.comments.push({
      id: 900,
      body: "I hit this too, on Firefox.",
      login: "someone-else",
      type: "User",
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.comments).toHaveLength(1);
    expect(run.outputs.responded).toBe("false");
    expect(run.summary).toContain("A human already replied");
  });

  it("is not owed to a thread a bot account opened", async () => {
    stub.author = { login: "some-bot", type: "Bot" };

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.summary).toContain("bot account");
  });

  it("never posts a second reply, however many times the issue is edited since", async () => {
    const first = await runAction(stub);
    expect(first.code).toBe(0);
    expect(stub.comments).toHaveLength(1);

    // Editing the issue after it was answered — the case this duty must not
    // read as licence to answer again.
    stub.body = `${ENGLISH} Also, it happens on the mobile app too.`;

    const second = await runAction(stub);

    expect(second.code).toBe(0);
    expect(stub.asked).toHaveLength(1); // no stage was asked anything the second time
    expect(stub.comments).toHaveLength(1); // no second comment, and the first was not edited either
    expect(second.outputs.responded).toBe("false");
    expect(second.summary).toContain("answers a thread once");
  });

  it("grounds the draft in a correction this project already made", async () => {
    await remember({});
    let seenDecisions = "";
    stub.answer = stageAnswer({
      draft: (ask) => {
        seenDecisions = ask.user;
        return saying(JSON.stringify({ text: REPLY, confidence: 0.9 }));
      },
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(seenDecisions).toContain("DECISIONS THIS PROJECT ALREADY MADE");
    expect(seenDecisions).toContain("Known double-submit issue");
  });

  it("honours `memory.recall: 0` by never reading the corrections store at all", async () => {
    // A malformed line the store would normally warn about by name — proof,
    // if the warning never appears, that `readStore` was never called rather
    // than merely called and told to recall nothing.
    await mkdir(correctionsPath, { recursive: true });
    await writeFile(join(correctionsPath, "2026-08.ndjson"), "not json\n");
    await writeFile(
      warrantPath,
      ["version: 1", "capabilities:", "  respond: [comment]", "memory:", "  recall: 0"].join("\n"),
    );
    let seenDecisions = "";
    stub.answer = stageAnswer({
      draft: (ask) => {
        seenDecisions = ask.user;
        return saying(JSON.stringify({ text: REPLY, confidence: 0.9 }));
      },
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.log).not.toContain("corrections:");
    expect(seenDecisions).not.toContain("DECISIONS THIS PROJECT ALREADY MADE");
  });

  it("reaches a correction recorded in another language through its pivot rendering", async () => {
    await remember({ language: "en" });
    stub.title = "Lỗi khi lưu hai lần liên tiếp";
    stub.body = VIETNAMESE;
    let seenDecisions = "";
    stub.answer = stageAnswer({
      pivot: JSON.stringify({
        title: "Crash when the save button is pressed twice quickly",
        body: "It throws when double-clicked.",
      }),
      draft: (ask) => {
        seenDecisions = ask.user;
        return saying(JSON.stringify({ text: REPLY, confidence: 0.9 }));
      },
    });

    const run = await runAction(stub, { languages: "en, vi" });

    expect(run.code).toBe(0);
    expect(seenDecisions).toContain("Known double-submit issue");
  });

  it("bridges into the pivot language with the cheap roster, when one is configured", async () => {
    await remember({ language: "en" });
    stub.title = "Lỗi khi lưu hai lần liên tiếp";
    stub.body = VIETNAMESE;
    let pivotModel = "";
    stub.answer = stageAnswer({
      pivot: (ask) => {
        pivotModel = ask.model;
        return saying(
          JSON.stringify({
            title: "Crash when the save button is pressed twice quickly",
            body: "It throws when double-clicked.",
          }),
        );
      },
    });

    const run = await runAction(stub, { languages: "en, vi", "screen-models": "cheap-model" });

    expect(run.code).toBe(0);
    // A mechanical translation for recall does not need the roster a first
    // reply is drafted with — same cost split triage's own bridge makes.
    expect(pivotModel).toBe("cheap-model");
    expect(pivotModel).not.toBe("stub-model");
  });

  it("never engages a thread the cheap screen classified as spam", async () => {
    stub.answer = stageAnswer({ screen: "spam" });

    const run = await runAction(stub, { "screen-models": "screen-model" });

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(1); // the screen, and nothing past it
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.responded).toBe("false");
    expect(run.summary).toContain("screened out as spam");
  });

  it("keeps going past a thread the screen has no opinion about, when no roster is configured", async () => {
    const run = await runAction(stub); // screen-models is empty by default

    expect(run.code).toBe(0);
    expect(stub.asked.some((ask) => stageOf(ask) === "screen")).toBe(false);
    expect(stub.comments).toHaveLength(1);
  });

  it("follows maintainer-authored guidance, entered as instruction rather than as thread text", async () => {
    await writeFile(guidancePath, "Never promise a release date.");
    let system = "";
    stub.answer = stageAnswer({
      draft: (ask) => {
        system = ask.system;
        return saying(JSON.stringify({ text: REPLY, confidence: 0.9 }));
      },
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(system).toContain("MAINTAINER GUIDANCE");
    expect(system).toContain("Never promise a release date.");
  });

  it("withholds the draft below the confidence floor, but still reports it", async () => {
    stub.answer = stageAnswer({ draft: JSON.stringify({ text: REPLY, confidence: 0.4 }) });

    const run = await runAction(stub, { confidence: "0.75" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.responded).toBe("false");
    expect(run.outputs["respond-text"]).toBe(REPLY);
    expect(run.summary).toContain("below the floor");
    expect(run.summary).toContain(`\`\`\`\n${REPLY}\n\`\`\``);
  });

  it("writes every output and posts nothing on a dry run", async () => {
    const run = await runAction(stub, { "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.responded).toBe("false");
    expect(run.outputs["respond-text"]).toBe(REPLY);
    expect(run.log).toContain("would have received");
  });

  it("rotates past a model that is out of capacity, and reports it as weather, not a failure", async () => {
    stub.answer = stageAnswer({
      draft: (ask) =>
        ask.model === "stub-model-a"
          ? { status: 429, payload: { error: { message: "out of quota" } } }
          : saying(JSON.stringify({ text: REPLY, confidence: 0.9 })),
    });

    const run = await runAction(stub, { models: "stub-model-a, stub-model-b" });

    expect(run.code).toBe(0);
    expect(stub.comments).toHaveLength(1);
    expect(run.outputs.starved).toBe("false");
  });

  it("fails red the instant a model reports an authentication problem", async () => {
    stub.body = VIETNAMESE; // identified by script alone — the draft call is the first one made
    stub.answer = stageAnswer({
      draft: () => ({ status: 401, payload: { error: { message: "invalid api key" } } }),
    });

    const run = await runAction(stub);

    expect(run.code).not.toBe(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.log).toContain("HTTP 401");
  });

  it("fails closed rather than guess when the reply list is truncated before either guard can rule", async () => {
    // A full page of bot replies, none carrying this duty's marker and none
    // human — this duty's own marker or a human's reply could be sitting
    // just past what this run read. Top rung: refuse to draft, let alone
    // post, on a guess that thin.
    stub.comments = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      body: "Ran the checks.",
      login: "some-other-bot",
      type: "Bot" as const,
    }));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.comments).toHaveLength(100); // nothing new was posted
    expect(run.outputs.responded).toBe("false");
    expect(run.summary).toContain("Could not verify the thread is unanswered");
  });

  it("grants nothing at all, and spends nothing deciding what to say, when a written block does not name it", async () => {
    const run = await runAction(stub, { warrant: await writtenAt(UNNAMED_WARRANT) });

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.comments).toHaveLength(0);
    expect(run.outputs.responded).toBe("false");
    expect(run.summary).toContain("does not name `respond`");
  });
});

/** A second warrant file beside the default one, for a case that names its own. */
async function writtenAt(contents: string): Promise<string> {
  const path = join(scratch, "unnamed.yml");
  await writeFile(path, contents);
  return path;
}

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
   * Every input the duty actually reads — its own, and `number`, which it
   * reaches `core/inputs.ts`'s `threadNumber` for.
   *
   * Only `threadNumber`'s own body is scanned there, not the whole file:
   * `respond` is deliberately not built on `readShared` (see `readSettings`'s
   * doc comment in `main.ts`), so `sweep`, `since` and `limit` — which
   * `readShared` reads and this duty never calls — must not be credited to
   * it just for living in the same shared file.
   */
  async function readInputs(): Promise<string[]> {
    const [own, shared] = await Promise.all([
      readFile(join(ROOT, "src", "duties", "respond", "main.ts"), "utf8"),
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
    for (const file of await readdir(join(ROOT, "src", "duties", "respond"))) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(join(ROOT, "src", "duties", "respond", file), "utf8");
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
