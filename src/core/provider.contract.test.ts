/**
 * The provider failure matrix, driven through the whole real stack.
 *
 * `provider.test.ts` pins each piece on its own: `readCompletion` against a
 * body, `classifyStatus` against a status, `rotateModels` against an injected
 * `attempt`. What it never does is run one roster through all of them at once
 * — a real HTTP answer, classified, reckoned into `Weather`, rotated past —
 * and that seam is where a regression would sit unnoticed: every unit could
 * keep its own promise while the chain between them stopped falling back.
 *
 * So every case here asserts BOTH halves of the contract:
 *
 *   (a) WHICH MODELS WERE ASKED, in order — the list, not a count;
 *   (b) what the rotation finally delivered.
 *
 * (a) is the half that fails when `rotateModels` is changed to `models[0]`,
 * when a failure stops the chain instead of rotating past it, or when a model
 * is skipped. (b) is the half that fails when a provider failure is glossed
 * into a success.
 *
 * `fetch` is replaced rather than mocked away, exactly as `provider.test.ts`
 * does it: the `Response` objects below are real ones, built the way a
 * provider sends them. Nothing here reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthenticationFailure,
  createProvider,
  createRoutedProvider,
  createWeather,
  rosterExhausted,
  rotateModels,
  starved,
  type Completion,
  type Provider,
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
 * from `answers` and recording the order they were asked in.
 *
 * A model absent from `answers` is a 500 — capacity weather — so a case only
 * has to name the models whose answers it cares about, and never accidentally
 * turns an unnamed model into a protocol failure that would change the run's
 * colour.
 */
async function run(
  models: readonly string[],
  answers: Record<string, () => Response>,
  weather = createWeather(),
): Promise<{ asked: string[]; rotation: Awaited<ReturnType<typeof rotateModels>> }> {
  const asked: string[] = [];
  fetchMock.mockImplementation((_url, init) => {
    const model = askedModel(init);
    asked.push(model);
    const answer = answers[model];
    return Promise.resolve(
      answer === undefined
        ? new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 500 })
        : answer(),
    );
  });

  const provider = createProvider({ baseUrl: "https://api.example.test/v1", apiKey: "sk-test" });
  const rotation = await rotateModels(models, (model) => provider.complete(model, HELLO), weather);
  return { asked, rotation };
}

// ---------------------------------------------------------------------------
// The fallback chain itself: which models were asked, and in what order.
// ---------------------------------------------------------------------------

describe("the roster is an ordered fallback chain", () => {
  it("asks_only_the_first_model_when_the_first_model_succeeds", async () => {
    const { asked, rotation } = await run(["a", "b", "c"], { a: () => answered("from a") });

    expect(asked).toEqual(["a"]);
    expect(rotation.success?.model).toBe("a");
    expect(rotation.success?.content).toBe("from a");
    expect(rotation.failures).toEqual([]);
  });

  it("falls_back_when_primary_model_fails", async () => {
    const { asked, rotation } = await run(["a", "b", "c"], { b: () => answered("from b") });

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.success?.model).toBe("b");
    expect(rotation.success?.content).toBe("from b");
    expect(rotation.failures.map((failure) => failure.model)).toEqual(["a"]);
  });

  it("falls_back_through_two_failures_before_the_third_answers", async () => {
    const { asked, rotation } = await run(["a", "b", "c"], { c: () => answered("from c") });

    // The whole point of a roster: the third entry is reached, in order, with
    // nothing between it and the first skipped.
    expect(asked).toEqual(["a", "b", "c"]);
    expect(rotation.success?.model).toBe("c");
    expect(rotation.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("fails_when_all_models_are_exhausted", async () => {
    const { asked, rotation } = await run(["a", "b", "c"], {});

    expect(asked).toEqual(["a", "b", "c"]);
    expect(rotation.success).toBeNull();
    expect(rotation.failures.map((failure) => failure.model)).toEqual(["a", "b", "c"]);
  });

  it("skips_no_model_between_the_first_and_the_one_that_answered", async () => {
    // A roster long enough that an off-by-one — every other entry, the first
    // and the last, the tail only — leaves a visibly different list.
    const { asked } = await run(["a", "b", "c", "d", "e"], { e: () => answered("from e") });

    expect(asked).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("asks_nothing_at_all_for_an_empty_roster", async () => {
    const { asked, rotation } = await run([], { a: () => answered("from a") });

    expect(asked).toEqual([]);
    expect(rotation).toEqual({ success: null, failures: [] });
  });

  it("empty_roster_is_not_starved", async () => {
    // "Nobody configured this roster" and "this roster ran dry" are different
    // sentences for a maintainer, and `screen-models` left unset is the first.
    const weather = createWeather();
    await run([], {}, weather);

    expect(starved([], weather)).toBe(false);
    expect(rosterExhausted([], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A model that failed is never asked twice — inside one rotation and across
// the several a sweep makes.
// ---------------------------------------------------------------------------

describe("a model that already failed", () => {
  it("already_failed_model_is_never_re_asked_within_one_rotation", async () => {
    const { asked } = await run(["a", "b", "a", "c", "b"], { c: () => answered("from c") });

    // A roster carrying a repeat reaches rotation only when `parseModels` was
    // bypassed, but rotation must still not spend a second request proving the
    // same model is still down.
    expect(asked).toEqual([...new Set(asked)]);
    expect(asked.filter((model) => model === "a")).toHaveLength(1);
  });

  it("already_failed_model_is_never_re_asked_by_a_later_stage_in_the_same_run", async () => {
    const weather = createWeather();

    const first = await run(["a", "b"], { b: () => answered("from b") }, weather);
    expect(first.asked).toEqual(["a", "b"]);

    // Second stage, same run, same weather: `a` is grounded and must not cost
    // another request, and the rotation must carry on to `b` rather than stop.
    const second = await run(["a", "b"], { b: () => answered("again from b") }, weather);

    expect(second.asked).toEqual(["b"]);
    expect(second.rotation.success?.model).toBe("b");
    // The skip is still reported, so "what was tried" stays honest.
    expect(second.rotation.failures.map((failure) => failure.model)).toEqual(["a"]);
  });

  it("a_grounded_model_in_the_middle_of_the_roster_is_skipped_without_stopping_the_chain", async () => {
    const weather = createWeather();
    weather.ground("b");

    const { asked, rotation } = await run(
      ["a", "b", "c"],
      { c: () => answered("from c") },
      weather,
    );

    // `b` costs nothing and stops nothing: the chain continues past it to `c`.
    expect(asked).toEqual(["a", "c"]);
    expect(rotation.success?.model).toBe("c");
    expect(rotation.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Capacity is weather: rotate, remember, stay green.
// ---------------------------------------------------------------------------

describe("capacity failures are weather", () => {
  it.each([
    ["429 too many requests", 429],
    ["500 internal error", 500],
    ["502 bad gateway", 502],
    ["503 unavailable", 503],
    ["504 gateway timeout", 504],
  ])("rotates_past_%s_and_grounds_the_model_for_the_rest_of_the_run", async (_case, status) => {
    const weather = createWeather();
    const { asked, rotation } = await run(
      ["a", "b"],
      {
        a: () => new Response(JSON.stringify({ error: { message: "no room" } }), { status }),
        b: () => answered("from b"),
      },
      weather,
    );

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.success?.model).toBe("b");
    expect(rotation.failures[0]?.kind).toBe("capacity");
    expect(weather.grounded("a")).toBe(true);
    // Capacity is never a protocol exhaustion, whatever else went wrong.
    expect(rosterExhausted(["a", "b"], rotation.failures)).toBe(false);
  });

  it("reports_the_whole_roster_starved_when_every_model_ran_out_of_capacity", async () => {
    const weather = createWeather();
    const { asked, rotation } = await run(
      ["a", "b"],
      {
        a: () => new Response("{}", { status: 429 }),
        b: () => new Response("{}", { status: 503 }),
      },
      weather,
    );

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.success).toBeNull();
    expect(starved(["a", "b"], weather)).toBe(true);
    // Green-with-a-warning, not red: `rosterExhausted` is what turns a run
    // red, and a capacity-only run must never reach it.
    expect(rosterExhausted(["a", "b"], rotation.failures)).toBe(false);
  });

  it("a_network_error_is_capacity_and_grounds_the_whole_endpoint", async () => {
    const asked: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      asked.push(askedModel(init));
      return Promise.reject(new TypeError("fetch failed"));
    });

    const weather = createWeather();
    const provider = createProvider({ baseUrl: "https://api.example.test/v1", apiKey: "k" });
    const rotation = await rotateModels(
      ["a", "b"],
      (model) => provider.complete(model, HELLO),
      weather,
    );

    // A connection that never landed condemns the endpoint, so `b` — routed
    // to the same one — is not asked to prove it a second time.
    expect(asked).toEqual(["a"]);
    expect(rotation.success).toBeNull();
    expect(rotation.failures[0]?.kind).toBe("capacity");
    expect(weather.grounded("b")).toBe(true);
    expect(rosterExhausted(["a", "b"], rotation.failures)).toBe(false);
  });

  it("a_timeout_is_capacity_but_grounds_only_the_model_that_hit_it", async () => {
    // A large model can run past a deadline a small one never touches on the
    // same healthy endpoint, so the roster's next entry still gets its turn.
    const asked: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const model = askedModel(init);
      asked.push(model);
      if (model === "slow") {
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        return Promise.reject(timeout);
      }
      return Promise.resolve(answered("from quick"));
    });

    const weather = createWeather();
    const provider = createProvider({ baseUrl: "https://api.example.test/v1", apiKey: "k" });
    const rotation = await rotateModels(
      ["slow", "quick"],
      (model) => provider.complete(model, HELLO),
      weather,
    );

    expect(asked).toEqual(["slow", "quick"]);
    expect(rotation.success?.model).toBe("quick");
    expect(rotation.failures[0]?.reason).toContain("timed out");
    expect(weather.grounded("slow")).toBe(true);
    expect(weather.grounded("quick")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth is configuration: stop, do not rotate.
// ---------------------------------------------------------------------------

describe("auth failures stop the run rather than rotating", () => {
  it.each([
    ["401 unauthorized", 401],
    ["403 forbidden", 403],
  ])("throws_on_%s_without_asking_any_later_model", async (_case, status) => {
    const asked: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      asked.push(askedModel(init));
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status }),
      );
    });

    const provider = createProvider({ baseUrl: "https://api.example.test/v1", apiKey: "bad" });

    await expect(
      rotateModels(["a", "b", "c"], (model) => provider.complete(model, HELLO)),
    ).rejects.toThrow(AuthenticationFailure);

    // The whole contract in one assertion: a broken key is not weather, so
    // `b` and `c` are never spent proving the same key is still wrong.
    expect(asked).toEqual(["a"]);
  });

  it("throws_on_auth_even_when_a_later_model_would_have_answered", async () => {
    const asked: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const model = askedModel(init);
      asked.push(model);
      return Promise.resolve(
        model === "a" ? new Response("{}", { status: 401 }) : answered("from b"),
      );
    });

    const provider = createProvider({ baseUrl: "https://api.example.test/v1", apiKey: "bad" });

    await expect(
      rotateModels(["a", "b"], (model) => provider.complete(model, HELLO)),
    ).rejects.toThrow(AuthenticationFailure);
    expect(asked).toEqual(["a"]);
  });

  it("names_the_model_and_the_reason_on_the_thrown_failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
    );
    const provider = createProvider({ baseUrl: "https://api.example.test/v1", apiKey: "bad" });

    const thrown = await rotateModels(["a"], (model) => provider.complete(model, HELLO)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(AuthenticationFailure);
    expect((thrown as AuthenticationFailure).failure).toMatchObject({ model: "a", kind: "auth" });
    expect((thrown as AuthenticationFailure).message).toContain("invalid api key");
  });
});

// ---------------------------------------------------------------------------
// Malformed output is a failure, never a success.
// ---------------------------------------------------------------------------

describe("malformed model output is rejected, never delivered as an answer", () => {
  const malformed: readonly [string, () => Response][] = [
    ["a body that is not JSON", () => new Response("<html>gateway</html>", { status: 200 })],
    [
      "a 200 carrying an error object",
      () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 200 }),
    ],
    [
      "a 200 carrying an error string",
      () => new Response(JSON.stringify({ error: "quota exceeded" }), { status: 200 }),
    ],
    ["no choices field at all", () => new Response(JSON.stringify({ id: "x" }), { status: 200 })],
    [
      "an empty choices array",
      () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    ],
    [
      "content that is not a string",
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: [{ text: "hi" }] } }] }), {
          status: 200,
        }),
    ],
    [
      "content that is null",
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), {
          status: 200,
        }),
    ],
    [
      "content that is empty",
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    ],
    [
      "content that is only whitespace",
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "  \n " } }] }), {
          status: 200,
        }),
    ],
    [
      "a message that is missing entirely",
      () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop" }] }), { status: 200 }),
    ],
    ["an empty body", () => new Response("", { status: 200 })],
  ];

  it.each(malformed)("rotates past %s rather than accepting it", async (_case, response) => {
    const { asked, rotation } = await run(["a", "b"], { a: response, b: () => answered("from b") });

    // Rotation is the answer to a malformed body — not acceptance, and not a
    // stop. The next model gets its turn exactly as it would after a 500.
    expect(asked).toEqual(["a", "b"]);
    expect(rotation.success?.model).toBe("b");
    expect(rotation.success?.content).toBe("from b");
  });

  it.each(malformed)("classifies %s as protocol, never as capacity", async (_case, response) => {
    const weather = createWeather();
    const { rotation } = await run(["a"], { a: response }, weather);

    expect(rotation.success).toBeNull();
    expect(rotation.failures[0]?.kind).toBe("protocol");
    // Protocol is deliberately NOT grounded in Weather: a bad answer to one
    // prompt says nothing about whether the model would answer another well.
    expect(weather.grounded("a")).toBe(false);
    expect(starved(["a"], weather)).toBe(false);
  });

  it("a_whole_roster_of_malformed_answers_is_protocol_exhaustion_not_starvation", async () => {
    // The distinction that decides the run's colour: all-protocol is red,
    // all-capacity is green. Collapsing the two loses the difference between
    // "the provider is busy" and "the configuration is wrong".
    const weather = createWeather();
    const { asked, rotation } = await run(
      ["a", "b"],
      {
        a: () => new Response("not json", { status: 200 }),
        b: () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      },
      weather,
    );

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.success).toBeNull();
    expect(rosterExhausted(["a", "b"], rotation.failures)).toBe(true);
    expect(starved(["a", "b"], weather)).toBe(false);
  });

  it("a_mixed_capacity_and_protocol_roster_is_exhaustion_even_though_it_is_not_starvation", async () => {
    // The false green this round found, driven end to end. One model is rate
    // limited and the next serves prose where JSON was demanded, so nothing
    // usable comes back and the roster is spent.
    //
    // `starved` is correctly false — not every model was grounded, so a later
    // stage could still try one. What was wrong was the other half: the
    // exhaustion predicate asked whether EVERY failure was a protocol error,
    // which the 429 made false, so the duty warned about nothing and exited 0
    // with `responded=false`. That is byte for byte what a run that decided
    // there was nothing to do writes, and D5 does not allow the two to look
    // alike.
    const weather = createWeather();
    const { rotation } = await run(
      ["a", "b"],
      {
        a: () => new Response("{}", { status: 429 }),
        b: () => new Response("not json", { status: 200 }),
      },
      weather,
    );

    expect(rotation.success).toBeNull();
    expect(rotation.failures.map((failure) => failure.kind)).toEqual(["capacity", "protocol"]);
    expect(rosterExhausted(["a", "b"], rotation.failures)).toBe(true);
    expect(starved(["a", "b"], weather)).toBe(false);
  });

  it("an_all_capacity_roster_is_starvation_and_not_exhaustion", async () => {
    // The other side of the same line, so the case above cannot be satisfied
    // by a predicate that simply says yes: weather alone stays green, reported
    // through `starved`, which is D12.
    const weather = createWeather();
    const { rotation } = await run(
      ["a", "b"],
      {
        a: () => new Response("{}", { status: 429 }),
        b: () => new Response("{}", { status: 503 }),
      },
      weather,
    );

    expect(rotation.success).toBeNull();
    expect(rosterExhausted(["a", "b"], rotation.failures)).toBe(false);
    expect(starved(["a", "b"], weather)).toBe(true);
  });

  it("a_non_2xx_with_no_error_field_still_fails_rather_than_answering_empty", async () => {
    const { asked, rotation } = await run(["a", "b"], {
      a: () => new Response("upstream said no", { status: 502 }),
      b: () => answered("from b"),
    });

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.failures[0]?.reason).toContain("upstream said no");
    expect(rotation.success?.content).toBe("from b");
  });

  it("a_200_carrying_both_an_error_and_a_usable_choice_is_refused_not_mined", async () => {
    // The dangerous shape: a gateway that reports the failure in the body and
    // still fills `choices` with something. Reading the choice would post an
    // answer the provider itself just disowned, so the body's error is read
    // BEFORE the choice and the whole response is refused.
    const { asked, rotation } = await run(["a", "b"], {
      a: () =>
        new Response(
          JSON.stringify({
            error: { message: "quota exceeded" },
            choices: [{ message: { content: "a half-finished answer" } }],
          }),
          { status: 200 },
        ),
      b: () => answered("from b"),
    });

    expect(asked).toEqual(["a", "b"]);
    expect(rotation.failures[0]?.reason).toContain("quota exceeded");
    expect(rotation.failures[0]?.kind).toBe("protocol");
    expect(rotation.success?.content).toBe("from b");
  });

  it("an_empty_error_object_beside_a_good_answer_is_punctuation_not_a_failure", async () => {
    // `error: {}` is what several gateways send on every response, successful
    // or not. Refusing on it would rotate past every model on the roster for
    // a field that reports nothing.
    const { asked, rotation } = await run(["a", "b"], {
      a: () =>
        new Response(JSON.stringify({ error: {}, choices: [{ message: { content: "from a" } }] }), {
          status: 200,
        }),
    });

    expect(asked).toEqual(["a"]);
    expect(rotation.success?.content).toBe("from a");
    expect(rotation.failures).toEqual([]);
  });

  it("an_error_field_carrying_nothing_does_not_condemn_a_good_answer", async () => {
    // Several gateways send `error: null` alongside a perfectly good answer.
    // Rotating past that would be rotating past punctuation.
    const { asked, rotation } = await run(["a", "b"], {
      a: () =>
        new Response(
          JSON.stringify({ error: null, choices: [{ message: { content: "from a" } }] }),
          { status: 200 },
        ),
    });

    expect(asked).toEqual(["a"]);
    expect(rotation.success?.content).toBe("from a");
  });
});

// ---------------------------------------------------------------------------
// The routed provider: the same contract, across endpoints.
// ---------------------------------------------------------------------------

describe("rotation across endpoints", () => {
  it("rotates_from_a_failing_endpoint_to_a_model_on_another_one", async () => {
    const asked: string[] = [];
    fetchMock.mockImplementation((url, init) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const model = askedModel(init);
      asked.push(`${model}@${target.includes("fast") ? "fast" : "default"}`);
      return Promise.resolve(
        target.includes("fast")
          ? new Response("{}", { status: 500 })
          : answered("from the default endpoint"),
      );
    });

    const provider: Provider = createRoutedProvider([
      { alias: null, baseUrl: "https://default.test/v1", apiKey: "k", timeoutMs: 1000 },
      { alias: "fast", baseUrl: "https://fast.test/v1", apiKey: "k2", timeoutMs: 1000 },
    ]);

    const rotation = await rotateModels(
      ["m@fast", "m"],
      (model) => provider.complete(model, HELLO),
      createWeather(new Set(["fast"]), ["m@fast", "m"]),
    );

    // `@fast` is stripped before the request but kept on the completion, so
    // the roster's own id is what a caller reads back.
    expect(asked).toEqual(["m@fast", "m@default"]);
    expect(rotation.success?.model).toBe("m");
    expect(rotation.failures.map((failure) => failure.model)).toEqual(["m@fast"]);
  });

  it("routes_an_undeclared_at_suffix_to_the_default_endpoint_rather_than_failing", async () => {
    // `@nowhere` was never declared, so it is part of the id — a provider's
    // own catalogue routinely contains one — and the request goes to the
    // default endpoint with the id untouched.
    const { asked, rotation } = await run(["m@nowhere"], { "m@nowhere": () => answered("ok") });

    expect(asked).toEqual(["m@nowhere"]);
    expect(rotation.success?.model).toBe("m@nowhere");
  });

  it("refuses_a_plain_id_when_no_default_endpoint_was_configured", async () => {
    // Every alias is declared, none of them is the default, and a plain id
    // has nowhere to go. That is a configuration error reported as a protocol
    // failure — not a silently dropped request, and not a network call.
    const provider = createRoutedProvider([
      { alias: "fast", baseUrl: "https://fast.test/v1", apiKey: "k", timeoutMs: 1000 },
    ]);

    const completion: Completion = await provider.complete("m", HELLO);

    expect(completion.ok).toBe(false);
    expect(completion.ok ? "" : completion.kind).toBe("protocol");
    expect(completion.ok ? "" : completion.reason).toContain("no endpoint");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
