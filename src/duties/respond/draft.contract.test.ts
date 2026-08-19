/**
 * The respond draft stage's roster contract.
 *
 * `draft.test.ts` covers the parser and the spread of several drafts across a
 * roster. This adds the run-level half: the full fallback chain in order, the
 * auth stop, and the capacity memory that has to outlive the thread it was
 * learned on.
 *
 * Every case asserts WHICH MODELS WERE ASKED, in order. Nothing in the core is
 * mocked; the real rotation runs.
 */
import { describe, expect, it, vi } from "vitest";

import type { Correction } from "../../core/memory.js";
import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Provider,
} from "../../core/provider.js";
import type { Label } from "../../core/warrant.js";

import { draft, type DraftRequest } from "./draft.js";

const ATTEMPT =
  '{"text": "Thanks for the report — could you share the browser?", "confidence": 0.8}';

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

function request(over: Partial<DraftRequest> = {}): DraftRequest {
  return {
    provider: recording({}).provider,
    models: ["a"],
    title: "Crash on save",
    body: "It throws when I press save.",
    language: "English",
    standing: [label()],
    recalled: [] as readonly Correction[],
    guidance: null,
    drafts: 1,
    ...over,
  };
}

describe("the respond roster is an ordered fallback chain", () => {
  it("asks_only_the_first_model_when_the_first_model_answers", async () => {
    const { provider, asked } = recording({ a: ATTEMPT });

    const drafted = await draft(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a"]);
    expect(drafted.attempts.map((attempt) => attempt.model)).toEqual(["a"]);
  });

  it("falls_back_when_primary_model_fails", async () => {
    const { provider, asked } = recording({ b: ATTEMPT });

    const drafted = await draft(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(drafted.attempts.map((attempt) => attempt.model)).toEqual(["b"]);
    expect(drafted.failures.map((failure) => failure.model)).toEqual(["a"]);
  });

  it("falls_back_through_two_failures_before_the_third_answers", async () => {
    const { provider, asked } = recording({ c: ATTEMPT });

    const drafted = await draft(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b", "c"]);
    expect(drafted.attempts.map((attempt) => attempt.model)).toEqual(["c"]);
  });

  it("drafts_nothing_and_names_every_model_when_all_models_are_exhausted", async () => {
    const { provider, asked } = recording({});

    const drafted = await draft(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(drafted.attempts).toEqual([]);
    expect(drafted.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("already_failed_model_is_never_re_asked_on_a_later_draft", async () => {
    const { provider, asked } = recording({ b: ATTEMPT });

    await draft(request({ provider, models: ["a", "b"], drafts: 2 }));

    expect(asked).toEqual(["a", "b", "b"]);
    expect(asked.filter((model) => model === "a")).toHaveLength(1);
  });

  it("asks_nothing_when_no_drafts_were_requested", async () => {
    const { provider, asked } = recording({ a: ATTEMPT });

    const drafted = await draft(request({ provider, drafts: 0 }));

    expect(asked).toEqual([]);
    expect(drafted.attempts).toEqual([]);
  });
});

describe("the respond stage under D12 weather", () => {
  it("never_asks_a_model_an_earlier_stage_already_grounded_from_draft_zero", async () => {
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: ATTEMPT });

    const drafted = await draft(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["live"]);
    expect(drafted.attempts.map((attempt) => attempt.model)).toEqual(["live"]);
    // And off the list before rotation sees it, rather than rotated past
    // inside it: the seed is what stops a second `draft:` warning being
    // logged, on every thread of a sweep, for a model the run gave up on.
    expect(drafted.failures).toEqual([]);
  });

  it("grounds_a_capacity_failed_model_so_the_next_thread_skips_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: { ok: false, model: "busy", reason: "HTTP 429", kind: "capacity" },
      live: ATTEMPT,
    });

    await draft(request({ provider, weather, models: ["busy", "live"] }));
    await draft(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["busy", "live", "live"]);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("fails_the_run_red_the_instant_a_model_reports_an_auth_failure", async () => {
    const { provider, asked } = recording({
      a: { ok: false, model: "a", reason: "HTTP 401", kind: "auth" },
      b: ATTEMPT,
    });

    await expect(draft(request({ provider, models: ["a", "b"] }))).rejects.toThrow(
      AuthenticationFailure,
    );
    expect(asked).toEqual(["a"]);
  });
});

describe("a malformed respond answer is not a draft", () => {
  it("malformed_model_output_is_rejected_and_handed_back_whole", async () => {
    const { provider } = recording({ a: "Sure, I will fix that next week." });

    const drafted = await draft(request({ provider }));

    expect(drafted.attempts).toEqual([]);
    expect(drafted.unreadable).toEqual(["Sure, I will fix that next week."]);
  });

  it("rotates_past_a_length_truncated_answer_rather_than_posting_half_a_reply", async () => {
    const { provider, asked } = recording({
      a: { ok: true, model: "a", content: '{"text": "Thanks for the rep', finishReason: "length" },
      b: ATTEMPT,
    });

    const drafted = await draft(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(drafted.attempts.map((attempt) => attempt.model)).toEqual(["b"]);
    expect(drafted.failures[0]?.kind).toBe("protocol");
  });

  it("mines_nothing_from_an_attempt_whose_confidence_did_not_parse", async () => {
    const { provider } = recording({ a: '{"text": "Thanks!", "confidence": "high"}' });

    const drafted = await draft(request({ provider }));

    expect(drafted.attempts).toEqual([]);
    expect(drafted.unreadable).toHaveLength(1);
  });
});
