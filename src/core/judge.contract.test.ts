/**
 * The judge panel's availability chain — the `|` grammar, under D12.
 *
 * A panel is not a rotation, and `judge.ts` says so: it keeps its own loop
 * because a seat stops on a usable *vote* where `rotateModels` stops on a
 * usable *completion*. That duplication is deliberate, and it is exactly why
 * it needs its own contract: every rule `rotateModels` enforces has a second,
 * independent implementation here, and a change to one is not a change to the
 * other.
 *
 * `judge.test.ts` pins the chain's happy paths — a seat falls back, one model
 * votes once, a spent seat reports itself. What it does not pin, and what this
 * file adds, is the half of D12 that lives in `reckon`:
 *
 *   - an `auth` failure inside a panel ends the run red, exactly as it does
 *     inside a rotation — a broken key is not something a second judge can
 *     vote its way past;
 *   - a `capacity` failure inside a panel is remembered in `Weather`, so a
 *     later seat, a later stage and a later thread all skip that model;
 *   - a model already grounded is skipped WITHOUT ending its seat's chain.
 *
 * Every case asserts which models were asked, in order, alongside the verdict.
 */
import { describe, expect, it, vi } from "vitest";

import { judge, type JudgeRequest } from "./judge.js";
import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Failure,
  type Provider,
} from "./provider.js";

interface Candidate {
  readonly model: string;
  readonly text: string;
}

function candidate(model: string): Candidate {
  return { model, text: `An answer from ${model}.` };
}

function ballot(shown: readonly Candidate[]): { role: "user"; content: string }[] {
  return [
    {
      role: "user",
      content: shown
        .map((entry, at) => `--- CANDIDATE ${String(at + 1)} ---\n${entry.text}`)
        .join("\n\n"),
    },
  ];
}

/**
 * A provider that records every model it was asked, in order, and answers each
 * from `answers`. A model absent from `answers` fails with a protocol error —
 * the shape that neither grounds a model nor ends a run, so a case's own
 * failures are the only ones with consequences.
 */
function recording(answers: Record<string, string | Completion>): {
  provider: Provider;
  asked: string[];
} {
  const asked: string[] = [];
  const provider: Provider = {
    complete: vi.fn((model: string): Promise<Completion> => {
      asked.push(model);
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({ ok: false, model, reason: "no answer", kind: "protocol" });
      }
      return Promise.resolve(
        typeof answer === "string"
          ? { ok: true, model, content: answer, finishReason: "stop" }
          : answer,
      );
    }),
  };
  return { provider, asked };
}

/** One failure of a named kind, as a provider would hand it back. */
function failure(model: string, kind: Failure["kind"]): Failure {
  return { ok: false, model, kind, reason: `${model} said ${kind}` };
}

function request(over: Partial<JudgeRequest<Candidate>> = {}): JudgeRequest<Candidate> {
  return {
    provider: recording({}).provider,
    judges: [],
    candidates: [candidate("first"), candidate("second")],
    by: (entry) => entry.model,
    ballot,
    ...over,
  };
}

describe("a seat's `|` chain is an availability chain", () => {
  it("asks_only_the_first_model_of_a_seat_when_it_votes", async () => {
    const { provider, asked } = recording({ primary: "1" });

    const verdict = await judge(request({ provider, judges: [["primary", "backup", "third"]] }));

    expect(asked).toEqual(["primary"]);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["primary"]);
  });

  it("falls_back_within_a_seat_when_the_first_model_fails", async () => {
    const { provider, asked } = recording({ backup: "1" });

    const verdict = await judge(request({ provider, judges: [["primary", "backup"]] }));

    expect(asked).toEqual(["primary", "backup"]);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["backup"]);
  });

  it("falls_back_through_two_failures_before_the_third_link_votes", async () => {
    const { provider, asked } = recording({ third: "2" });

    const verdict = await judge(request({ provider, judges: [["primary", "backup", "third"]] }));

    // A seat is one voter however far down its chain the vote came from.
    expect(asked).toEqual(["primary", "backup", "third"]);
    expect(verdict.votes).toHaveLength(1);
    expect(verdict.votes[0]?.model).toBe("third");
    expect(verdict.decidedBy).toBe("judges");
  });

  it("casts_nothing_and_leaves_the_score_deciding_when_a_whole_chain_fails", async () => {
    const { provider, asked } = recording({});

    const verdict = await judge(request({ provider, judges: [["primary", "backup"]] }));

    expect(asked).toEqual(["primary", "backup"]);
    expect(verdict.votes).toEqual([]);
    expect(verdict.decidedBy).toBe("score");
    expect(verdict.winner?.model).toBe("first");
    expect(verdict.failures.map((entry) => entry.model)).toEqual(["primary", "backup"]);
  });
});

describe("D12 inside a panel: capacity is weather", () => {
  it("grounds_a_capacity_failed_judge_so_a_later_seat_never_asks_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: failure("busy", "capacity"),
      other: "1",
    });

    const verdict = await judge(
      request({ provider, weather, judges: [["busy", "other"], ["busy"]] }),
    );

    // Seat one rotates past `busy` to `other`. Seat two names `busy` again —
    // and must not spend a request on a model this run already knows is out.
    expect(asked).toEqual(["busy", "other"]);
    expect(weather.grounded("busy")).toBe(true);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["other"]);
  });

  it("skips_a_grounded_model_mid_chain_without_ending_its_seat", async () => {
    // The invariant a `break` would quietly destroy: a grounded link costs
    // nothing AND stops nothing. The seat keeps walking to the link that can
    // still vote.
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: "1" });

    const verdict = await judge(request({ provider, weather, judges: [["busy", "live"]] }));

    expect(asked).toEqual(["live"]);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["live"]);
    // The skip is reported rather than hidden, so a panel that cast fewer
    // votes than it was configured for says why.
    expect(verdict.failures.map((entry) => entry.model)).toEqual(["busy"]);
  });

  it("skips_a_grounded_first_link_and_a_grounded_second_before_reaching_the_third", async () => {
    const weather = createWeather();
    weather.ground("busy");
    weather.ground("alsoBusy");
    const { provider, asked } = recording({ live: "1" });

    const verdict = await judge(
      request({ provider, weather, judges: [["busy", "alsoBusy", "live"]] }),
    );

    expect(asked).toEqual(["live"]);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["live"]);
    expect(verdict.failures.map((entry) => entry.model)).toEqual(["busy", "alsoBusy"]);
  });

  it("leaves_a_capacity_grounded_model_alone_but_not_a_protocol_failed_one", async () => {
    // Protocol is deliberately not weather: a bad ballot from one prompt says
    // nothing about the same model on a different one, so a later stage may
    // still ask it.
    const weather = createWeather();
    const { provider } = recording({ spoiled: "no number here" });

    await judge(request({ provider, weather, judges: [["spoiled"]] }));

    expect(weather.grounded("spoiled")).toBe(false);
  });
});

describe("D12 inside a panel: auth is configuration", () => {
  it("fails_the_run_red_when_a_judge_reports_an_auth_failure", async () => {
    // The gap this closes: `rotateModels` throws on auth, and a panel keeps
    // its own loop. Nothing before this asserted that the second loop obeys
    // the same rule — a run whose key was refused during judging must not
    // finish green with the score quietly deciding instead.
    const { provider, asked } = recording({ refused: failure("refused", "auth") });

    await expect(judge(request({ provider, judges: [["refused", "backup"]] }))).rejects.toThrow(
      AuthenticationFailure,
    );

    // And it must not rotate: the same key is wrong for the seat's fallback.
    expect(asked).toEqual(["refused"]);
  });

  it("throws_before_a_later_seat_is_asked_anything", async () => {
    const { provider, asked } = recording({
      refused: failure("refused", "auth"),
      willing: "1",
    });

    await expect(judge(request({ provider, judges: [["refused"], ["willing"]] }))).rejects.toThrow(
      AuthenticationFailure,
    );

    expect(asked).toEqual(["refused"]);
  });

  it("names_the_model_and_reason_on_the_thrown_auth_failure", async () => {
    const { provider } = recording({ refused: failure("refused", "auth") });

    const thrown = await judge(request({ provider, judges: [["refused"]] })).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(AuthenticationFailure);
    expect((thrown as AuthenticationFailure).failure).toMatchObject({
      model: "refused",
      kind: "auth",
    });
  });

  it("records_rather_than_throws_when_a_second_endpoint_might_still_answer", async () => {
    // The multi-endpoint amendment: judgement is deferred to `settleAuth`, so
    // a panel whose first endpoint refused the key still asks the seat's
    // fallback on the endpoint that has not.
    const weather = createWeather(new Set(["fast"]), ["j@fast", "j2"]);
    const { provider, asked } = recording({
      "j@fast": { ok: false, model: "j@fast", kind: "auth", reason: "refused", endpoint: "fast" },
      j2: "1",
    });

    const verdict = await judge(request({ provider, weather, judges: [["j@fast", "j2"]] }));

    expect(asked).toEqual(["j@fast", "j2"]);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["j2"]);
    expect(weather.authFailures.map((entry) => entry.model)).toEqual(["j@fast"]);
    expect(weather.authExhausted).toBe(false);
  });
});

describe("one model, one vote, across seats", () => {
  it("never_asks_a_model_a_second_seat_already_spent", async () => {
    const { provider, asked } = recording({ shared: "1", solo: "2" });

    const verdict = await judge(request({ provider, judges: [["shared"], ["shared", "solo"]] }));

    expect(asked).toEqual(["shared", "solo"]);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["shared", "solo"]);
  });

  it("never_re_asks_a_model_an_earlier_seat_already_rotated_past", async () => {
    // "Already voted" and "already failed" are different reasons and the same
    // instruction. A protocol failure is not weather, so nothing else in the
    // run would stop the second seat asking the same dead id again — only the
    // spent set does, and it must count failures as well as votes.
    const { provider, asked } = recording({ solo: "2" });

    const verdict = await judge(request({ provider, judges: [["broken"], ["broken", "solo"]] }));

    expect(asked).toEqual(["broken", "solo"]);
    expect(verdict.votes.map((vote) => vote.model)).toEqual(["solo"]);
  });

  it("reports_a_seat_whose_every_model_an_earlier_seat_already_spent", async () => {
    const { provider, asked } = recording({ shared: "1" });

    const verdict = await judge(request({ provider, judges: [["shared"], ["shared"]] }));

    expect(asked).toEqual(["shared"]);
    expect(verdict.votes).toHaveLength(1);
    // Reported, because a panel configured as two votes that cast one is a
    // thing the maintainer who configured it needs to see.
    expect(verdict.failures.map((entry) => entry.model)).toEqual(["shared"]);
    expect(verdict.failures[0]?.reason).toContain("already been asked");
  });
});
