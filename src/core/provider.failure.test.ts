/**
 * The provider boundary under the failures a weak endpoint actually produces.
 *
 * `provider.test.ts` pins each reader against a body it was handed;
 * `provider.contract.test.ts` drives a roster through the whole stack. What
 * neither covers is the set of shapes where a *status line and a body
 * disagree* — a 401 delivered as an HTML login page, a 502 that still carries
 * a `choices` array, a body that stops mid-token — plus the two seams nothing
 * asserts at all: that the configured timeout is the deadline a request
 * genuinely carries, and that a roster which answered nothing names every
 * model it burned.
 *
 * The invariant every case here serves: **a provider failure must never
 * produce a false green.** Either the answer is usable, or the failure is
 * reported in a form a caller can act on. Nothing in between.
 *
 * `fetch` is replaced, never mocked away — the `Response` objects are real
 * ones, built the way a free gateway builds them. Nothing here reaches a
 * network, and nothing may.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthenticationFailure,
  createProvider,
  createWeather,
  protocolExhausted,
  rotateModels,
  starved,
  type Completion,
  type Failure,
  type Provider,
  type Weather,
} from "./provider.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HELLO = [{ role: "user", content: "hello" }] as const;

function subject(timeoutMs?: number): Provider {
  return createProvider({
    baseUrl: "https://api.example.test/v1",
    apiKey: "sk-test",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** Narrows for assertions, failing the test rather than the type checker. */
function expectFailure(completion: Completion): Failure {
  if (completion.ok) throw new Error(`expected a failure, got: ${completion.content}`);
  return completion;
}

/** A body a provider sends when the answer is good. */
function answered(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
  });
}

/** The model id the stub was asked for, read back out of the request body. */
function askedModel(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("expected a string body");
  const parsed = JSON.parse(init.body) as { model?: unknown };
  if (typeof parsed.model !== "string") throw new Error("expected a model id");
  return parsed.model;
}

/**
 * A run of the real rotation over the real provider, answering each model id
 * from `answers` and recording the order they were asked in. A model absent
 * from `answers` answers a 500, so a case names only the models it cares
 * about.
 */
async function run(
  models: readonly string[],
  answers: Record<string, () => Response>,
  weather: Weather = createWeather(),
): Promise<{ asked: string[]; rotation: Awaited<ReturnType<typeof rotateModels>> }> {
  const asked: string[] = [];
  fetchMock.mockImplementation((_url, init) => {
    const model = askedModel(init);
    asked.push(model);
    const answer = answers[model];
    return Promise.resolve(answer === undefined ? new Response("{}", { status: 500 }) : answer());
  });

  const provider = subject();
  const rotation = await rotateModels(models, (model) => provider.complete(model, HELLO), weather);
  return { asked, rotation };
}

// ---------------------------------------------------------------------------
// The status and the body disagree. The status still decides what it means.
// ---------------------------------------------------------------------------

describe("a status line whose body is not JSON keeps the status's own meaning", () => {
  // The classification tests elsewhere all hand the reader a JSON body, so
  // every one of them reaches `classifyStatus` through the same branch. A
  // gateway refusing a key answers with its own HTML page far more often than
  // with a JSON error, and that body takes the `JSON.parse` failure branch
  // instead — where a classification derived after the parse rather than
  // before it would silently downgrade every one of these to `protocol`.
  const HTML = "<!doctype html><html><head><title>Forbidden</title></head><body>no</body></html>";

  it.each([
    { label: "a 401 delivered as an HTML login page", status: 401, body: HTML, kind: "auth" },
    { label: "a 403 delivered as an HTML block page", status: 403, body: HTML, kind: "auth" },
    {
      label: "a 429 delivered as an HTML rate-limit page",
      status: 429,
      body: HTML,
      kind: "capacity",
    },
    {
      label: "a 503 delivered as an HTML maintenance page",
      status: 503,
      body: HTML,
      kind: "capacity",
    },
    { label: "a 500 with no body at all", status: 500, body: "", kind: "capacity" },
    { label: "a 400 delivered as an HTML error page", status: 400, body: HTML, kind: "protocol" },
  ])("classifies $label as $kind", async ({ status, body, kind }) => {
    fetchMock.mockResolvedValue(new Response(body, { status }));

    expect(expectFailure(await subject().complete("m", HELLO)).kind).toBe(kind);
  });

  it("stops the run on an HTML 401 rather than rotating past it as a bad answer", async () => {
    // The consequence of the row above, and the reason it is worth a test of
    // its own: `auth` is the one kind that throws. Read as `protocol`, this
    // run would quietly spend `b` and `c` re-proving the same broken key —
    // and on a multi-endpoint roster it would leave the endpoint unrecorded,
    // so nothing would ever say which key was refused.
    const asked: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      asked.push(askedModel(init));
      return Promise.resolve(new Response(HTML, { status: 401 }));
    });

    const provider = subject();
    await expect(
      rotateModels(["a", "b", "c"], (model) => provider.complete(model, HELLO)),
    ).rejects.toThrow(AuthenticationFailure);
    expect(asked).toEqual(["a"]);
  });

  it("grounds a model behind an HTML 429 so nothing asks it again this run", async () => {
    const weather = createWeather();
    const { rotation } = await run(
      ["a", "b"],
      { a: () => new Response(HTML, { status: 429 }), b: () => answered("from b") },
      weather,
    );

    // Read as `protocol` instead, `a` would stay ungrounded and every later
    // thread of a sweep would spend a request confirming the same limit.
    expect(weather.grounded("a")).toBe(true);
    expect(rotation.success?.content).toBe("from b");
  });
});

// ---------------------------------------------------------------------------
// A failed response is never mined for the text it happens to contain.
// ---------------------------------------------------------------------------

describe("a failed response is never mined for the answer it happens to carry", () => {
  it("refuses a 502 whose body also carries a perfectly well-formed choice", async () => {
    // The mirror of the "200 with an error object" case, and the more
    // dangerous half: here the body is a valid completion and only the status
    // says otherwise. A reader that checked `choices` before the status would
    // publish a gateway's cached or partial answer as somebody's translation.
    const leaked = "Đây là bản dịch";
    const { asked, rotation } = await run(["a", "b"], {
      a: () =>
        new Response(JSON.stringify({ choices: [{ message: { content: leaked } }] }), {
          status: 502,
        }),
      b: () => answered("from b"),
    });

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.failures[0]?.kind).toBe("capacity");
    expect(rotation.failures[0]?.reason).toContain("HTTP 502");
    expect(rotation.success?.content).toBe("from b");
  });

  it("refuses a body that stops mid-JSON rather than reading the half that arrived", async () => {
    // A model that stopped partway through, or a connection cut after the
    // first packet. The bytes that arrived are a prefix of a valid answer, and
    // a lenient reader would hand back the truncated string as content.
    const { asked, rotation } = await run(["a", "b"], {
      a: () => new Response('{"choices":[{"message":{"content":"Xin ch', { status: 200 }),
      b: () => answered("from b"),
    });

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.failures[0]?.kind).toBe("protocol");
    expect(rotation.failures[0]?.reason).toContain("body was not JSON");
    expect(rotation.success?.content).toBe("from b");
  });
});

// ---------------------------------------------------------------------------
// The deadline: configured, and actually carried.
// ---------------------------------------------------------------------------

describe("the configured timeout is the deadline a request actually carries", () => {
  it("aborts a request that outlives its budget and names the budget it exceeded", async () => {
    // Everything else about timeouts is pinned against an injected rejection,
    // which proves how a `TimeoutError` is *read* and nothing about whether
    // one would ever be raised. This drives the real `AbortSignal` the request
    // was given: swap `config.timeoutMs` for the module default and the
    // request below never aborts at all.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("the request carried no abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
    );

    const failure = expectFailure(await subject(25).complete("m", HELLO));

    expect(failure.reason).toBe("request timed out after 25ms");
    expect(failure.kind).toBe("capacity");
    // A deadline that passed says nothing about the endpoint — a large model
    // can outrun a budget a small one never touches — so the pair is demoted
    // and every other model behind the same gateway keeps its turn.
    expect(failure.transport).toBeUndefined();
  });

  it("names a timeout that fired while the body was still arriving, and rotates on", async () => {
    // Headers arrived, so this is not a transport failure — but the run still
    // has to be able to tell "the gateway hung up" from "the deadline passed",
    // because only one of those is a reason to raise `request-timeout`.
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";

    const asked: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const model = askedModel(init);
      asked.push(model);
      if (model !== "a") return Promise.resolve(answered("from b"));
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(timeout);
            },
          }),
          { status: 200 },
        ),
      );
    });

    const weather = createWeather();
    const provider = subject(9000);
    const rotation = await rotateModels(
      ["a", "b"],
      (model) => provider.complete(model, HELLO),
      weather,
    );

    const failure = rotation.failures[0];
    expect(failure?.reason).toContain("could not be read");
    expect(failure?.reason).toContain("timed out after 9000ms");
    expect(failure?.kind).toBe("capacity");
    // The status line proves the endpoint reachable, so only this pair is
    // demoted — `b` behind the same gateway is still asked, and answers.
    expect(failure?.transport).toBeUndefined();
    expect(asked).toEqual(["a", "b"]);
    expect(rotation.success?.content).toBe("from b");
  });
});

// ---------------------------------------------------------------------------
// Exhaustion: a roster that answered nothing must be legible as exactly that.
// ---------------------------------------------------------------------------

describe("a roster no model on it can serve", () => {
  it("asks every unknown model in order and reports exhaustion rather than starvation", async () => {
    // The roster-mismatch case: three ids nobody at this endpoint has ever
    // heard of. It is a configuration error, not weather, and D5 says the run
    // goes red — so `protocolExhausted` must be true and `starved` false, and
    // nothing may be grounded, because a model that does not exist tells the
    // run nothing about the endpoint's capacity.
    const missing = (id: string) => () =>
      new Response(JSON.stringify({ error: { message: `The model \`${id}\` does not exist` } }), {
        status: 404,
      });

    const weather = createWeather();
    const { asked, rotation } = await run(
      ["gone-1", "gone-2", "gone-3"],
      { "gone-1": missing("gone-1"), "gone-2": missing("gone-2"), "gone-3": missing("gone-3") },
      weather,
    );

    expect(asked).toEqual(["gone-1", "gone-2", "gone-3"]);
    expect(rotation.success).toBeNull();
    expect(protocolExhausted(["gone-1", "gone-2", "gone-3"], rotation.failures)).toBe(true);
    expect(starved(["gone-1", "gone-2", "gone-3"], weather)).toBe(false);
    expect(rotation.failures.map((failure) => failure.model)).toEqual([
      "gone-1",
      "gone-2",
      "gone-3",
    ]);
    // Each failure carries the provider's own words, so the red run's message
    // names which id was wrong rather than saying the roster failed.
    expect(rotation.failures[1]?.reason).toContain("`gone-2` does not exist");
  });

  it("names one failure per model, including the ones weather skipped without asking", async () => {
    // The raw material every "did this run actually do anything" check is
    // built from. A rotation that returned `success: null` and a short
    // `failures` list would let a caller conclude the roster was never tried
    // — which is the shape of a false green, because "nothing to do" and
    // "nothing could be reached" would read the same.
    const weather = createWeather();
    weather.ground("a");

    const { asked, rotation } = await run(
      ["a", "b", "c"],
      {
        b: () => new Response("{}", { status: 500 }),
        c: () => new Response("not json at all", { status: 200 }),
      },
      weather,
    );

    // `a` was never asked — it was grounded earlier in the run — and it is
    // still reported, with a reason that says why no request was spent on it.
    expect(asked).toEqual(["b", "c"]);
    expect(rotation.success).toBeNull();
    expect(rotation.failures.map((failure) => failure.model)).toEqual(["a", "b", "c"]);
    expect(rotation.failures[0]?.reason).toContain("already rotated past for capacity");
  });

  it("ends the run red on an auth failure found late, after earlier models failed on capacity", async () => {
    // A roster whose first model is merely out of quota and whose second
    // reveals the key was never going to work. The accumulated capacity
    // failures must not soften the auth one into "just another entry in the
    // list": `reckon` throws past every model still on the roster, so `c` —
    // which would have answered — is never asked.
    const asked: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const model = askedModel(init);
      asked.push(model);
      if (model === "a") return Promise.resolve(new Response("{}", { status: 429 }));
      if (model === "b") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
        );
      }
      return Promise.resolve(answered("from c"));
    });

    const weather = createWeather();
    const provider = subject();
    const thrown = await rotateModels(
      ["a", "b", "c"],
      (model) => provider.complete(model, HELLO),
      weather,
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AuthenticationFailure);
    expect((thrown as AuthenticationFailure).failure.model).toBe("b");
    expect(asked).toEqual(["a", "b"]);
    expect(weather.grounded("a")).toBe(true);
  });
});
