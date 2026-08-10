import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createProvider, rotateModels, type Completion } from "./provider.js";

/**
 * The provider against a real socket.
 *
 * The unit tests replace `fetch`, which proves the verdicts and proves nothing
 * about the request ever reaching a wire in the shape they assert. Here the
 * peer is an ordinary HTTP server on localhost — no model, no key, no quota —
 * and what it received is read back off it. A header Reeve forgets to
 * send is invisible to a stub and fatal in production.
 */

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let server: Server | undefined;
const sockets = new Set<Socket>();
const received: Received[] = [];

type Respond = (status: number, body: string, contentType?: string) => void;
type Handler = (received: Received, respond: Respond) => void;

/** Starts a server for one test and returns the base url to configure. */
async function serving(handle: Handler): Promise<string> {
  const started = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Received = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(entry);
      handle(entry, (status, body, contentType = "application/json") => {
        response.writeHead(status, { "content-type": contentType });
        response.end(body);
      });
    });
  });

  started.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    started.listen(0, "127.0.0.1", resolve);
  });
  server = started;

  const address = started.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}/v1`;
}

afterEach(async () => {
  received.length = 0;
  // A test that leaves a request hanging on purpose also leaves a socket the
  // server will wait on forever.
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  const running = server;
  server = undefined;
  if (running) {
    await new Promise<void>((resolve) => {
      running.close(() => {
        resolve();
      });
    });
  }
});

function completion(content: string, usage?: Record<string, number>): string {
  return JSON.stringify({
    id: "chatcmpl-local",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage }),
  });
}

function bodyOf(entry: Received): Record<string, unknown> {
  const parsed: unknown = JSON.parse(entry.body);
  return parsed as Record<string, unknown>;
}

describe("the provider against a real endpoint", () => {
  it("completes a round trip and sends what the protocol expects", async () => {
    const baseUrl = await serving((_entry, respond) => {
      respond(200, completion("Xin chào"));
    });

    const answer = await createProvider({ baseUrl, apiKey: "sk-local" }).complete("local-model", [
      { role: "system", content: "Translate." },
      { role: "user", content: "Hello" },
    ]);

    expect(answer).toEqual({
      ok: true,
      model: "local-model",
      content: "Xin chào",
      finishReason: "stop",
      // This endpoint sends no `usage`, which is the ordinary case for the
      // gateways this project is built for and is reported rather than guessed.
      usage: null,
    });

    const [entry] = received;
    expect(entry?.method).toBe("POST");
    expect(entry?.url).toBe("/v1/chat/completions");
    expect(entry?.headers.authorization).toBe("Bearer sk-local");
    expect(entry?.headers["content-type"]).toBe("application/json");
    expect(entry && bodyOf(entry)).toEqual({
      model: "local-model",
      messages: [
        { role: "system", content: "Translate." },
        { role: "user", content: "Hello" },
      ],
      stream: false,
    });
  });

  it("sends no authorization header at all to a keyless endpoint", async () => {
    const baseUrl = await serving((_entry, respond) => {
      respond(200, completion("ok"));
    });

    await createProvider({ baseUrl, apiKey: "" }).complete("m", [{ role: "user", content: "hi" }]);

    expect(received[0]?.headers).not.toHaveProperty("authorization");
  });

  it("carries non-ASCII prose intact in both directions", async () => {
    // The source text is the reason: an issue body is routinely Vietnamese or
    // Chinese, and a length header counted in characters truncates it.
    const source = "Chế độ tối không được giữ lại — 深色模式没有保留";
    const baseUrl = await serving((entry, respond) => {
      const messages = bodyOf(entry).messages as { content: string }[];
      respond(200, completion(messages[0]?.content ?? ""));
    });

    const answer = await createProvider({ baseUrl, apiKey: "" }).complete("m", [
      { role: "user", content: source },
    ]);

    expect(answer).toMatchObject({ ok: true, content: source });
  });

  it("reports a gateway's HTML error page as a failure rather than as content", async () => {
    const baseUrl = await serving((_entry, respond) => {
      respond(502, "<html><head><title>502 Bad Gateway</title></head></html>", "text/html");
    });

    const answer = await createProvider({ baseUrl, apiKey: "" }).complete("m", [
      { role: "user", content: "hi" },
    ]);

    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.reason).toContain("502 Bad Gateway");
  });

  it("reports an error body that arrived with a 200 as a failure", async () => {
    const baseUrl = await serving((_entry, respond) => {
      respond(200, JSON.stringify({ error: { message: "daily quota exhausted" } }));
    });

    const answer = await createProvider({ baseUrl, apiKey: "" }).complete("free", [
      { role: "user", content: "hi" },
    ]);

    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.reason).toContain("daily quota exhausted");
  });

  it("gives up on an endpoint that accepts the request and never answers", async () => {
    // The failure with no error to read: the connection is fine, the provider
    // simply never replies. Without a deadline this holds the job until the
    // runner's own limit kills it, hours later, with nothing posted.
    const baseUrl = await serving(() => {
      /* accept the request, answer nothing */
    });

    const answer = await createProvider({ baseUrl, apiKey: "", timeoutMs: 150 }).complete("m", [
      { role: "user", content: "hi" },
    ]);

    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.reason).toBe("request timed out after 150ms");
  });

  it("rotates past the model the endpoint rejects and posts the one it accepts", async () => {
    // The whole point of the model list, end to end: a free tier that has run
    // out on its best model still produces an answer this run.
    const baseUrl = await serving((entry, respond) => {
      const model = bodyOf(entry).model;
      if (model === "exhausted") {
        respond(200, JSON.stringify({ error: { message: "rate limit exceeded" } }));
        return;
      }
      respond(200, completion("Xin chào"));
    });

    const provider = createProvider({ baseUrl, apiKey: "" });
    const rotation = await rotateModels(["exhausted", "backup"], (model): Promise<Completion> =>
      provider.complete(model, [{ role: "user", content: "hi" }]),
    );

    expect(rotation.success).toMatchObject({ model: "backup", content: "Xin chào" });
    expect(rotation.failures).toHaveLength(1);
    expect(rotation.failures[0]?.model).toBe("exhausted");
    expect(received.map((entry) => bodyOf(entry).model)).toEqual(["exhausted", "backup"]);
  });

  it("returns a failure rather than throwing when nothing is listening", async () => {
    // The port is real and free: the server for this test is never started.
    const answer = await createProvider({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "",
    }).complete("m", [{ role: "user", content: "hi" }]);

    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.reason).toContain("request failed");
  });
});
