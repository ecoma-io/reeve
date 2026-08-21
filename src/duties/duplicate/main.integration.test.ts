/**
 * The duplicate duty, driven the way a runner drives it.
 *
 * Its entry point calls `run()` at import, so it cannot be imported and
 * measured — importing it would run it. What a runner actually does is spawn
 * `duplicate/dist/index.js` with `INPUT_*` in the environment and read
 * `GITHUB_OUTPUT` afterwards, and that is exactly what happens below.
 *
 * It is also the only place this duty's guardrails are exercised end to end.
 * Every one of them is a claim about what the action will not do to somebody's
 * repository — will not comment unless the warrant grants it, will not stack
 * a second opinion under its own first one, will not act on a verdict naming
 * a thread the ranking never offered — and each is enforced in a different
 * module. A unit test can show `parseVerdict` refuses a number;
 * only this can show that nothing downstream published it anyway.
 *
 * Two collaborators are real and one is not. The bundle is real, rebuilt here
 * so a case can never pass against a stale artifact. GitHub and the provider
 * are a local HTTP server — `@actions/github` reads its base URL from
 * `GITHUB_API_URL` and `base-url` is an input, so both point at it and nothing
 * in this file reaches a network or a model.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { fingerprint, markerFor } from "../../core/marker.js";

// A spawn per case, each loading a 3 MB bundle. Comfortably under this, and not
// worth flaking over.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Where this duty is published from: a repository subdirectory of its own. */
const DUTY = join(ROOT, "duplicate");
const BUNDLE = join(DUTY, "dist", "index.js");

/** Long enough, and English enough, to be identified without a model. */
const REPORT =
  "The dark mode toggle does not persist after a page reload; it should be written to local storage.";
/** The same report, in Vietnamese — diacritical enough to be told from `REPORT` by script alone. */
const VIETNAMESE_REPORT =
  "Nút chuyển chế độ tối không lưu lại sau khi tải lại trang, tôi nghĩ nó nên được ghi vào bộ nhớ cục bộ.";

/**
 * A warrant granting this duty its one capability. No `labels:` block — this
 * duty has no taxonomy to check names against, and an absent block is an empty
 * taxonomy rather than an error. `languages:` is likewise absent, so detection
 * reads this duty's documented default (`en, vi, zh`).
 */
const WARRANT = ["version: 1", "duties:", "  duplicate: [comment]"].join("\n");

beforeAll(async () => {
  // Built rather than assumed: CI runs `pnpm test` before `pnpm build`, so a
  // case driving the committed bundle would be driving whatever was committed
  // last rather than the source under review.
  //
  // Only this duty's bundle is rebuilt, and never anyone else's: the
  // integration tests run in parallel workers, and two of them rebuilding the
  // same outfile at once could hand a spawned child a half-written bundle to
  // crash on — esbuild writes an outfile in place rather than atomically.
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs"), "duplicate"], {
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
}

interface Answer {
  readonly status: number;
  readonly payload: unknown;
}

/**
 * One entry in the open-issue listing the stub serves, newest created first —
 * the order this suite has to hand it in, since the stub serves it back
 * verbatim rather than sorting it. The same listing answers both the corpus
 * (`listCorpus`, which excludes the thread being checked itself) and a sweep's
 * backlog (`listOpenThreads`) — on GitHub they are the identical endpoint.
 */
interface ListedIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  /** Present, and true, only for the entries both listings must skip as a pull request. */
  readonly pullRequest?: boolean;
}

/** One comment as the stub holds it — real state, because idempotency reads it back. */
interface StoredComment {
  readonly id: number;
  body: string;
  /** Bot by default — the same identity `GITHUB_TOKEN` posts under. A case names a human explicitly to exercise `findMarked`'s author check. */
  readonly user?: { readonly login?: string; readonly type?: string };
}

/** Everything a request is answered from, and everything a case may change. */
interface State {
  /** Whether the thread this run reads is a pull request. */
  isPullRequest: boolean;
  title: string;
  body: string;
  /** The open backlog and the corpus, in one list — see `ListedIssue`. */
  issues: ListedIssue[];
  /**
   * The thread's comments, mutable and with distinct ids, unlike triage's
   * write-only effects log: `postOrReplace` reads them back to find its own
   * marker, so the stub has to actually keep them for idempotency to be
   * exercised rather than assumed.
   */
  readonly comments: StoredComment[];
  nextCommentId: number;
  answer: (ask: Ask) => Answer;
  readonly asked: Ask[];
  /** Everything the run wrote to the thread, in the order it wrote it. */
  readonly effects: { created: string[]; updated: { id: number; body: string }[] };
  /** A status posting the comment fails with, instead of the comment landing. */
  postStatus: number | null;
}

type Stub = State & { readonly url: string; close(): Promise<void> };

/** A completion the provider answered normally. */
function saying(content: string): Answer {
  return {
    status: 200,
    payload: {
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
  };
}

/** A verdict, in the shape the judge's prompt asks for. */
function verdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    duplicate_of: 7,
    confidence: 0.9,
    rationale: "Both describe the dark mode toggle failing to persist.",
    ...over,
  });
}

/**
 * An endpoint that answers this duty's stages and nothing else.
 *
 * Keyed on the system message, so a case can tell the stages apart: the pivot
 * bridge asks for a translation and the judge asks for JSON. `translation` is
 * what the bridge gets when a case expects it to run; the default — prose no
 * JSON parser reads — is how a case starves the bridge without touching the
 * judge, since a translation that fails to parse degrades rather than fails.
 * Detection never reaches a model in this suite: `en` and `vi` are told apart
 * by script and profile alone, the same free path triage's own cases rely on.
 */
function judging(
  answer: string,
  translation: { title: string; body: string } | null = null,
): (ask: Ask) => Answer {
  return (ask) =>
    ask.system.includes("Translate the title and body")
      ? saying(translation === null ? "no translation for you" : JSON.stringify(translation))
      : saying(answer);
}

async function startStub(): Promise<Stub> {
  const state: State = {
    isPullRequest: false,
    title: "Dark mode resets on reload",
    body: REPORT,
    issues: [
      {
        number: 7,
        title: "Dark mode setting is lost between sessions",
        body: "The dark mode toggle forgets its state after a page reload; it should persist to local storage.",
        createdAt: "2026-01-05T00:00:00Z",
      },
    ],
    comments: [],
    nextCommentId: 1,
    answer: judging(verdict()),
    asked: [],
    effects: { created: [], updated: [] },
    postStatus: null,
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

  // The thread being checked, as `readStanding` fetches it.
  const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
  if (method === "GET" && issue) {
    send(response, 200, {
      number: Number(issue[1]),
      title: stub.title,
      body: stub.body,
      labels: [],
      state: "open",
      // GitHub marks a pull request by the PRESENCE of this key, which is what
      // `forge.ts:530` reads. Absent by default, so every case above still
      // drives an issue.
      ...(stub.isPullRequest ? { pull_request: { url: "https://example.test/pr" } } : {}),
    });
    return;
  }

  // The open-issue listing — the corpus and a sweep's backlog alike. `page` is
  // honoured so the corpus's own paging loop terminates; every case in this
  // suite fits on page one, and pagination itself is exercised in isolation
  // against `listCorpus` in `corpus.test.ts`.
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
    const page = Number(query.get("page") ?? "1");
    send(
      response,
      200,
      page === 1
        ? stub.issues.map((candidate) => ({
            number: candidate.number,
            title: candidate.title,
            body: candidate.body,
            labels: [],
            created_at: candidate.createdAt,
            ...(candidate.pullRequest === true ? { pull_request: {} } : {}),
          }))
        : [],
    );
    return;
  }

  // The comment listing `findMarked` searches for this duty's own marker.
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path)) {
    const page = Number(query.get("page") ?? "1");
    send(
      response,
      200,
      (page === 1 ? stub.comments : []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: comment.user ?? { type: "Bot" },
      })),
    );
    return;
  }

  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path)) {
    if (stub.postStatus !== null) {
      send(response, stub.postStatus, { message: "the comment was refused" });
      return;
    }
    const payload = parsed(raw) as { body?: string };
    const body = payload.body ?? "";
    const id = stub.nextCommentId;
    stub.nextCommentId += 1;
    stub.comments.push({ id, body, user: { type: "Bot" } });
    stub.effects.created.push(body);
    send(response, 201, { id, body });
    return;
  }

  const comment = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
  if (method === "PATCH" && comment) {
    const id = Number(comment[1]);
    const payload = parsed(raw) as { body?: string };
    const existing = stub.comments.find((entry) => entry.id === id);
    if (existing === undefined) {
      send(response, 404, { message: `no comment ${String(id)}` });
      return;
    }
    existing.body = payload.body ?? "";
    stub.effects.updated.push({ id, body: existing.body });
    send(response, 200, { id, body: existing.body });
    return;
  }

  if (method === "POST" && path === "/v1/chat/completions") {
    const ask = askOf(raw);
    stub.asked.push(ask);
    const answered = stub.answer(ask);
    send(response, answered.status, answered.payload);
    return;
  }

  send(response, 404, { message: `no stub for ${method} ${path}` });
}

function askOf(raw: string): Ask {
  const payload = parsed(raw) as {
    model?: unknown;
    messages?: { role?: string; content?: string }[];
  };
  const system = payload.messages?.find((message) => message.role === "system")?.content;
  const user = payload.messages?.find((message) => message.role === "user")?.content;
  return { model: String(payload.model), system: system ?? "", user: user ?? "" };
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
  /** Both streams, in one string: workflow commands go to stdout, and a crash
   *  that never reached `setFailed` goes to stderr. */
  readonly log: string;
  readonly outputs: Record<string, string>;
  /** The job summary page, as the runner would render it. */
  readonly summary: string;
}

/**
 * One consumer's settings — deliberately not a copy of `action.yml`'s defaults,
 * which the runner supplies and this file never sees. A case names only what it
 * changes. The base warrant grants `comment`, and cases that care about the
 * grant swap in a warrant that withholds it; `languages` is not an input at all
 * — the warrant's own `languages:` key, or this duty's documented default
 * (`en, vi, zh`), answers detection.
 */
function baseInputs(stub: Stub, warrant: string): Record<string, string> {
  return {
    "github-token": "stub-token",
    number: "42",
    "base-url": `${stub.url}/v1`,
    "api-key": "sk-stub-key",
    models: "stub-model",
    warrant,
    confidence: "0.75",
    candidates: "5",
    "corpus-limit": "none",
    "corpus-since": "",
    "max-body-chars": "6000",
    "show-attribution": "none",
    "dry-run": "false",
    sweep: "false",
    since: "",
    limit: "50",
    endpoints: "",
    "api-keys": "",
    "request-timeout": "120s",
    temperature: "",
  };
}

/** The warrant a case runs against, written where the run can read it. */
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
  const settings = { ...baseInputs(stub, warrantPath), ...inputs };
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

/** The one ask that reached the judge, told from the other stages by its own prompt. */
function judgeAsk(stub: Stub): Ask | undefined {
  return stub.asked.find((ask) =>
    ask.system.includes("checking whether a new GitHub issue repeats"),
  );
}

// ---------------------------------------------------------------------------

let stub: Stub;

beforeEach(async () => {
  stub = await startStub();
  scratch = await mkdtemp(join(tmpdir(), "reeve-duplicate-"));
  warrantPath = join(scratch, "reeve.yml");
  await writeFile(warrantPath, WARRANT);
});

afterEach(async () => {
  await stub.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("the action", () => {
  it("reports the duplicate it found on every output, and touches nothing, when the warrant grants it nothing", async () => {
    // Unlike triage there is no capability this duty is granted for free —
    // report-only is the shape a repository gets before it opts into anything,
    // now spelled by a `duties:` block that drains `duplicate` on purpose.
    await writeFile(warrantPath, ["version: 1", "duties:", "  duplicate: [none]"].join("\n"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.created).toEqual([]);
    expect(stub.effects.updated).toEqual([]);
    expect(run.outputs).toEqual({
      "duplicate-of": "7",
      score: "0.90",
      language: "English",
      commented: "false",
      starved: "false",
      skipped: "0",
      "budget-exhausted": "false",
      processed: "0",
      remaining: "0",
    });
    expect(run.summary).toContain("Proposed as a duplicate of #7.");
    expect(run.summary).toContain(
      "Nothing was posted — the warrant does not grant `comment`. `duplicate-of` and `score` still carry it.",
    );
  });

  it("posts the comment the warrant grants, and never posts it twice", async () => {
    const first = await runAction(stub);

    expect(first.code).toBe(0);
    expect(first.outputs.commented).toBe("true");
    expect(stub.effects.created).toHaveLength(1);
    expect(stub.effects.created[0]).toContain("<!-- reeve:duplicate source=");
    // The marker itself carries the machine-readable duplicate-of=N payload,
    // not just the prose sentence beneath it.
    expect(stub.effects.created[0]).toMatch(/<!-- reeve:duplicate source=\S+ duplicate-of=7 -->/);
    expect(stub.effects.created[0]).toContain("Possible duplicate of #7.");
    // The machine-attribution floor: whatever `show-attribution` says, the
    // comment always admits a model proposed this.
    expect(stub.effects.created[0]).toContain("Proposed by a model, not decided by a maintainer");

    const again = await runAction(stub);

    expect(again.code).toBe(0);
    // The identical rerun reached the identical fingerprint: nothing was
    // created, nothing was updated, and the thread still carries one comment.
    expect(stub.effects.created).toHaveLength(1);
    expect(stub.effects.updated).toEqual([]);
    expect(stub.comments).toHaveLength(1);
    expect(again.summary).toContain("Left its own previous comment unchanged");
  });

  it("reports the duplicate but withholds the comment the warrant does not grant", async () => {
    // `[none]` is how a warrant grants nothing explicitly — a bare `[]` is
    // refused red as a probable mistake, which `warrant.test.ts` covers.
    await writeFile(warrantPath, WARRANT.replace("duplicate: [comment]", "duplicate: [none]"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.effects.created).toEqual([]);
    expect(run.outputs["duplicate-of"]).toBe("7");
    expect(run.outputs.commented).toBe("false");
    // The grant lives in the one place now: an explicit `[none]` is what asks
    // for `comment` where the file gives nothing. `main.ts` names that file
    // and that refusal in its own message — this case is about the conduit.
    expect(run.summary).toContain(
      "Nothing was posted — the warrant does not grant `comment`. `duplicate-of` and `score` still carry it.",
    );
  });

  it("grants duplicate nothing, spends no model call, and says why, when a written block does not name it", async () => {
    await writeFile(warrantPath, ["version: 1", "duties:", "  triage: [label]"].join("\n"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(stub.effects.created).toEqual([]);
    expect(run.outputs["duplicate-of"]).toBe("");
    expect(run.outputs.commented).toBe("false");
    expect(run.summary).toContain(
      `\`${warrantPath}\`'s \`duties:\` block does not name \`duplicate\`; once that block ` +
        "exists it is the whole answer, so add `duplicate: [comment]` to it (or remove the block " +
        "to return to defaults).",
    );
    expect(run.summary).toContain("No expensive model was asked anything.");
  });

  it("reaches a candidate written in another language through the pivot bridge", async () => {
    stub.title = "Không thể bật chế độ tối";
    stub.body = VIETNAMESE_REPORT;
    // The corpus's one candidate is English, so the thread's own Vietnamese
    // words would never rank it — only the bridged query can.
    stub.answer = judging(verdict(), {
      title: "Dark mode toggle does not persist",
      body: "The dark mode toggle does not persist after a page reload; it should be written to local storage.",
    });

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked.some((ask) => ask.system.includes("Translate the title and body"))).toBe(
      true,
    );
    expect(run.outputs["duplicate-of"]).toBe("7");
    expect(run.outputs.language).toBe("Tiếng Việt");
    expect(run.log).toContain(
      "Bridged the query into English to compare against candidates written in other languages.",
    );
    expect(run.summary).toContain("Bridged the query into English");
  });

  it("degrades to same-language matching when the pivot bridge cannot translate", async () => {
    stub.title = "Không thể bật chế độ tối";
    stub.body = VIETNAMESE_REPORT;
    // One candidate in each language. The English one is what makes the
    // bridge worth attempting; the Vietnamese one is what the run can still
    // match once the bridge's answer comes back unreadable.
    stub.issues = [
      {
        number: 9,
        title: "Chế độ tối không được lưu giữa các phiên",
        body: "Nút chuyển chế độ tối không lưu lại sau khi tải lại trang; nên ghi nó vào bộ nhớ cục bộ.",
        createdAt: "2026-01-06T00:00:00Z",
      },
      {
        number: 7,
        title: "Dark mode setting is lost between sessions",
        body: "The dark mode toggle forgets its state after a page reload; it should persist to local storage.",
        createdAt: "2026-01-05T00:00:00Z",
      },
    ];
    // `judging`'s default translation is prose no JSON parser reads — the
    // bridge fails to parse it and degrades, rather than failing the run.
    // Report-only on purpose: nothing is posted whether or not the bridge
    // succeeds, so the shape this guards is the decision itself.
    stub.answer = judging(verdict({ duplicate_of: 9 }));
    await writeFile(warrantPath, ["version: 1", "duties:", "  duplicate: [none]"].join("\n"));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.log).toContain(
      "Cross-language matching could not translate this thread into the pivot language this " +
        "run — matching used the thread's own language only.",
    );
    expect(run.outputs["duplicate-of"]).toBe("9");
    expect(stub.effects.created).toEqual([]);
  });

  it("rotates past a model out of capacity and still delivers the verdict", async () => {
    // D12: capacity is weather. The first model's 429 grounds it for the run;
    // the second answers, so the run is an ordinary green one, not a starved
    // one.
    stub.answer = (ask) =>
      ask.model === "stub-model-a"
        ? { status: 429, payload: { error: { message: "out of quota" } } }
        : judging(verdict())(ask);

    const run = await runAction(stub, { models: "stub-model-a, stub-model-b" });

    expect(run.code).toBe(0);
    expect(stub.asked.map((ask) => ask.model)).toEqual(["stub-model-a", "stub-model-b"]);
    expect(run.outputs["duplicate-of"]).toBe("7");
    expect(run.outputs.starved).toBe("false");
    expect(run.log).toContain("duplicate: stub-model-a");
    expect(run.log).toContain("429");
  });

  it("fails red the instant a model reports an authentication problem, asking no other", async () => {
    // D12's other half: an auth failure is a broken configuration, not
    // weather, so it stops the run immediately rather than rotating past it —
    // the same key is wrong for both models.
    stub.answer = () => ({ status: 401, payload: { error: { message: "invalid api key" } } });

    const run = await runAction(stub, { models: "stub-model-a, stub-model-b" });

    expect(run.code).not.toBe(0);
    expect(stub.asked).toHaveLength(1);
    expect(stub.effects.created).toEqual([]);
    expect(run.log).toContain("HTTP 401: invalid api key");
  });

  it("changes nothing on a dry run, and reports what it would have done", async () => {
    const run = await runAction(stub, { "dry-run": "true" });

    expect(run.code).toBe(0);
    expect(stub.effects.created).toEqual([]);
    expect(stub.effects.updated).toEqual([]);
    expect(run.outputs["duplicate-of"]).toBe("7");
    expect(run.outputs.score).toBe("0.90");
    expect(run.outputs.commented).toBe("false");
    expect(run.summary).toContain("— **dry run**, nothing was applied");
    // M3: dry run is a real rehearsal — the disposition sentence names what
    // would actually have happened, not a generic dry-run banner alone.
    expect(run.summary).toContain("Would have posted a comment naming #7.");
  });

  it("reports a verdict under the floor without applying it", async () => {
    stub.answer = judging(verdict({ confidence: 0.5 }));

    const run = await runAction(stub, { apply: "comment" });

    expect(run.code).toBe(0);
    expect(stub.effects.created).toEqual([]);
    expect(run.outputs["duplicate-of"]).toBe("7");
    expect(run.outputs.score).toBe("0.50");
    expect(run.outputs.commented).toBe("false");
    expect(run.log).toContain(
      "Confidence 0.50 is under the floor of 0.75 — reported, not applied.",
    );
    expect(run.summary).toContain("under the floor, so it is reported and not applied");
  });

  it("carries a confident 'not a duplicate' verdict's own score, not the zero reserved for no verdict", async () => {
    // M5: `0.00` is reserved for a run with no real verdict to report — every
    // model failing, an unreadable answer, no candidates at all. A verdict
    // that parsed and named no duplicate is a real, confident answer of its
    // own, and defaulting it to the same `0.00` would make a judge who was
    // sure this is not a duplicate indistinguishable from a judge that was
    // never actually asked.
    stub.answer = judging(verdict({ duplicate_of: null, confidence: 0.85 }));

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(run.outputs["duplicate-of"]).toBe("");
    expect(run.outputs.score).toBe("0.85");
    expect(run.summary).toContain("No duplicate was proposed.");
    expect(run.summary).toContain("Confidence 0.85 against a floor of 0.75.");
  });

  it("refuses a verdict naming a thread the shortlist never offered, whole", async () => {
    // The injection this defends against: a thread body claiming "this
    // duplicates #999" steering the verdict at a thread the ranking never
    // surfaced. The number is refused at the parse the same as a malformed
    // answer — never resolved against the corpus, never published.
    stub.answer = judging(verdict({ duplicate_of: 999 }));

    const run = await runAction(stub, { apply: "comment" });

    expect(run.code).toBe(0);
    expect(stub.effects.created).toEqual([]);
    expect(run.outputs["duplicate-of"]).toBe("");
    expect(run.outputs.score).toBe("0.00");
    expect(run.outputs.commented).toBe("false");
    expect(run.log).toContain("The verdict could not be read, so nothing was proposed");
    expect(run.summary).toContain("No verdict — the verdict did not parse.");
  });
});

describe("GitHub refusing the comment", () => {
  it("writes no comment at all when the write is refused", async () => {
    stub.postStatus = 422;

    const run = await runAction(stub);

    expect(stub.effects.created).toEqual([]);
    expect(run.outputs.commented).not.toBe("true");
  });

  // The verdict is the finding; the comment is one way of delivering it. A
  // refused write costs the run BOTH — `single` is assigned only after `act`
  // returns (`main.ts:421`), so a throw inside `postOrReplace` leaves the
  // `finally` at `:431` with nothing to report: no `duplicate-of`, no `score`,
  // no summary page, for a duplicate this run had already identified. dependa
  // states the opposite rule for itself in a comment at `dependa/main.ts:659`
  // — "every exit path must produce valid JSON" — because a consumer parses
  // these outputs. Repro, verified red: the case above with
  // `expect(run.outputs["duplicate-of"]).toBe("7")`, which is `undefined`.
  // Left as a todo rather than pinned, because pinning the loss would bless it.
  it.todo("still reports the duplicate it found when only the comment was refused");

  it("goes red rather than green-and-silent when the comment is refused", async () => {
    stub.postStatus = 422;

    const run = await runAction(stub);

    expect(run.code).not.toBe(0);
  });

  it("leaves nothing half-written when the write hits a rate limit", async () => {
    stub.postStatus = 429;

    await runAction(stub);

    expect(stub.effects.created).toEqual([]);
    expect(stub.effects.updated).toEqual([]);
    expect(stub.comments).toEqual([]);
  });
});

describe("the corpus and the shortlist", () => {
  /** One corpus entry that shares its words with `REPORT`, so BM25 ranks it. */
  function alike(number: number, createdAt: string): ListedIssue {
    return { number, title: `Thread ${String(number)}`, body: REPORT, createdAt };
  }

  it("offers the judge only `candidates` of the ranking, and refuses a verdict outside them", async () => {
    // Six identically-worded candidates: every score ties, so the ranking
    // falls back to thread number descending and the shortlist is exactly the
    // two newest numbers.
    stub.issues = [
      alike(15, "2026-01-06T00:00:00Z"),
      alike(14, "2026-01-05T00:00:00Z"),
      alike(13, "2026-01-04T00:00:00Z"),
      alike(12, "2026-01-03T00:00:00Z"),
      alike(11, "2026-01-02T00:00:00Z"),
      alike(10, "2026-01-01T00:00:00Z"),
    ];
    stub.answer = judging(verdict({ duplicate_of: 15 }));

    const run = await runAction(stub, { candidates: "2" });

    expect(run.code).toBe(0);
    expect(run.outputs["duplicate-of"]).toBe("15");
    expect(run.summary).toContain("2 of 6 open threads reached the judge.");
    const asked = judgeAsk(stub);
    expect(asked?.user).toContain("#15:");
    expect(asked?.user).toContain("#14:");
    expect(asked?.user).not.toContain("#13:");
  });

  it("stops listing the corpus at `corpus-limit`, newest created first", async () => {
    stub.issues = [
      alike(15, "2026-01-06T00:00:00Z"),
      alike(14, "2026-01-05T00:00:00Z"),
      alike(13, "2026-01-04T00:00:00Z"),
      alike(12, "2026-01-03T00:00:00Z"),
      alike(11, "2026-01-02T00:00:00Z"),
      alike(10, "2026-01-01T00:00:00Z"),
    ];
    stub.answer = judging(verdict({ duplicate_of: 15 }));

    const run = await runAction(stub, { "corpus-limit": "3" });

    expect(run.code).toBe(0);
    expect(run.outputs["duplicate-of"]).toBe("15");
    expect(run.summary).toContain("3 of 3 open threads reached the judge.");
    expect(judgeAsk(stub)?.user).not.toContain("#12:");
  });

  it("keeps only corpus threads created on or after `corpus-since`", async () => {
    stub.issues = [
      alike(20, "2026-02-01T00:00:00Z"),
      alike(21, "2026-01-15T00:00:00Z"),
      alike(22, "2025-05-01T00:00:00Z"),
    ];
    stub.answer = judging(verdict({ duplicate_of: 20 }));

    const run = await runAction(stub, { "corpus-since": "2026-01-01" });

    expect(run.code).toBe(0);
    expect(run.outputs["duplicate-of"]).toBe("20");
    expect(run.summary).toContain("2 of 2 open threads reached the judge.");
    expect(judgeAsk(stub)?.user).not.toContain("#22:");
  });

  it("reads only `max-body-chars` of the body, and says the tail was left behind", async () => {
    // `REPORT` fits inside the first hundred characters, so ranking still
    // works; the tail carries a word nothing else does, so where it did or
    // did not reach is observable in the judge's own prompt.
    stub.body = `${REPORT}\n${"padding ".repeat(30)}The tail mentions the macguffin.`;

    const run = await runAction(stub, { "max-body-chars": "100" });

    expect(run.code).toBe(0);
    expect(run.outputs["duplicate-of"]).toBe("7");
    expect(run.log).toContain(
      "Only the first 100 characters of the body were read. Raise `max-body-chars`, or set it " +
        "to `none`, to read the rest.",
    );
    expect(judgeAsk(stub)?.user).not.toContain("macguffin");
  });

  it("reads the whole body when `max-body-chars` is `none`", async () => {
    stub.body = `${REPORT}\n${"padding ".repeat(30)}The tail mentions the macguffin.`;

    const run = await runAction(stub, { "max-body-chars": "none" });

    expect(run.code).toBe(0);
    expect(run.log).not.toContain("characters of the body were read");
    expect(judgeAsk(stub)?.user).toContain("macguffin");
  });
});

describe("the sweep", () => {
  /** One entry in the backlog, sharing its words with the rest so ranking works. */
  function candidate(number: number, createdAt: string): ListedIssue {
    return { number, title: `Thread ${String(number)}`, body: REPORT, createdAt };
  }

  /**
   * `sweep: true` needs `number` cleared — `baseInputs` sets `number: "42"` for
   * the single-thread suite above, and `readShared` refuses the two together.
   */
  function sweepInputs(over: Record<string, string> = {}): Record<string, string> {
    return { sweep: "true", number: "", ...over };
  }

  it("walks the backlog within `since` and `limit`, and counts what it left behind", async () => {
    stub.issues = [
      candidate(201, "2026-01-10T00:00:00Z"),
      candidate(202, "2026-01-05T00:00:00Z"),
      candidate(203, "2025-06-01T00:00:00Z"),
    ];
    // Processing #201, the corpus is every other open issue — #202 and #203 —
    // so the verdict names one of those.
    stub.answer = judging(verdict({ duplicate_of: 202 }));
    // A `duties:` block that grants `duplicate` nothing is the report-only
    // shape — the walk still decides and reports, and nothing is posted.
    await writeFile(warrantPath, ["version: 1", "duties:", "  duplicate: [none]"].join("\n"));

    const run = await runAction(stub, sweepInputs({ since: "2026-01-01", limit: "1" }));

    expect(run.code).toBe(0);
    // `since` leaves two candidates, `limit` processes one of them. There is
    // no idempotent skip in this duty's sweep — every candidate the walk
    // reaches is processed.
    expect(run.outputs.processed).toBe("1");
    expect(run.outputs.remaining).toBe("1");
    expect(run.outputs.starved).toBe("false");
    expect(run.summary).toContain("| #201 |");
    expect(run.summary).not.toContain("| #203 |");
    // `[none]` grants nothing, so the verdict was reported, not posted.
    expect(run.summary).toContain("proposed #202, not applied");
    expect(stub.effects.created).toEqual([]);
  });

  it("refuses `sweep` combined with `number`, before spending anything", async () => {
    const run = await runAction(stub, { sweep: "true" });

    expect(run.code).not.toBe(0);
    expect(run.log).toContain("sweep: cannot be combined with `number`");
    expect(stub.asked).toHaveLength(0);
  });

  it("reports starvation in the job summary when the roster runs dry deciding the last thread the walk reaches", async () => {
    // M4: the loop's pre-check only catches the roster running dry *before* a
    // thread is decided — it cannot catch capacity running out grounding the
    // one thread `limit` was always going to stop the walk at, because
    // there is no further iteration left to run that check on. Two
    // candidates so the corpus decide() ranks against is non-empty, `limit`
    // of `1` so only the newest is ever processed, and every model call
    // fails on capacity so the single configured model grounds partway
    // through that one decision.
    stub.issues = [candidate(601, "2026-01-10T00:00:00Z"), candidate(602, "2026-01-05T00:00:00Z")];
    stub.answer = () => ({ status: 429, payload: { error: { message: "out of quota" } } });

    const run = await runAction(stub, sweepInputs({ limit: "1" }));

    expect(run.code).toBe(0);
    expect(run.outputs.processed).toBe("1");
    // The `starved` output was already honest — recomputed fresh in `run`'s
    // own `finally` block rather than trusted from the accumulator — which is
    // exactly why this bug was invisible to a workflow reading it and only
    // visible in the job summary a maintainer actually reads.
    expect(run.outputs.starved).toBe("true");
    expect(run.summary).toContain("The roster ran out of capacity partway through");
  });

  it("stops a sweep before listing anything when a written block does not name this duty", async () => {
    await writeFile(warrantPath, ["version: 1", "duties:", "  triage: [label]"].join("\n"));
    stub.issues = [candidate(301, "2026-01-10T00:00:00Z")];

    const run = await runAction(stub, sweepInputs());

    expect(run.code).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(run.outputs.processed).toBe("0");
    expect(run.outputs.remaining).toBe("0");
    expect(run.summary).toContain("## Reeve · duplicate — sweep");
    expect(run.summary).toContain("does not name `duplicate`");
  });
});

describe("the action contract", () => {
  /**
   * Every input `action.yml` declares, read straight out of it.
   *
   * A regex rather than the YAML parser this repository now carries: that one is
   * bundled into the duties to read a warrant at runtime, and reaching for it
   * here would make this suite agree with itself about a file it is checking.
   * The shape being read is two levels deep and fully indented — every input is
   * a key at exactly two spaces inside the `inputs:` block.
   */
  async function declaredInputs(): Promise<string[]> {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");
    const block = /\ninputs:\n([\s\S]*?)\noutputs:\n/.exec(text)?.[1] ?? "";
    return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(([, name]) => name ?? "");
  }

  /**
   * Every input the duty actually reads — its own, and the ones it inherits.
   *
   * Both files, because the shared inputs are read once in the core and
   * declared once per duty: a duty that dropped `api-key` from its `action.yml`
   * would still read it, and nothing else would notice.
   */
  async function readInputs(): Promise<string[]> {
    const sources = await Promise.all([
      readFile(join(ROOT, "src", "duties", "duplicate", "main.ts"), "utf8"),
      readFile(join(ROOT, "src", "core", "inputs.ts"), "utf8"),
    ]);
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
});

// ---------------------------------------------------------------------------
// The Reeve-proposal recursion guard (`main.ts:483`).
//
// Reeve judging its own proposal pull request as a duplicate — and commenting
// to say so — is the infinite-loop failure mode: the comment is a change, the
// change wakes the next run. `main.ts` notes the sweep's own listing already
// filters the PR out, and that the `number:` path has no listing to filter,
// so the guard is checked again in the one place both paths call through. An
// auditor replaced it with `false` in this duty and two others at once, and
// the whole repository stayed green.
// ---------------------------------------------------------------------------

/** A body carrying `propose`'s marker — what Reeve's own proposal PR looks like. */
function proposalBody(): string {
  return `A proposal.\n\n${markerFor("propose").render(fingerprint("proposal", ["duplicate"]))}`;
}

describe("the Reeve-proposal recursion guard", () => {
  it("comments nothing on Reeve's own proposal pull request", async () => {
    stub.isPullRequest = true;
    stub.body = proposalBody();

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.comments).toEqual([]);
    // And it does not spend a model request finding that out.
    expect(stub.asked).toEqual([]);
  });

  it("names the reason rather than reporting an ordinary skip", async () => {
    stub.isPullRequest = true;
    stub.body = proposalBody();

    const run = await runAction(stub);

    expect(run.log + run.summary).toContain("proposal pull request");
  });

  it("still judges an ordinary pull request that carries no proposal marker", async () => {
    // The control for the two above: the guard must recognise its OWN pull
    // request, not stand down on every one.
    stub.isPullRequest = true;

    const run = await runAction(stub);

    expect(run.code).toBe(0);
    expect(stub.asked.length).toBeGreaterThan(0);
  });
});
