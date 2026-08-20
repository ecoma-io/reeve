/**
 * The cheap screen's roster contract, and its deliberate asymmetry.
 *
 * `spam.test.ts` pins what `sift` decides. This pins how it spends: which
 * models it asks and in what order, that a model this run already found to be
 * out of capacity is never asked again, and that a refused key stops the run
 * here as it does everywhere else.
 *
 * The asymmetry is the point of the last block. `sift` fails OPEN — a cheap
 * roster that could not answer carries the thread on to the expensive stage —
 * while the deterministic screen fails CLOSED. That is intended
 * (`docs/development/intent-matrix.md` disagreement 5, adjudicated 2026-08-18),
 * and it is asserted here so a reader who finds it surprising does not "fix"
 * it into a thread silently dropped on a read error.
 */
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Provider,
} from "./provider.js";
import { sift } from "./spam.js";

/** A provider that records which models it was asked, in order. */
function recording(answers: Record<string, string | Completion>): {
  provider: Provider;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    provider: {
      complete: vi.fn((model: string) => {
        asked.push(model);
        const answer = answers[model];
        return Promise.resolve<Completion>(
          answer === undefined
            ? { ok: false, model, reason: "no answer", kind: "protocol" }
            : typeof answer === "string"
              ? { ok: true, model, content: answer, finishReason: "stop" }
              : answer,
        );
      }),
    },
  };
}

function request(over: Partial<Parameters<typeof sift>[0]> = {}): Parameters<typeof sift>[0] {
  return {
    provider: recording({}).provider,
    models: ["cheap"],
    title: "Crash on save",
    body: "It throws when I press save.",
    about: "",
    ...over,
  };
}

describe("the cheap roster is a rotation", () => {
  it("asks_only_the_first_cheap_model_when_it_answers", async () => {
    const { provider, asked } = recording({ first: "keep" });

    await sift(request({ provider, models: ["first", "second", "third"] }));

    expect(asked).toEqual(["first"]);
  });

  it("falls_back_through_the_whole_cheap_roster_before_giving_up", async () => {
    const { provider, asked } = recording({ third: "spam" });

    const sifted = await sift(request({ provider, models: ["first", "second", "third"] }));

    expect(asked).toEqual(["first", "second", "third"]);
    expect(sifted.dropped?.reason).toBe("spam");
    expect(sifted.failures.map((failure) => failure.model)).toEqual(["first", "second"]);
  });

  it("asks_nothing_when_no_cheap_roster_is_configured", async () => {
    // An empty `screen-models` turns screening off. That is the documented
    // default, not a degraded mode, so nothing is spent and nothing is
    // dropped.
    const { provider, asked } = recording({ anything: "spam" });

    const sifted = await sift(request({ provider, models: [] }));

    expect(asked).toEqual([]);
    expect(sifted).toEqual({ dropped: null, failures: [] });
  });
});

describe("the cheap screen under D12 weather", () => {
  it("never_asks_a_model_an_earlier_stage_already_grounded_for_capacity", async () => {
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: "spam" });

    const sifted = await sift(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["live"]);
    expect(sifted.dropped?.reason).toBe("spam");
  });

  it("grounds_a_capacity_failed_cheap_model_so_the_next_thread_skips_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: { ok: false, model: "busy", reason: "HTTP 429", kind: "capacity" },
      live: "keep",
    });

    await sift(request({ provider, weather, models: ["busy", "live"] }));
    expect(asked).toEqual(["busy", "live"]);

    // The second thread of a sweep must not re-buy the same 429.
    await sift(request({ provider, weather, models: ["busy", "live"] }));
    expect(asked).toEqual(["busy", "live", "live"]);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("fails_the_run_red_when_a_cheap_model_reports_an_auth_failure", async () => {
    const { provider, asked } = recording({
      refused: { ok: false, model: "refused", reason: "HTTP 401", kind: "auth" },
      live: "keep",
    });

    await expect(sift(request({ provider, models: ["refused", "live"] }))).rejects.toThrow(
      AuthenticationFailure,
    );
    // A broken key is not something the cheap roster's fallback can vote past.
    expect(asked).toEqual(["refused"]);
  });
});

describe("the cheap screen fails OPEN — deliberately, unlike the deterministic screen", () => {
  it("carries_the_thread_on_when_every_cheap_model_failed", async () => {
    // Adjudicated intent: carrying on into the expensive stage beats dropping
    // a real report on a cheap model's read error. A dropped report costs a
    // contributor their answer; a carried-on one costs a request.
    const { provider, asked } = recording({});

    const sifted = await sift(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(sifted.dropped).toBeNull();
    expect(sifted.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("carries_the_thread_on_when_every_cheap_model_ran_out_of_capacity", async () => {
    const weather = createWeather();
    const { provider } = recording({
      a: { ok: false, model: "a", reason: "HTTP 429", kind: "capacity" },
      b: { ok: false, model: "b", reason: "HTTP 503", kind: "capacity" },
    });

    const sifted = await sift(request({ provider, weather, models: ["a", "b"] }));

    expect(sifted.dropped).toBeNull();
    expect(weather.grounded("a")).toBe(true);
    expect(weather.grounded("b")).toBe(true);
  });

  it("carries_the_thread_on_when_the_cheap_model_answered_something_that_is_not_a_verdict", async () => {
    const { provider } = recording({ cheap: "I am not sure about this one." });

    expect((await sift(request({ provider }))).dropped).toBeNull();
  });
});
