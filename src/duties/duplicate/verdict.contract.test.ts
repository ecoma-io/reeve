/**
 * The duplicate judge stage's roster contract.
 *
 * `verdict.test.ts` covers the parser and two rotation cases. This adds the
 * half a duty stage owes the run rather than the thread: the whole fallback
 * chain in order, the run-wide capacity memory, the auth stop, and the rule
 * that a verdict naming a thread the shortlist never offered is refused whole
 * however well-formed it looks.
 *
 * Every case asserts WHICH MODELS WERE ASKED, in order. Nothing in the core is
 * mocked; the real rotation runs.
 */
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Provider,
} from "../../core/provider.js";
import type { Candidate } from "./rank.js";

import { judge, NOTHING, type JudgeRequest } from "./verdict.js";

const CANDIDATES: readonly Candidate[] = [
  { number: 7, title: "Login button does nothing on Safari", body: "It just sits there." },
  { number: 9, title: "Export crashes on large files", body: "Throws on a 2GB export." },
];

const VERDICT = '{"duplicate_of": 7, "confidence": 0.9, "rationale": "same bug"}';

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

function request(over: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    provider: recording({}).provider,
    models: ["a"],
    title: "Sign-in click has no effect",
    body: "Clicking sign-in does nothing on Safari.",
    language: "en",
    candidates: CANDIDATES,
    ...over,
  };
}

describe("the duplicate roster is an ordered fallback chain", () => {
  it("asks_only_the_first_model_when_the_first_model_answers", async () => {
    const { provider, asked } = recording({ a: VERDICT });

    const judged = await judge(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a"]);
    expect(judged.verdict.duplicateOf).toBe(7);
    expect(judged.model).toBe("a");
  });

  it("falls_back_when_primary_model_fails", async () => {
    const { provider, asked } = recording({ b: VERDICT });

    const judged = await judge(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(judged.verdict.duplicateOf).toBe(7);
    // The comment's attribution names the model that actually answered, not
    // whatever the roster happens to list first.
    expect(judged.model).toBe("b");
  });

  it("falls_back_through_two_failures_before_the_third_answers", async () => {
    const { provider, asked } = recording({ c: VERDICT });

    const judged = await judge(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b", "c"]);
    expect(judged.model).toBe("c");
    expect(judged.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("answers_nothing_and_names_no_model_when_all_models_are_exhausted", async () => {
    const { provider, asked } = recording({});

    const judged = await judge(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(judged.verdict).toEqual(NOTHING);
    expect(judged.model).toBeNull();
    expect(judged.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("asks_nothing_when_the_shortlist_offered_no_candidates", async () => {
    // Asking a model to choose among zero options spends a request to learn
    // what was already known.
    const { provider, asked } = recording({ a: VERDICT });

    const judged = await judge(request({ provider, candidates: [] }));

    expect(asked).toEqual([]);
    expect(judged.verdict).toEqual(NOTHING);
    expect(judged.model).toBeNull();
  });
});

describe("the duplicate stage under D12 weather", () => {
  it("never_asks_a_model_an_earlier_stage_already_grounded_for_capacity", async () => {
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: VERDICT });

    const judged = await judge(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["live"]);
    expect(judged.model).toBe("live");
  });

  it("grounds_a_capacity_failed_model_so_the_next_thread_in_the_sweep_skips_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: { ok: false, model: "busy", reason: "HTTP 429", kind: "capacity" },
      live: VERDICT,
    });

    await judge(request({ provider, weather, models: ["busy", "live"] }));
    await judge(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["busy", "live", "live"]);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("fails_the_run_red_the_instant_a_model_reports_an_auth_failure", async () => {
    const { provider, asked } = recording({
      a: { ok: false, model: "a", reason: "HTTP 403", kind: "auth" },
      b: VERDICT,
    });

    await expect(judge(request({ provider, models: ["a", "b"] }))).rejects.toThrow(
      AuthenticationFailure,
    );
    expect(asked).toEqual(["a"]);
  });
});

describe("a malformed duplicate answer is not a verdict", () => {
  it("malformed_model_output_is_rejected_and_handed_back_whole", async () => {
    const { provider } = recording({ a: "I think #7 is the same thing." });

    const judged = await judge(request({ provider }));

    expect(judged.verdict).toEqual(NOTHING);
    expect(judged.unreadable).toBe("I think #7 is the same thing.");
    // Named anyway: the run has to be able to say who gave it the answer it
    // could not read.
    expect(judged.model).toBe("a");
  });

  it("refuses_a_verdict_naming_a_thread_the_shortlist_never_offered", async () => {
    // The guardrail that separates this duty from triage's looser check: a
    // well-formed verdict pointing at a thread nobody put on the ballot is an
    // answer to a different question, and it is discarded whole.
    const { provider } = recording({
      a: '{"duplicate_of": 404, "confidence": 0.99, "rationale": "surely"}',
    });

    const judged = await judge(request({ provider }));

    expect(judged.verdict).toEqual(NOTHING);
    expect(judged.unreadable).toContain("404");
  });

  it("rotates_past_a_length_truncated_answer_to_a_model_with_room_to_finish", async () => {
    // A cut-off answer can still happen to parse, and "best-effort parsed" is
    // exactly the leniency this duty refuses everywhere else. It is a failure
    // before rotation ever calls it a success.
    const { provider, asked } = recording({
      a: { ok: true, model: "a", content: VERDICT, finishReason: "length" },
      b: VERDICT,
    });

    const judged = await judge(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(judged.model).toBe("b");
    expect(judged.failures[0]?.kind).toBe("protocol");
  });
});
