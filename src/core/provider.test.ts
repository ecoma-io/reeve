import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseApiKeys, parseEndpoints } from "./inputs.js";
import { parseList } from "./list.js";
import type { Meter } from "./meter.js";
import {
  AuthenticationFailure,
  assembleClient,
  createProvider,
  createRoutedProvider,
  createWeather,
  parseModels,
  parseSeats,
  reckon,
  resolveEndpoints,
  rotateModels,
  settleAuth,
  shown,
  splitEndpointAlias,
  starved,
  weatherFailure,
  type Completion,
  type Failure,
  type Provider,
  type RoutedEndpoint,
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

      expect(failure).toMatchObject({ model: "free-model", kind: "protocol" });
      expect(failure.reason).toContain("rate limit exceeded");
      expect(failure.reason).toContain("HTTP 200");
    });

    it("refuses an error reported as a bare string", async () => {
      fetchMock.mockResolvedValue(json({ error: "model_not_found" }));

      const failure = expectFailure(await subject().complete("m", HELLO));
      expect(failure.reason).toContain("model_not_found");
      expect(failure.kind).toBe("protocol");
    });

    it("still says something useful when the error carries no message", async () => {
      fetchMock.mockResolvedValue(json({ error: { code: 429 } }));

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("provider reported an error");
      expect(failure.reason).toContain("429");
      // The `429` is a code inside the body, not the HTTP status — the actual
      // status here is 200, so this stays protocol rather than capacity.
      expect(failure.kind).toBe("protocol");
    });

    it("prefers the body's message over the status when both say something", async () => {
      fetchMock.mockResolvedValue(json({ error: { message: "context length exceeded" } }, 400));

      const failure = expectFailure(await subject().complete("m", HELLO));
      expect(failure.reason).toContain("context length exceeded");
      expect(failure.kind).toBe("protocol");
    });

    it("refuses a non-2xx that carries no error field, quoting the body", async () => {
      fetchMock.mockResolvedValue(json({ detail: "upstream unavailable" }, 503));

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("HTTP 503");
      expect(failure.reason).toContain("upstream unavailable");
      expect(failure.kind).toBe("capacity");
    });

    it("refuses a body that is not JSON, quoting what arrived", async () => {
      // What a gateway sends when it is the gateway failing, not the model.
      fetchMock.mockResolvedValue(
        new Response("<html><title>502 Bad Gateway</title>", { status: 502 }),
      );

      const failure = expectFailure(await subject().complete("m", HELLO));

      expect(failure.reason).toContain("body was not JSON");
      expect(failure.reason).toContain("502 Bad Gateway");
      expect(failure.kind).toBe("capacity");
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

      const failure = expectFailure(await subject().complete("m", HELLO));
      expect(failure.reason).toContain("no choices");
      expect(failure.kind).toBe("protocol");
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

      const failure = expectFailure(await subject().complete("m", HELLO));
      expect(failure.reason).toContain("empty content");
      expect(failure.kind).toBe("protocol");
    });
  });

  describe("classifying a failure's kind", () => {
    // The classification this whole entry is for: it decides whether a failure
    // rotates quietly, grounds a model for the rest of the run, or ends it red.
    it.each([
      ["401", 401, "auth"],
      ["403", 403, "auth"],
      ["429", 429, "capacity"],
      ["500", 500, "capacity"],
      ["503", 503, "capacity"],
      ["599", 599, "capacity"],
      ["400", 400, "protocol"],
      ["404", 404, "protocol"],
      ["418", 418, "protocol"],
    ])("classifies HTTP %s as %s", async (_case, status, kind) => {
      fetchMock.mockResolvedValue(json({ detail: "no" }, status));

      expect(expectFailure(await subject().complete("m", HELLO)).kind).toBe(kind);
    });

    it("keeps a 2xx whose body carries a real error as protocol, never auth or capacity", async () => {
      // "Body before status" doctrine: a provider that answers 200 with an
      // `error` field describing a quota problem has not sent a 401 or a 429,
      // and classification by status only applies once the status itself is
      // the non-2xx signal.
      fetchMock.mockResolvedValue(json({ error: { message: "unauthorized", code: 401 } }, 200));

      expect(expectFailure(await subject().complete("m", HELLO)).kind).toBe("protocol");
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
      // Never a status at all — there is no 401 hiding in a request that never
      // reached the provider, so this is weather by construction.
      expect(failure.kind).toBe("capacity");
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

    it("scopes a timeout to the pair, never the endpoint — a slow model is not a dead gateway", async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      fetchMock.mockRejectedValue(timeout);

      expect(expectFailure(await subject().complete("m", HELLO)).transport).toBeUndefined();
    });

    it("marks a failure that never connected as transport, grounding the whole endpoint", async () => {
      fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.example.test"));

      expect(expectFailure(await subject().complete("m", HELLO)).transport).toBe(true);
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
      expect(failure.kind).toBe("capacity");
      // The status line arrived, which is proof the endpoint is reachable —
      // a broken body condemns this response, not every model behind it.
      expect(failure.transport).toBeUndefined();
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
  const failed = (model: string, kind: Failure["kind"] = "protocol"): Failure => ({
    ok: false,
    model,
    reason: `${model} said no`,
    kind,
  });

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

  describe("an auth failure", () => {
    it("throws AuthenticationFailure the instant one model reports it, trying no others", async () => {
      const tried: string[] = [];
      const attempt = (model: string): Promise<Completion> => {
        tried.push(model);
        return Promise.resolve<Completion>(model === "a" ? failed("a", "auth") : succeeded(model));
      };

      await expect(rotateModels(["a", "b", "c"], attempt)).rejects.toThrow(AuthenticationFailure);
      // "b" would have worked, and rotation never gets to find that out — auth
      // is red from wherever it is first seen, with no exception for it.
      expect(tried).toEqual(["a"]);
    });

    it("names the model and the reason on the thrown failure", async () => {
      const attempt = (): Promise<Completion> =>
        Promise.resolve<Completion>(failed("gpt-x", "auth"));

      const caught = await rotateModels(["gpt-x"], attempt).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(AuthenticationFailure);
      expect((caught as AuthenticationFailure).failure).toMatchObject({
        model: "gpt-x",
        kind: "auth",
      });
    });

    it("still throws when a weather instance is passed, rather than grounding the model", async () => {
      // Auth is not weather. Grounding it would make the next model in the
      // roster get a turn, and the whole point of this kind is that nothing
      // does.
      const weather = createWeather();
      const attempt = (): Promise<Completion> => Promise.resolve<Completion>(failed("m", "auth"));

      await expect(rotateModels(["m"], attempt, weather)).rejects.toThrow(AuthenticationFailure);
      expect(weather.grounded("m")).toBe(false);
    });
  });

  describe("weather", () => {
    it("skips a model already grounded this run, without calling it again", async () => {
      const weather = createWeather();
      weather.ground("a");
      const attempt = vi.fn((model: string) => Promise.resolve<Completion>(succeeded(model)));

      const rotation = await rotateModels(["a", "b"], attempt, weather);

      expect(rotation.success?.model).toBe("b");
      expect(attempt).toHaveBeenCalledExactlyOnceWith("b");
      // The skip is still reported, so a summary of "what was tried" stays
      // truthful without spending a real request on a model known to be dead.
      expect(rotation.failures).toHaveLength(1);
      expect(rotation.failures[0]).toMatchObject({ model: "a", kind: "capacity" });
    });

    it("grounds a model on a capacity failure so a later call in the same run skips it", async () => {
      const weather = createWeather();
      const attempt = vi.fn((model: string) =>
        Promise.resolve<Completion>(failed(model, "capacity")),
      );

      await rotateModels(["a"], attempt, weather);
      expect(weather.grounded("a")).toBe(true);

      const second = vi.fn((model: string) => Promise.resolve<Completion>(succeeded(model)));
      await rotateModels(["a", "b"], second, weather);

      expect(second).toHaveBeenCalledExactlyOnceWith("b");
    });

    it("does not ground a model on a protocol failure", async () => {
      const weather = createWeather();
      const attempt = (model: string): Promise<Completion> =>
        Promise.resolve<Completion>(failed(model, "protocol"));

      await rotateModels(["a"], attempt, weather);

      expect(weather.grounded("a")).toBe(false);
    });

    it("reports starved only once every listed model is grounded, and never for an empty list", () => {
      const weather = createWeather();
      expect(starved([], weather)).toBe(false);
      expect(starved(["a", "b"], weather)).toBe(false);

      weather.ground("a");
      expect(starved(["a", "b"], weather)).toBe(false);

      weather.ground("b");
      expect(starved(["a", "b"], weather)).toBe(true);
    });

    it("reckon grounds on capacity and throws on auth, leaving protocol untouched", () => {
      const weather = createWeather();

      reckon(failed("a", "protocol"), weather);
      expect(weather.grounded("a")).toBe(false);

      reckon(failed("b", "capacity"), weather);
      expect(weather.grounded("b")).toBe(true);

      expect(() => {
        reckon(failed("c", "auth"), weather);
      }).toThrow(AuthenticationFailure);
    });

    it("synthesises a weatherFailure that explains a model was skipped, not merely absent", () => {
      const failure = weatherFailure("a");
      expect(failure).toMatchObject({ ok: false, model: "a", kind: "capacity" });
      expect(failure.reason).toContain("capacity");
    });
  });
});

describe("splitEndpointAlias", () => {
  it("returns the id unchanged when there is no `@` at all", () => {
    expect(splitEndpointAlias("gpt-4o-mini", new Set(["fast"]))).toEqual({
      id: "gpt-4o-mini",
      alias: null,
    });
  });

  it("splits at the alias when it was declared", () => {
    expect(splitEndpointAlias("gpt-4o-mini@fast", new Set(["fast"]))).toEqual({
      id: "gpt-4o-mini",
      alias: "fast",
    });
  });

  it("splits at the last `@`, so an id that itself contains one is untouched", () => {
    expect(splitEndpointAlias("user@example.com@fast", new Set(["fast"]))).toEqual({
      id: "user@example.com",
      alias: "fast",
    });
  });

  it("leaves a model with an `@` alone when the alias after it was never declared", () => {
    // A model id may legitimately contain an `@` of its own — only a
    // declared alias turns the last one into a routing suffix.
    expect(splitEndpointAlias("gpt-4o-mini@nowhere", new Set(["fast"]))).toEqual({
      id: "gpt-4o-mini@nowhere",
      alias: null,
    });
  });

  it("leaves every id alone when no alias was ever declared", () => {
    expect(splitEndpointAlias("gpt-4o-mini@fast", new Set())).toEqual({
      id: "gpt-4o-mini@fast",
      alias: null,
    });
  });
});

describe("createRoutedProvider", () => {
  function endpoint(over: Partial<RoutedEndpoint> = {}): RoutedEndpoint {
    return {
      alias: null,
      baseUrl: "https://default.example.test/v1",
      apiKey: "sk-default",
      timeoutMs: 1000,
      ...over,
    };
  }

  it("routes a plain id, with no `@alias`, to the default endpoint unchanged", async () => {
    fetchMock.mockResolvedValue(answering("hi"));
    const provider = createRoutedProvider([endpoint()]);

    const completion = await provider.complete("gpt-4o-mini", HELLO);

    expect(lastRequest().url).toBe("https://default.example.test/v1/chat/completions");
    expect(lastRequest().body.model).toBe("gpt-4o-mini");
    expect(completion).toMatchObject({ ok: true, model: "gpt-4o-mini", endpoint: null });
  });

  it("routes `model@alias` to the endpoint the alias names, with `@alias` stripped", async () => {
    fetchMock.mockResolvedValue(answering("hi"));
    const provider = createRoutedProvider([
      endpoint(),
      endpoint({ alias: "fast", baseUrl: "https://fast.example.test/v1", apiKey: "sk-fast" }),
    ]);

    const completion = await provider.complete("gpt-4o-mini@fast", HELLO);

    expect(lastRequest().url).toBe("https://fast.example.test/v1/chat/completions");
    // The id actually sent has the routing suffix stripped — no endpoint's own
    // catalogue has ever heard of it.
    expect(lastRequest().body.model).toBe("gpt-4o-mini");
    expect(lastRequest().headers.authorization).toBe("Bearer sk-fast");
    // The completion that comes back is stamped with the id the caller wrote,
    // the composite one, and with the endpoint it actually reached.
    expect(completion).toMatchObject({ ok: true, model: "gpt-4o-mini@fast", endpoint: "fast" });
  });

  it("leaves a model alone when its trailing `@name` is not a declared alias at all", async () => {
    // `splitEndpointAlias` treats an undeclared alias as part of the id, not a
    // routing suffix — so this reaches the default endpoint whole, exactly as
    // it would if `@nowhere` were never written.
    fetchMock.mockResolvedValue(answering("hi"));
    const provider = createRoutedProvider([endpoint()]);

    const completion = await provider.complete("gpt-4o-mini@nowhere", HELLO);

    expect(lastRequest().body.model).toBe("gpt-4o-mini@nowhere");
    expect(completion).toMatchObject({ ok: true, endpoint: null });
  });

  it("fails a model that routes to no configured endpoint, without calling anything", async () => {
    // Only reachable when the roster of endpoints has no default entry —
    // `resolveEndpoints` always supplies one, but this function is not the
    // only thing that can build a `RoutedEndpoint[]`, and the branch has to
    // answer for itself when the default is missing.
    const provider = createRoutedProvider([
      endpoint({ alias: "fast", baseUrl: "https://fast.example.test/v1" }),
    ]);

    const completion = await provider.complete("gpt-4o-mini", HELLO);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(completion).toMatchObject({ ok: false, model: "gpt-4o-mini", kind: "protocol" });
  });
});

describe("multi-endpoint weather", () => {
  it("grounds only the one `model@alias` pair on an ordinary capacity failure", () => {
    const weather = createWeather(new Set(["fast"]));

    reckon({ ok: false, model: "a@fast", reason: "429", kind: "capacity" }, weather);

    expect(weather.grounded("a@fast")).toBe(true);
    expect(weather.grounded("b@fast")).toBe(false);
  });

  it("grounds every model routed to an endpoint on a transport failure", () => {
    const weather = createWeather(new Set(["fast"]));

    reckon(
      {
        ok: false,
        model: "a@fast",
        reason: "timeout",
        kind: "capacity",
        transport: true,
        endpoint: "fast",
      },
      weather,
    );

    expect(weather.grounded("a@fast")).toBe(true);
    // Never asked, but routed to the same now-dead endpoint.
    expect(weather.grounded("b@fast")).toBe(true);
    // A different endpoint is untouched.
    expect(weather.grounded("c")).toBe(false);
  });

  it("records a multi-endpoint auth failure instead of throwing", () => {
    const weather = createWeather(new Set(["fast"]));

    expect(() => {
      reckon({ ok: false, model: "a", reason: "401", kind: "auth", endpoint: null }, weather);
    }).not.toThrow();

    expect(weather.authFailures).toHaveLength(1);
    expect(weather.authExhausted).toBe(false);
  });

  it("still throws immediately for a single-endpoint auth failure", () => {
    const weather = createWeather();

    expect(() => {
      reckon({ ok: false, model: "a", reason: "401", kind: "auth" }, weather);
    }).toThrow(AuthenticationFailure);
  });

  it("grounds the whole endpoint on a deferred auth failure, so nothing asks it again", () => {
    const weather = createWeather(new Set(["fast"]));

    reckon({ ok: false, model: "a@fast", reason: "401", kind: "auth", endpoint: "fast" }, weather);

    // Every model routed to the refused endpoint is grounded — a key refused
    // once is refused for all of them, and a sweep must not spend its threads
    // confirming that against a provider's rate limit.
    expect(weather.grounded("a@fast")).toBe(true);
    expect(weather.grounded("b@fast")).toBe(true);
    // The default endpoint is untouched, and the run keeps going on it.
    expect(weather.grounded("c")).toBe(false);
    expect(weather.authExhausted).toBe(false);
  });

  it("keeps only the first auth failure recorded per endpoint", () => {
    const weather = createWeather(new Set(["fast"]));

    reckon({ ok: false, model: "a", reason: "first", kind: "auth", endpoint: null }, weather);
    reckon({ ok: false, model: "a", reason: "second", kind: "auth", endpoint: null }, weather);

    expect(weather.authFailures).toHaveLength(1);
    expect(weather.authFailures[0]?.reason).toBe("first");
  });
});

describe("settleAuth", () => {
  it("does nothing for a single-endpoint run, whatever weather recorded", () => {
    const weather = createWeather();

    expect(() => {
      settleAuth(weather);
    }).not.toThrow();
  });

  it("does nothing when only some endpoints have failed auth", () => {
    const weather = createWeather(new Set(["fast", "slow"]));
    reckon({ ok: false, model: "a", reason: "401", kind: "auth", endpoint: "fast" }, weather);

    expect(() => {
      settleAuth(weather);
    }).not.toThrow();
  });

  it("throws once every endpoint this run knows about has failed auth", () => {
    const weather = createWeather(new Set(["fast"]));
    reckon(
      { ok: false, model: "a", reason: "default failed", kind: "auth", endpoint: null },
      weather,
    );
    reckon(
      { ok: false, model: "b@fast", reason: "fast failed", kind: "auth", endpoint: "fast" },
      weather,
    );

    expect(() => {
      settleAuth(weather);
    }).toThrow(AuthenticationFailure);
  });

  it("scopes exhaustion to the endpoints the roster routes to, not every declared one", () => {
    // Every model says `@fast`, so the default endpoint is never asked
    // anything — a run like this must not stay green on the strength of an
    // endpoint nothing could reach.
    const weather = createWeather(new Set(["fast"]), ["a@fast", "b@fast"]);
    reckon({ ok: false, model: "a@fast", reason: "401", kind: "auth", endpoint: "fast" }, weather);

    expect(weather.authExhausted).toBe(true);
    expect(() => {
      settleAuth(weather);
    }).toThrow(AuthenticationFailure);
  });

  it("still waits for every roster-reachable endpoint before settling", () => {
    const weather = createWeather(new Set(["fast"]), ["a@fast", "plain"]);
    reckon({ ok: false, model: "a@fast", reason: "401", kind: "auth", endpoint: "fast" }, weather);

    // `plain` routes to the default endpoint, which has not refused anything.
    expect(weather.authExhausted).toBe(false);
    expect(() => {
      settleAuth(weather);
    }).not.toThrow();
  });
});

describe("resolveEndpoints", () => {
  it("always leads with the default `base-url`/`api-key` pair, aliased null", () => {
    const resolved = resolveEndpoints({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-default",
      requestTimeoutMs: 120_000,
      endpoints: [],
      apiKeys: [],
    });

    expect(resolved).toEqual([
      {
        alias: null,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-default",
        timeoutMs: 120_000,
      },
    ]);
  });

  it("keys every configured endpoint from api-keys by alias", () => {
    const resolved = resolveEndpoints({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-default",
      requestTimeoutMs: 120_000,
      endpoints: parseEndpoints("fast = https://a.example.com/v1"),
      apiKeys: parseApiKeys("fast = sk-fast"),
    });

    expect(resolved).toContainEqual({
      alias: "fast",
      baseUrl: "https://a.example.com/v1",
      apiKey: "sk-fast",
      timeoutMs: 120_000,
    });
  });

  it("falls back to an empty key for an endpoint api-keys never named", () => {
    const resolved = resolveEndpoints({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-default",
      requestTimeoutMs: 120_000,
      endpoints: parseEndpoints("open = https://a.example.com/v1"),
      apiKeys: [],
    });

    expect(resolved).toContainEqual({
      alias: "open",
      baseUrl: "https://a.example.com/v1",
      apiKey: "",
      timeoutMs: 120_000,
    });
  });

  it("prefers an endpoint's own `timeout=` over `request-timeout`", () => {
    const resolved = resolveEndpoints({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-default",
      requestTimeoutMs: 120_000,
      endpoints: parseEndpoints("fast = https://a.example.com/v1 timeout=5s"),
      apiKeys: [],
    });

    expect(resolved.find((endpoint) => endpoint.alias === "fast")?.timeoutMs).toBe(5000);
  });
});

describe("assembleClient", () => {
  const SHARED = {
    token: "ghs_token",
    models: ["a", "b@fast"],
    modelNames: new Map<string, string>(),
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-default",
    dryRun: false,
    endpoints: parseEndpoints("fast = https://a.example.com/v1"),
    apiKeys: parseApiKeys("fast = sk-fast"),
    requestTimeoutMs: 120_000,
    temperature: undefined,
  };

  /** A meter that keeps what it was told, for the cases that are about spend. */
  function meter(): Meter {
    return { record: vi.fn(), spent: () => [] };
  }

  it("wraps one metered provider per purpose asked for, and no others", () => {
    const { stages } = assembleClient(SHARED, meter(), ["detect", "draft"] as const);

    expect(Object.keys(stages).sort()).toEqual(["detect", "draft"]);
  });

  it("counts each stage under its own name", async () => {
    fetchMock.mockResolvedValue(answering("hello"));
    const spend = meter();

    const { stages } = assembleClient(SHARED, spend, ["detect", "draft"] as const);
    await stages.draft.complete("a", []);

    expect(vi.mocked(spend.record)).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ ok: true }),
    );
  });

  it("seeds the weather with every endpoint a configured model routes to", () => {
    // `b@fast` is on the roster, so grounding the `fast` endpoint has to be
    // something this run's weather can even express.
    const { weather } = assembleClient(SHARED, meter(), ["detect"] as const);
    weather.groundEndpoint("fast");

    expect(weather.grounded("b@fast")).toBe(true);
    expect(weather.grounded("a")).toBe(false);
  });

  it("seeds the weather with the extra rosters a duty names, not just `models`", () => {
    // A judge panel left out of the weather is the failure that is silent: its
    // models are never counted as starved, and the run keeps asking. Only the
    // extra roster reaches `fast` here, so a weather that ignored it would
    // have one endpoint in its universe rather than two.
    const { weather } = assembleClient({ ...SHARED, models: ["a"] }, meter(), ["judge"] as const, [
      ["c@fast"],
    ]);

    expect(weather.multiEndpoint).toBe(true);
  });

  it("applies the run's `temperature` to every request, without a stage carrying it", async () => {
    fetchMock.mockResolvedValue(answering("hello"));

    const { stages } = assembleClient({ ...SHARED, temperature: 0.2 }, meter(), ["draft"] as const);
    await stages.draft.complete("a", [{ role: "user", content: "hi" }]);

    expect(lastRequest().body).toMatchObject({ temperature: 0.2 });
  });

  it("omits `temperature` entirely when the run configured none", async () => {
    // Not "sends the provider's default": some providers reject the field
    // outright, so the two cannot share a spelling.
    fetchMock.mockResolvedValue(answering("hello"));

    const { stages } = assembleClient(SHARED, meter(), ["draft"] as const);
    await stages.draft.complete("a", []);

    expect(lastRequest().body).not.toHaveProperty("temperature");
  });
});
