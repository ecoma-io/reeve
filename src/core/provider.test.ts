import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseList } from "./list.js";
import {
  createProvider,
  parseModels,
  parseSeats,
  rotateModels,
  shown,
  type Completion,
  type Failure,
  type Provider,
  type Success,
} from "./provider.js";

// `fetch` is the platform, not a collaborator of this project, so it is
// replaced rather than mocked away — the `Response` objects below are real
// ones, built the way a provider would send them. No test here reaches a
// network, and none may: a suite that can call a model is a suite whose result
// depends on somebody's quota.
vi.mock("./list.js", () => ({ parseList: vi.fn((raw: string) => raw.split(",")) }));

const mockedParseList = vi.mocked(parseList);
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mockedParseList.mockReset();
  mockedParseList.mockImplementation((raw: string) => raw.split(","));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function answering(content: string, finishReason = "stop"): Response {
  return json({
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
  });
}

function subject(
  overrides: { baseUrl?: string; apiKey?: string; timeoutMs?: number } = {},
): Provider {
  return createProvider({
    baseUrl: overrides.baseUrl ?? "https://api.example.test/v1",
    apiKey: overrides.apiKey ?? "sk-test",
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  });
}

const HELLO = [{ role: "user", content: "hello" }] as const;

function lastRequest(): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  const [url, init] = call;
  // Asserted rather than coerced: Reeve sends a string url and a string
  // body, and a test that quietly stringified something else would be reading
  // `[object Object]` and comparing it to nothing.
  if (typeof url !== "string") throw new Error("expected a string url");
  if (typeof init?.body !== "string") throw new Error("expected a string body");
  const parsed: unknown = JSON.parse(init.body);
  return {
    url,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: parsed as Record<string, unknown>,
  };
}

/** Narrows for assertions, failing the test rather than the type checker. */
function expectFailure(completion: Completion): Failure {
  if (completion.ok) throw new Error(`expected a failure, got: ${completion.content}`);
  return completion;
}

function expectSuccess(completion: Completion): Success {
  if (!completion.ok) throw new Error(`expected a success, got: ${completion.reason}`);
  return completion;
}

describe("parseModels", () => {
  it("splits the input with the shared list convention", () => {
    expect(parseModels("gpt-4o-mini,llama-3.3-70b").models).toEqual([
      "gpt-4o-mini",
      "llama-3.3-70b",
    ]);
    expect(mockedParseList).toHaveBeenCalledWith("gpt-4o-mini,llama-3.3-70b");
  });

  it("drops an exact repeat, keeping the first position", () => {
    // Rotation only reaches a model because the one before it failed, so a
    // second attempt at the same id cannot succeed where the first did not.
    expect(parseModels("a,b,a,c,b").models).toEqual(["a", "b", "c"]);
  });

  it("keeps ids that differ only in case, because a model id is case-sensitive", () => {
    expect(parseModels("Llama-3,llama-3").models).toEqual(["Llama-3", "llama-3"]);
  });

  it("returns nothing rather than refusing an empty list", () => {
    // Empty is an error for `models` and the default for `judge-models`. Only
    // the caller knows which one it is holding.
    mockedParseList.mockReturnValue([]);
    expect(parseModels("")).toEqual({ models: [], names: new Map() });
  });

  it("refuses a seat separator rather than running the ids it groups together", () => {
    // Left alone, `a|b` is one id no provider has, and the only symptom is
    // every model failing for a reason that names an id nobody configured.
    expect(() => parseModels("a|b,c")).toThrow(/`models` is already a single rotation chain/);
  });

  it("takes the name after `=` and leaves the id without it", () => {
    const roster = parseModels("openai/gpt-4o = Careful,b");
    expect(roster.models).toEqual(["openai/gpt-4o", "b"]);
    expect(shown(roster.names, "openai/gpt-4o")).toBe("Careful");
  });

  it("shows the id of a model nobody named", () => {
    expect(shown(parseModels("a,b").names, "b")).toBe("b");
  });

  it("cuts at the first `=`, because a name may contain one and an id may not", () => {
    const roster = parseModels("a = why = because");
    expect(roster.models).toEqual(["a"]);
    expect(shown(roster.names, "a")).toBe("why = because");
  });

  it("treats an empty name as no name rather than as a blank one", () => {
    // `a =` is a workflow half-edited, and a block reading "Translated by ."
    // says less than one naming the id.
    expect(shown(parseModels("a =   ").names, "a")).toBe("a");
  });

  it("keeps the first name of a repeated id, as it keeps its first position", () => {
    expect(shown(parseModels("a = First,a = Second").names, "a")).toBe("First");
  });
});

describe("parseSeats", () => {
  it("reads an input with no seat separator as one seat per id, as it always meant", () => {
    expect(parseSeats("a,b,c").seats).toEqual([["a"], ["b"], ["c"]]);
  });

  it("groups the models of one seat into one chain", () => {
    expect(parseSeats("a|a2,b").seats).toEqual([["a", "a2"], ["b"]]);
  });

  it("trims around the seat separator, which is written with spaces far more often than not", () => {
    expect(parseSeats("a | a2 | a3").seats).toEqual([["a", "a2", "a3"]]);
  });

  it("drops an exact repeat inside a seat, which could only ever be one wasted request", () => {
    expect(parseSeats("a|b|a").seats).toEqual([["a", "b"]]);
  });

  it("keeps a repeat across seats, because only the run knows whether it costs a vote", () => {
    // Two seats naming the same model is a configuration the panel resolves at
    // the point it knows which models are still unspent — `a|b` and `b|c` are
    // two votes on a good morning and this is the same shape.
    expect(parseSeats("a,a").seats).toEqual([["a"], ["a"]]);
  });

  it("drops a seat with nothing in it rather than seating a judge with no model", () => {
    mockedParseList.mockReturnValue(["a", "|", "b"]);
    expect(parseSeats("a,|,b").seats).toEqual([["a"], ["b"]]);
  });

  it("returns nothing for the empty input, which is the default rather than an error", () => {
    mockedParseList.mockReturnValue([]);
    expect(parseSeats("")).toEqual({ seats: [], names: new Map() });
  });

  it("gives a seat's name to every model that may fill it", () => {
    // The name is the voter's, and the voter is the seat: whichever of the two
    // answers, the panel heard from `Careful` once.
    const panel = parseSeats("a | b = Careful, c = Quick");
    expect(panel.seats).toEqual([["a", "b"], ["c"]]);
    expect(shown(panel.names, "a")).toBe("Careful");
    expect(shown(panel.names, "b")).toBe("Careful");
    expect(shown(panel.names, "c")).toBe("Quick");
  });

  it("leaves an unnamed seat's models showing their ids", () => {
    expect(shown(parseSeats("a|b").names, "b")).toBe("b");
  });

  it("keeps the first seat's name for a model two seats name", () => {
    // One id, one thing to call it. The first seat that named it is the one a
    // reader met first.
    expect(shown(parseSeats("a = First,a = Second").names, "a")).toBe("First");
  });
});

describe("createProvider", () => {
  describe("the request it sends", () => {
    it("posts to the chat-completions path under the configured base url", async () => {
      fetchMock.mockResolvedValue(answering("hi"));

      await subject().complete("gpt-4o-mini", HELLO);

      expect(lastRequest().url).toBe("https://api.example.test/v1/chat/completions");
    });

    it("does not double the slash when the base url ends in one", async () => {
      fetchMock.mockResolvedValue(answering("hi"));

      await subject({ baseUrl: "https://api.example.test/v1//" }).complete("m", HELLO);

      expect(lastRequest().url).toBe("https://api.example.test/v1/chat/completions");
    });

    it("carries the model, the messages, and no streaming", async () => {
      fetchMock.mockResolvedValue(answering("hi"));

      await subject().complete("gpt-4o-mini", HELLO);

      expect(lastRequest().body).toEqual({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
    });

    it("sends a bearer token when one is configured", async () => {
      fetchMock.mockResolvedValue(answering("hi"));

      await subject({ apiKey: "sk-secret" }).complete("m", HELLO);

      expect(lastRequest().headers.authorization).toBe("Bearer sk-secret");
    });

    it("sends no authorization header for a keyless provider", async () => {
      // A keyless endpoint is a supported configuration, and some of them
      // reject `Bearer ` with an empty token rather than ignoring it.
      fetchMock.mockResolvedValue(answering("hi"));

      await subject({ apiKey: "" }).complete("m", HELLO);

      expect(lastRequest().headers).not.toHaveProperty("authorization");
    });

    it("omits temperature unless it is asked for", async () => {
      // Several reasoning models reject the field outright, so a default here
      // would be a default that breaks a provider.
      fetchMock.mockResolvedValue(answering("hi"));

      await subject().complete("m", HELLO);

      expect(lastRequest().body).not.toHaveProperty("temperature");
    });

    it("sends temperature when it is asked for, including zero", async () => {
      fetchMock.mockResolvedValue(answering("hi"));

      await subject().complete("m", HELLO, { temperature: 0 });

      expect(lastRequest().body.temperature).toBe(0);
    });
  });

  describe("the answer it accepts", () => {
    it("returns the content and the model that produced it", async () => {
      fetchMock.mockResolvedValue(answering("Xin chào"));

      const completion = await subject().complete("gpt-4o-mini", HELLO);

      expect(expectSuccess(completion)).toMatchObject({
        model: "gpt-4o-mini",
        content: "Xin chào",
        finishReason: "stop",
      });
    });

    it("reports a truncated answer rather than rejecting it", async () => {
      // `length` ruins a translation and is harmless for a one-token choice.
      // Which one this was is the caller's knowledge, not this module's.
      fetchMock.mockResolvedValue(answering("Xin ch", "length"));

      expect(expectSuccess(await subject().complete("m", HELLO)).finishReason).toBe("length");
    });

    it("reports what the answer cost, when the provider says", async () => {
      fetchMock.mockResolvedValue(
        json({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 812, completion_tokens: 3, total_tokens: 815 },
        }),
      );

      expect(expectSuccess(await subject().complete("m", HELLO)).usage).toEqual({
        prompt: 812,
        completion: 3,
      });
    });

    it("reports null rather than zero when the provider says nothing", async () => {
      // A gateway that sends no `usage` is the ordinary case, and zeroes would
      // put a free line in a bill that was not free.
      fetchMock.mockResolvedValue(answering("hi"));

      expect(expectSuccess(await subject().complete("m", HELLO)).usage).toBeNull();
    });

    it("keeps the half of a usage that arrived", async () => {
      fetchMock.mockResolvedValue(
        json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 40 } }),
      );

      expect(expectSuccess(await subject().complete("m", HELLO)).usage).toEqual({
        prompt: 40,
        completion: 0,
      });
    });

    it.each([
      ["a usage with neither count in it", { total_tokens: 9 }],
      ["counts that are not numbers", { prompt_tokens: "40", completion_tokens: null }],
      ["a negative count", { prompt_tokens: -1 }],
    ])("reports no usage for %s", async (_case, usage) => {
      fetchMock.mockResolvedValue(json({ choices: [{ message: { content: "hi" } }], usage }));

      expect(expectSuccess(await subject().complete("m", HELLO)).usage).toBeNull();
    });

    it("reports no finish reason when the provider sent none", async () => {
      fetchMock.mockResolvedValue(json({ choices: [{ message: { content: "hi" } }] }));

      expect(expectSuccess(await subject().complete("m", HELLO)).finishReason).toBeNull();
    });

    it.each([
      ["null", null],
      ["an empty string", ""],
      ["an empty object", {}],
    ])("accepts an answer carrying an `error` field set to %s", async (_case, error) => {
      // Several gateways send one on the way to a perfectly good answer.
      // Condemning it would rotate past a model that worked, for punctuation.
      fetchMock.mockResolvedValue(
        json({ error, choices: [{ message: { content: "Xin chào" }, finish_reason: "stop" }] }),
      );

      expect(expectSuccess(await subject().complete("m", HELLO)).content).toBe("Xin chào");
    });

    it("preserves surrounding whitespace in the content", async () => {
      // Trimming is the caller's decision: a translated body's leading newline
      // can be structure.
      fetchMock.mockResolvedValue(answering("\n# Tiêu đề\n"));

      expect(expectSuccess(await subject().complete("m", HELLO)).content).toBe("\n# Tiêu đề\n");
    });
  });

  describe("the answers it refuses", () => {
    it("refuses an error body that arrived with a 200, naming the provider's message", async () => {
      // The failure this module exists for. A run that trusted the status would
      // post `{"error":...}` as somebody's translation.
      fetchMock.mockResolvedValue(
        json({ error: { message: "rate limit exceeded", type: "quota" } }),
      );

      const failure = expectFailure(await subject().complete("free-model", HELLO));

      expect(failure).toMatchObject({ model: "free-model" });
      expect(failure.reason).toContain("rate limit exceeded");
      expect(failure.reason).toContain("HTTP 200");
    });

    it("refuses an error reported as a bare string", async () => {
      fetchMock.mockResolvedValue(json({ error: "model_not_found" }));

      expect(expectFailure(await subject().complete("m", HELLO)).reason).toContain(
        "model_not_found",
      );
    });

    it("still says something useful when the error carries no message", async () => {
      fetchMock.mockResolvedValue(json({ error: { code: 429 } }));

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("provider reported an error");
      expect(failure.reason).toContain("429");
    });

    it("prefers the body's message over the status when both say something", async () => {
      fetchMock.mockResolvedValue(json({ error: { message: "context length exceeded" } }, 400));

      expect(expectFailure(await subject().complete("m", HELLO)).reason).toContain(
        "context length exceeded",
      );
    });

    it("refuses a non-2xx that carries no error field, quoting the body", async () => {
      fetchMock.mockResolvedValue(json({ detail: "upstream unavailable" }, 503));

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("HTTP 503");
      expect(failure.reason).toContain("upstream unavailable");
    });

    it("refuses a body that is not JSON, quoting what arrived", async () => {
      // What a gateway sends when it is the gateway failing, not the model.
      fetchMock.mockResolvedValue(
        new Response("<html><title>502 Bad Gateway</title>", { status: 502 }),
      );

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("body was not JSON");
      expect(failure.reason).toContain("502 Bad Gateway");
    });

    it("truncates a long body rather than pouring it into the log", async () => {
      fetchMock.mockResolvedValue(new Response("x".repeat(5000), { status: 500 }));

      const { reason } = expectFailure(await subject().complete("m", HELLO));

      expect(reason.length).toBeLessThan(300);
      expect(reason).toContain("…");
    });

    it("says the body was empty rather than quoting nothing", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 504 }));

      expect(expectFailure(await subject().complete("m", HELLO)).reason).toContain(
        "the body was empty",
      );
    });

    it.each([
      ["an empty list of choices", { id: "chatcmpl-1", choices: [] }],
      ["no choices field at all", { id: "chatcmpl-1", object: "chat.completion" }],
      ["a choices field that is not a list", { choices: { message: { content: "hi" } } }],
    ])("refuses a 200 with %s", async (_case, payload) => {
      fetchMock.mockResolvedValue(json(payload));

      expect(expectFailure(await subject().complete("m", HELLO)).reason).toContain("no choices");
    });

    it("refuses content that is not a string", async () => {
      // A provider answering in content parts, or a reasoning model that left
      // `content` null and put everything in `reasoning_content`. Both are
      // outside the protocol, and rotation is the answer to both.
      fetchMock.mockResolvedValue(
        json({ choices: [{ message: { content: [{ type: "text", text: "hi" }] } }] }),
      );

      expect(expectFailure(await subject().complete("m", HELLO)).reason).toContain(
        "content was not a string",
      );
    });

    it("refuses content that is only whitespace", async () => {
      // Posting it would be a comment with nothing in it, under a heading
      // announcing a translation.
      fetchMock.mockResolvedValue(answering("   \n  "));

      expect(expectFailure(await subject().complete("m", HELLO)).reason).toContain("empty content");
    });
  });

  it("counts a billable answer it could not use", async () => {
    // `HTTP 200` with empty content is a failure to Reeve and a completion the
    // provider charged for. A ledger that only counted the answers it liked
    // would understate the run.
    fetchMock.mockResolvedValue(
      json({
        choices: [{ message: { content: "   " } }],
        usage: { prompt_tokens: 30, completion_tokens: 1 },
      }),
    );

    expect(expectFailure(await subject().complete("m", HELLO)).usage).toEqual({
      prompt: 30,
      completion: 1,
    });
  });

  describe("the failures that never reach a body", () => {
    it("returns a failure when the request itself throws", async () => {
      fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.example.test"));

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("request failed");
      expect(failure.reason).toContain("ENOTFOUND");
    });

    it("names the timeout as a timeout, with the budget it exceeded", async () => {
      // `TimeoutError` is what `AbortSignal.timeout` raises, and it reads as an
      // ordinary abort unless it is spelled out.
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      fetchMock.mockRejectedValue(timeout);

      expect(expectFailure(await subject({ timeoutMs: 5000 }).complete("m", HELLO)).reason).toBe(
        "request timed out after 5000ms",
      );
    });

    it("gives the request a deadline even when none is configured", async () => {
      fetchMock.mockResolvedValue(answering("hi"));

      await subject().complete("m", HELLO);

      const call = fetchMock.mock.calls.at(-1);
      expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns a failure when a thrown value is not an Error", async () => {
      fetchMock.mockRejectedValue("something went wrong");

      expect(expectFailure(await subject().complete("m", HELLO)).reason).toContain(
        "something went wrong",
      );
    });

    it("returns a failure when the body stream breaks mid-read", async () => {
      const broken = new ReadableStream({
        start(controller) {
          controller.error(new Error("terminated"));
        },
      });
      fetchMock.mockResolvedValue(new Response(broken, { status: 200 }));

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("could not be read");
    });
  });
});

describe("rotateModels", () => {
  const succeeded = (model: string): Success => ({
    ok: true,
    model,
    content: "answer",
    finishReason: "stop",
  });
  const failed = (model: string): Failure => ({ ok: false, model, reason: `${model} said no` });

  it("returns the first usable answer and stops there", async () => {
    const attempt = vi.fn((model: string) => Promise.resolve<Completion>(succeeded(model)));

    const rotation = await rotateModels(["a", "b", "c"], attempt);

    expect(rotation.success?.model).toBe("a");
    expect(rotation.failures).toEqual([]);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("passes a failing model and reports it alongside the answer that worked", async () => {
    const attempt = vi.fn((model: string) =>
      Promise.resolve<Completion>(model === "b" ? succeeded(model) : failed(model)),
    );

    const rotation = await rotateModels(["a", "b", "c"], attempt);

    expect(rotation.success?.model).toBe("b");
    expect(rotation.failures.map((failure) => failure.model)).toEqual(["a"]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("tries the models in the order given, which is the order of preference", async () => {
    const tried: string[] = [];
    await rotateModels(["a", "b", "c"], (model) => {
      tried.push(model);
      return Promise.resolve<Completion>(failed(model));
    });

    expect(tried).toEqual(["a", "b", "c"]);
  });

  it("never tries a model twice", async () => {
    // A failure here is quota, a decommissioned id, or an outage. None of them
    // clears inside one run, and a retry spends the budget of the model that
    // would have worked.
    const tried: string[] = [];
    await rotateModels(["a", "b"], (model) => {
      tried.push(model);
      return Promise.resolve<Completion>(failed(model));
    });

    expect(tried).toEqual([...new Set(tried)]);
  });

  it("reports every failure when no model worked, so one log line explains the run", async () => {
    const rotation = await rotateModels(["a", "b"], (model) =>
      Promise.resolve<Completion>(failed(model)),
    );

    expect(rotation.success).toBeNull();
    expect(rotation.failures.map((failure) => failure.reason)).toEqual(["a said no", "b said no"]);
  });

  it("answers for an empty model list without calling anything", async () => {
    // `judge-models` defaults to empty, and that means the score decides alone
    // rather than that the run is broken.
    const attempt = vi.fn<(model: string) => Promise<Completion>>();

    await expect(rotateModels([], attempt)).resolves.toEqual({ success: null, failures: [] });
    expect(attempt).not.toHaveBeenCalled();
  });
});
