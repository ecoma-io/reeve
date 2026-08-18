/**
 * The triage verdict stage's roster contract.
 *
 * `verdict.test.ts` covers the parser — the guardrail — and one rotation case.
 * What it does not cover, and what a duty stage owes its run, is D12's
 * run-wide capacity memory: `triage()` takes a `Weather` and hands it to
 * `rotateModels`, and a version that quietly stopped doing so would still
 * pass every existing case. The consequence is invisible and expensive: a
 * sweep would re-ask a model it already found to be out of quota once per
 * thread, and `starved` would go out wrong on the run's own output.
 *
 * Every case asserts WHICH MODELS WERE ASKED, in order, alongside the verdict.
 * Nothing in the core is mocked; the real rotation runs.
 */
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Provider,
} from "../../core/provider.js";
import type { Label } from "../../core/warrant.js";

import { triage, type TriageRequest } from "./verdict.js";

const VERDICT = '{"labels": ["bug"], "confidence": 0.9, "rationale": "It crashes."}';

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
            ? { ok: false, model, reason: "no answer scripted", kind: "protocol" }
            : typeof answer === "string"
              ? { ok: true, model, content: answer, finishReason: "stop" }
              : answer,
        );
      }),
    },
  };
}

function label(): Label {
  return {
    name: "bug",
    description: "Something that used to work and does not.",
    not: null,
    examples: [],
    owner: null,
    exclusiveWith: [],
    confidence: null,
    paths: [],
    create: false,
    color: null,
  };
}

function request(over: Partial<TriageRequest> = {}): TriageRequest {
  return {
    provider: recording({}).provider,
    models: ["a"],
    title: "Crash on save",
    body: "It throws when I press save.",
    taxonomy: [label()],
    language: "English",
    recalled: [],
    ...over,
  };
}

describe("the triage roster is an ordered fallback chain", () => {
  it("asks_only_the_first_model_when_the_first_model_answers", async () => {
    const { provider, asked } = recording({ a: VERDICT });

    const triaged = await triage(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a"]);
    expect(triaged.verdict.labels).toEqual(["bug"]);
    expect(triaged.failures).toEqual([]);
  });

  it("falls_back_when_primary_model_fails", async () => {
    const { provider, asked } = recording({ b: VERDICT });

    const triaged = await triage(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(triaged.verdict.labels).toEqual(["bug"]);
    expect(triaged.failures.map((failure) => failure.model)).toEqual(["a"]);
  });

  it("falls_back_through_two_failures_before_the_third_answers", async () => {
    const { provider, asked } = recording({ c: VERDICT });

    const triaged = await triage(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b", "c"]);
    expect(triaged.verdict.labels).toEqual(["bug"]);
    expect(triaged.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("proposes_nothing_and_names_every_model_when_all_models_are_exhausted", async () => {
    const { provider, asked } = recording({});

    const triaged = await triage(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b", "c"]);
    expect(triaged.verdict.labels).toEqual([]);
    expect(triaged.failures.map((failure) => failure.model)).toEqual(["a", "b", "c"]);
    // Null rather than the answer: nobody answered, so there is nothing to
    // quote that the failures do not already say.
    expect(triaged.unreadable).toBeNull();
  });

  it("asks_nothing_at_all_for_an_empty_roster", async () => {
    const { provider, asked } = recording({ a: VERDICT });

    const triaged = await triage(request({ provider, models: [] }));

    expect(asked).toEqual([]);
    expect(triaged.verdict.labels).toEqual([]);
    expect(triaged.failures).toEqual([]);
  });
});

describe("the triage stage under D12 weather", () => {
  it("never_asks_a_model_an_earlier_stage_already_grounded_for_capacity", async () => {
    // The screen and the language step run before this one and share the run's
    // weather. A model they found to be out of room must not be re-bought here.
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: VERDICT });

    const triaged = await triage(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["live"]);
    expect(triaged.verdict.labels).toEqual(["bug"]);
    // The skip is still reported, so the run's own summary of what it tried
    // stays honest.
    expect(triaged.failures.map((failure) => failure.model)).toEqual(["busy"]);
  });

  it("grounds_a_capacity_failed_model_so_the_next_thread_in_the_sweep_skips_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: { ok: false, model: "busy", reason: "HTTP 429: out of quota", kind: "capacity" },
      live: VERDICT,
    });

    await triage(request({ provider, weather, models: ["busy", "live"] }));
    expect(asked).toEqual(["busy", "live"]);

    // Thread two of the same sweep. Without the run's weather reaching this
    // stage, `busy` would be asked — and refused — once per thread.
    await triage(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["busy", "live", "live"]);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("does_not_ground_a_model_that_failed_for_a_protocol_reason", async () => {
    // A malformed answer to one thread's prompt says nothing about the same
    // model on the next thread, so it keeps its place in the rotation.
    const weather = createWeather();
    const { provider } = recording({ b: VERDICT });

    await triage(request({ provider, weather, models: ["a", "b"] }));

    expect(weather.grounded("a")).toBe(false);
  });

  it("fails_the_run_red_the_instant_a_model_reports_an_auth_failure", async () => {
    const { provider, asked } = recording({
      a: { ok: false, model: "a", reason: "HTTP 401: invalid api key", kind: "auth" },
      b: VERDICT,
    });

    await expect(triage(request({ provider, models: ["a", "b"] }))).rejects.toThrow(
      AuthenticationFailure,
    );
    // Rotating would spend `b` proving the same key is still wrong.
    expect(asked).toEqual(["a"]);
  });
});

describe("a malformed triage answer is not a verdict", () => {
  it("malformed_model_output_is_rejected_and_handed_back_whole", async () => {
    const { provider } = recording({ a: "I think this is probably a bug." });

    const triaged = await triage(request({ provider }));

    expect(triaged.verdict.labels).toEqual([]);
    expect(triaged.verdict.confidence).toBe(0);
    // Handed back so the caller can warn with it: a model answering in prose
    // every run is a configuration problem otherwise invisible in a green run.
    expect(triaged.unreadable).toBe("I think this is probably a bug.");
  });

  it("does_not_rotate_past_an_answer_that_arrived_but_did_not_parse", async () => {
    // The answer was delivered; the stage is done. Rotating would ask a second
    // model the same question and charge for the same non-answer.
    const { provider, asked } = recording({ a: "not a verdict", b: VERDICT });

    const triaged = await triage(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a"]);
    expect(triaged.unreadable).toBe("not a verdict");
    expect(triaged.verdict.labels).toEqual([]);
  });

  it("mines_nothing_from_a_verdict_whose_confidence_did_not_parse", async () => {
    const { provider } = recording({ a: '{"labels": ["bug"], "confidence": "very"}' });

    const triaged = await triage(request({ provider }));

    // Half an answer is not a safer answer for having parsed: the labels are
    // discarded with the field that broke.
    expect(triaged.verdict.labels).toEqual([]);
    expect(triaged.unreadable).toBe('{"labels": ["bug"], "confidence": "very"}');
  });
});
