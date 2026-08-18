/**
 * The translate draft stage's roster contract, against the REAL rotation.
 *
 * `draft.test.ts` stubs `rotateModels` out — deliberately, and it says why:
 * it is asserting this module's own ordering rather than the provider's loop.
 * The cost of that choice is that nothing checks the two are wired together,
 * and the wiring carries D12: `translate()` seeds its exhausted set from
 * `weather.starved` and hands `weather` to every rotation, so a model an
 * earlier thread already found to be out of quota is never asked again.
 * Removing either would change nothing any existing case can see.
 *
 * So this file mocks the rotation for nothing and drives the real one. Only
 * `score` is stubbed, because scoring a translation is a different module's
 * contract and its verdict is not what these cases are about.
 *
 * Every case asserts WHICH MODELS WERE ASKED, in order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Language } from "../../core/languages.js";
import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Provider,
} from "../../core/provider.js";
import type { Score } from "../../core/score.js";

import { translate, type TranslateRequest } from "./draft.js";
import { score } from "./score.js";

// Scoring is a module of its own with a suite of its own, and a real score
// would put a second module's judgement between a case and the assertion it
// is making about rotation. Nothing else is stubbed — the provider, the
// rotation and the sanitizer are all real.
vi.mock("./score.js", () => ({ score: vi.fn() }));

const mockedScore = vi.mocked(score);

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };

function scored(value: number, admissible = true): Score {
  return { value, admissible, reason: admissible ? null : "refused", checks: [] };
}

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

function request(over: Partial<TranslateRequest> = {}): TranslateRequest {
  return {
    provider: recording({}).provider,
    models: ["a"],
    source: "Có lỗi khi lưu.",
    from: vietnamese,
    to: english,
    languages: [vietnamese, english],
    drafts: 1,
    ...over,
  };
}

beforeEach(() => {
  mockedScore.mockReset();
  mockedScore.mockResolvedValue(scored(1));
});

describe("the translate roster is an ordered fallback chain", () => {
  it("asks_only_the_first_model_when_the_first_model_answers", async () => {
    const { provider, asked } = recording({ a: "There is an error on save." });

    const translation = await translate(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a"]);
    expect(translation.attempts.map((attempt) => attempt.model)).toEqual(["a"]);
  });

  it("falls_back_when_primary_model_fails", async () => {
    const { provider, asked } = recording({ b: "There is an error on save." });

    const translation = await translate(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(translation.attempts.map((attempt) => attempt.model)).toEqual(["b"]);
    expect(translation.failures.map((failure) => failure.model)).toEqual(["a"]);
  });

  it("falls_back_through_two_failures_before_the_third_answers", async () => {
    const { provider, asked } = recording({ c: "There is an error on save." });

    const translation = await translate(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b", "c"]);
    expect(translation.attempts.map((attempt) => attempt.model)).toEqual(["c"]);
  });

  it("drafts_nothing_and_names_every_model_when_all_models_are_exhausted", async () => {
    const { provider, asked } = recording({});

    const translation = await translate(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(translation.attempts).toEqual([]);
    expect(translation.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("already_failed_model_is_never_re_asked_on_a_later_draft", async () => {
    // Two drafts over a roster whose first model is dead: the second draft
    // must start from the models still standing, not from the top of the list.
    const { provider, asked } = recording({ b: "There is an error on save." });

    await translate(request({ provider, models: ["a", "b"], drafts: 2 }));

    expect(asked).toEqual(["a", "b", "b"]);
    expect(asked.filter((model) => model === "a")).toHaveLength(1);
  });

  it("stops_asking_once_every_model_in_the_roster_has_failed", async () => {
    const { provider, asked } = recording({});

    await translate(request({ provider, models: ["a", "b"], drafts: 3 }));

    // Not nine requests: once the roster is empty there is nobody left to ask.
    expect(asked).toEqual(["a", "b"]);
  });
});

describe("the translate stage under D12 weather", () => {
  it("never_asks_a_model_an_earlier_thread_already_grounded_from_draft_zero", async () => {
    // The seed that makes this true is `new Set(weather.starved)`. Without it
    // the first draft asks `busy` once more, per thread, for the whole sweep —
    // and learns nothing the run did not already know.
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: "There is an error on save." });

    const translation = await translate(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["live"]);
    expect(translation.attempts.map((attempt) => attempt.model)).toEqual(["live"]);
    // And off the list before rotation sees it, rather than rotated past
    // inside it: the seed is what stops a second `draft:` warning being
    // logged, on every thread of a sweep, for a model the run gave up on.
    expect(translation.failures).toEqual([]);
  });

  it("grounds_a_capacity_failed_model_so_the_next_thread_skips_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: { ok: false, model: "busy", reason: "HTTP 429", kind: "capacity" },
      live: "There is an error on save.",
    });

    await translate(request({ provider, weather, models: ["busy", "live"] }));
    expect(asked).toEqual(["busy", "live"]);

    await translate(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["busy", "live", "live"]);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("fails_the_run_red_the_instant_a_model_reports_an_auth_failure", async () => {
    const { provider, asked } = recording({
      a: { ok: false, model: "a", reason: "HTTP 401", kind: "auth" },
      b: "There is an error on save.",
    });

    await expect(translate(request({ provider, models: ["a", "b"] }))).rejects.toThrow(
      AuthenticationFailure,
    );
    expect(asked).toEqual(["a"]);
  });
});

describe("a malformed translate answer is not a draft", () => {
  it("rotates_past_a_length_truncated_answer_rather_than_posting_half_a_sentence", async () => {
    const { provider, asked } = recording({
      a: { ok: true, model: "a", content: "There is an err", finishReason: "length" },
      b: "There is an error on save.",
    });

    const translation = await translate(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(translation.attempts.map((attempt) => attempt.model)).toEqual(["b"]);
    expect(translation.failures[0]?.kind).toBe("protocol");
  });

  it("rotates_past_an_empty_answer_rather_than_appending_nothing_to_the_body", async () => {
    // `readCompletion` refuses empty content upstream, but a stage that
    // received one anyway must not treat it as a translation.
    const { provider, asked } = recording({
      a: {
        ok: false,
        model: "a",
        reason: "HTTP 200: answered with empty content",
        kind: "protocol",
      },
      b: "There is an error on save.",
    });

    const translation = await translate(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(translation.attempts.map((attempt) => attempt.model)).toEqual(["b"]);
  });

  it("keeps_a_refused_draft_out_of_the_ranking_while_still_naming_it", async () => {
    mockedScore.mockResolvedValue(scored(0.1, false));
    const { provider } = recording({ a: "Une traduction en français." });

    const translation = await translate(request({ provider }));

    expect(translation.attempts).toEqual([]);
    expect(translation.refused.map((attempt) => attempt.model)).toEqual(["a"]);
  });
});
