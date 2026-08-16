/**
 * The shared eval harness: a local stub for GitHub and the provider, and the
 * one way every duty's bundle gets driven.
 *
 * The pattern is the integration tests' own — spawn `<duty>/dist/index.js`
 * with `INPUT_*` in the environment and everything pointed at a local HTTP
 * stub (`GITHUB_API_URL`, `base-url`), then read `GITHUB_OUTPUT` and
 * `GITHUB_STEP_SUMMARY` back afterwards. What this module adds is routing: an
 * eval driver per duty mounts the routes that duty's run actually calls
 * (issues, comments, labels, git blobs, contents, chat completions) into one
 * server, and serves file contents from the fixture's own directory so a
 * fixture is data rather than a transcript.
 *
 * The request body is read once, up front, and handed to every route — a
 * route decides from `request` + `raw` whether it owns the request and sends
 * its own answer. A request nothing mounted answers gets a 404 the run will
 * fail on, which is exactly the loud failure a harness wants when the fixture
 * is wrong. The completion endpoint is a route like any other, mounted by the
 * driver through `completionRoute`, so model answers are per-fixture data.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

/** A chat completion answer, as the stub sends it. */
export interface Answer {
  readonly status: number;
  readonly payload: unknown;
}

/** One `POST /v1/chat/completions` request, as the stub saw it. */
export interface Ask {
  readonly model: string;
  readonly system: string;
  readonly user: string;
}

/** What a run wrote to `GITHUB_OUTPUT`, parsed out of the heredoc encoding. */
export type Outputs = Record<string, string>;

/** What one spawned run produced. */
export interface Run {
  /** The child's exit code — null when it never returned one. */
  readonly code: number | null;
  /** Both streams, in one string, the way a workflow log would show it. */
  readonly log: string;
  readonly outputs: Outputs;
  /** The job summary page, as GITHUB_STEP_SUMMARY captured it. */
  readonly summary: string;
}

/** One route: owns the request by sending its own answer and returning true. */
export type Route = (
  raw: string,
  request: IncomingMessage,
  response: ServerResponse,
) => boolean | Promise<boolean>;

export interface StubOptions {
  /** Routes checked in order; the first that answers wins. */
  readonly routes: readonly Route[];
  /** The completion answer for each request, after auth. */
  readonly completion: (ask: Ask) => Answer;
  /** The api-key the model endpoint accepts. Missing answers 401. */
  readonly auth?: { readonly apiKey: string };
}

/** A running stub, closed after the fixture's run. */
export interface Stub {
  readonly url: string;
  readonly asked: Ask[];
  close(): Promise<void>;
}

/** Name → fixture file content. The stub's answering source for Contents/tree. */
export type ContentMap = Map<string, { content: string; sha: string }>;

const ROOT = resolve(import.meta.dirname, "..");

/** The deterministic SHA the stub mints for a content string. */
export function shaOf(content: string): string {
  let hash = 2166136261;
  for (let at = 0; at < content.length; at += 1) {
    hash ^= content.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return `sha-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** A normal completion. */
export function saying(content: string): Answer {
  return {
    status: 200,
    payload: {
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
  };
}

function readAll(request: IncomingMessage): Promise<string> {
  return new Promise((resolveAll) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolveAll(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function send(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  response.end(text);
}

/** Parses a request body into the object the stub answers from. */
export function parsed(raw: string): unknown {
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

/** Extracts the system and user message from one completion request. */
export function askOf(raw: string): Ask {
  const payload = parsed(raw) as {
    model?: unknown;
    messages?: { role?: string; content?: string }[];
  };
  const system = payload.messages?.find((message) => message.role === "system")?.content;
  const user = payload.messages?.find((message) => message.role === "user")?.content;
  return { model: String(payload.model), system: system ?? "", user: user ?? "" };
}

/** The completion endpoint, answered by whichever answer the driver mounted. */
export function completionRoute(answer: (ask: Ask) => Answer): Route {
  return (raw, request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (request.method !== "POST" || path !== "/v1/chat/completions") return false;
    const answered = answer(askOf(raw));
    send(response, answered.status, answered.payload);
    return true;
  };
}

/** The git data + contents routes a duty with repository files uses. */
export function repoRoutes(contents: ContentMap): readonly Route[] {
  const findBySha = (sha: string): string | undefined => {
    for (const [, file] of contents) {
      if (file.sha === sha) return file.content;
    }
    return undefined;
  };

  const bySha = (sha: string): string | undefined => {
    // `findBySha` already closes over `contents`; the decodings below put a
    // dot in front of the same lookup, but the SHA itself is never encoded in
    // the path the API sends back.
    return findBySha(sha);
  };

  return [
    (raw, request, response) => {
      if (request.method !== "GET") return false;
      const url = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      // Octokit encodes the `/` inside a ref: `heads/main` -> `heads%2Fmain`.
      // Decoding the whole path turns it back into the shape the API describes.
      const ref = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(url);
      if (ref !== null) {
        send(response, 200, { object: { sha: "main-sha", type: "commit" } });
        return true;
      }
      const tree = /^\/repos\/[^/]+\/[^/]+\/git\/trees\/([^/]+)$/.exec(url);
      if (tree !== null) {
        const query = new URLSearchParams((request.url ?? "").split("?")[1] ?? "");
        const treeSha = tree[1];
        if (query.get("recursive") !== "true") {
          send(response, 200, { sha: treeSha, tree: [] });
          return true;
        }
        const entries = [...contents.entries()].map(([child, file]) => ({
          path: child,
          sha: file.sha,
          type: "blob",
          mode: "100644",
        }));
        send(response, 200, { sha: treeSha, tree: entries });
        return true;
      }
      const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([^/]+)$/.exec(url);
      if (blob !== null) {
        const blobSha = blob[1];
        if (blobSha === undefined) return false;
        const text = bySha(blobSha);
        if (text === undefined) {
          send(response, 404, { message: "Blob Not Found" });
        } else {
          send(response, 200, {
            sha: blobSha,
            size: Buffer.byteLength(text),
            content: Buffer.from(text, "utf8").toString("base64"),
            encoding: "base64",
          });
        }
        return true;
      }
      void raw;
      return false;
    },
    (raw, request, response) => {
      if (request.method !== "GET") return false;
      const url = (request.url ?? "/").split("?")[0] ?? "/";
      const contentsRoute = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url);
      // A raw request object, `any`, error typed, is returned false so a later
      // route (never a later one here) could answer — the specific route
      // decided it was not this one.
      void url;
      if (contentsRoute === null) {
        void raw;
        return false;
      }
      const at = decodeURIComponent(contentsRoute[1] ?? "");
      const file = contents.get(at);
      if (file !== undefined) {
        send(response, 200, {
          name: at.split("/").pop(),
          path: at,
          sha: file.sha,
          content: Buffer.from(file.content, "utf8").toString("base64"),
          encoding: "base64",
        });
        return true;
      }
      const prefix = `${at.replace(/\/+$/, "")}/`;
      const children = [...contents.entries()].filter(([child]) => child.startsWith(prefix));
      if (children.length > 0) {
        send(response, 200, {
          name: at.split("/").pop(),
          path: at,
          tree: children.map(([child, childFile]) => ({
            path: child,
            sha: childFile.sha,
            type: "blob",
          })),
        });
        return true;
      }
      send(response, 404, { message: "Not Found" });
      return true;
    },
  ];
}

/**
 * The routes a run's write side needs: repository metadata, refs (get/create),
 * contents (read with a branch ref, write), and pull requests (list/create/
 * update). Mounted after the read-side routes so a run that never reaches the
 * write side never has to answer them.
 */
export function publishRoutes(contents: ContentMap): readonly Route[] {
  const readPath = (url: string): { content?: string; sha?: string } | null => {
    const suffix = /\/contents\/(.+)$/.exec(url)?.[1];
    if (suffix === undefined) return null;
    const at = decodeURIComponent(suffix);
    const file = contents.get(at);
    if (file === undefined) return null;
    return { content: file.content, sha: file.sha };
  };

  return [
    (raw, request, response) => {
      const method = request.method ?? "?";
      const url = (request.url ?? "/").split("?")[0] ?? "/";

      // Repository metadata: what the default branch is called.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.exec(url) !== null) {
        send(response, 200, { default_branch: "main" });
        return true;
      }

      // A feature-branch ref that exists (the service branch), or the 404 a
      // branch that has not been created yet reads as.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(url) !== null) {
        const ref = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
        if (ref.startsWith("/repos/") && ref.includes("/git/ref/heads/reeve/harmonise/")) {
          send(response, 200, { object: { sha: "branch-sha", type: "commit" } });
        } else {
          send(response, 404, { message: "Not Found" });
        }
        return true;
      }

      // Creating a feature branch.
      if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.exec(url) !== null) {
        send(response, 201, { object: { sha: "branch-sha", type: "commit" } });
        return true;
      }

      // Reading a file on the branch — a row in the trunk the run already saw,
      // so the SHA comes from the same contents the tree route served.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.exec(url) !== null) {
        const found = readPath(url);
        if (found !== null) {
          send(response, 200, { content: found.content, sha: found.sha, encoding: "base64" });
        } else {
          send(response, 404, { message: "Not Found" });
        }
        return true;
      }

      // Writing a file — provenance state on the default branch, or a locale
      // draft on the feature branch.
      if (method === "PUT" && /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.exec(url) !== null) {
        send(response, 200, { content: { sha: "new-file-sha" } });
        return true;
      }

      // Pull request list / create / update.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.exec(url) !== null) {
        send(response, 200, { data: [] });
        return true;
      }
      if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.exec(url) !== null) {
        send(response, 201, { number: 42 });
        return true;
      }
      if (method === "PATCH" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.exec(url) !== null) {
        send(response, 200, { number: 42 });
        return true;
      }

      void raw;
      return false;
    },
  ];
}

export interface Scoped {
  readonly url: string;
  readonly asked: Ask[];
  readonly close: () => Promise<void>;
}

/**
 * Starts the stub server: reads each request body once, walks the mounted
 * routes in order, and answers the completion endpoint with the mounted
 * function after recording every ask.
 */
export async function startStub(options: StubOptions): Promise<Scoped> {
  const { routes, completion, auth = { apiKey: "sk-stub-key" } } = options;
  const asked: Ask[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      const raw = await readAll(request);
      for (const route of routes) {
        if (await route(raw, request, response)) return;
      }
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (request.method === "POST" && path === "/v1/chat/completions") {
        const ask = askOf(raw);
        asked.push(ask);
        if (request.headers.authorization !== `Bearer ${auth.apiKey}`) {
          send(response, 401, { error: { message: "invalid api key" } });
          return;
        }
        const answered = completion(ask);
        send(response, answered.status, answered.payload);
        return;
      }
      const method = request.method ?? "?";
      send(response, 404, { message: `no stub for ${method} ${path}` });
    })();
  });

  await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub server did not open a port");
  }

  const port = address.port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    asked,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      }),
  };
}

/** File paths a spawned run writes its workflow files to. */
export function scratchFiles(scratch: string): { output: string; summary: string } {
  return { output: join(scratch, "outputs"), summary: join(scratch, "summary.md") };
}

/**
 * Drives one bundle: spawns `<duty>/dist/index.js` with the inputs, the stub
 * as the whole world, and reads `GITHUB_OUTPUT`/`GITHUB_STEP_SUMMARY` back.
 * The bundle must already be built — the runner builds it before it ever gets
 * here, so a stale bundle measures whatever was committed rather than the
 * source under review.
 */
export async function runBundle(
  duty: string,
  stubUrl: string,
  inputs: Record<string, string>,
  files: { output: string; summary: string },
  extraEnv: NodeJS.ProcessEnv = {},
  cwd: string = ROOT,
): Promise<Run> {
  await writeFile(files.output, "");
  await writeFile(files.summary, "");

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: "ecoma-io/reeve",
    GITHUB_API_URL: stubUrl,
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_EVENT_NAME: "issues",
    // `harmonise` reads `context.ref` to name the ref its `git.getRef` walks,
    // so every run needs an ordinary branch ref present — the same value a
    // workflow on the default branch has.
    GITHUB_REF: "refs/heads/main",
    ...extraEnv,
  };
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }

  const child = spawn(process.execPath, [join(ROOT, duty, "dist", "index.js")], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (log += chunk));
  child.stderr.on("data", (chunk: string) => (log += chunk));
  const code = await new Promise<number | null>((resolveClose) => child.on("close", resolveClose));

  return {
    code,
    log,
    outputs: readOutputs(await readFile(files.output, "utf8")),
    summary: await readFile(files.summary, "utf8"),
  };
}

/** `GITHUB_OUTPUT` as the runner reads it back. */
function readOutputs(text: string): Outputs {
  const outputs: Outputs = {};
  for (const match of text.matchAll(/^([^\r\n<]+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm)) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) outputs[name] = value;
  }
  return outputs;
}
