/**
 * The panel when the provider is the thing that failed.
 *
 * `judge.test.ts` pins how a ballot is read and `judge.contract.test.ts` pins
 * D12 inside a seat. What neither states outright is the one thing a caller
 * has to be able to tell apart: **a panel nobody could reach and a panel
 * nobody configured produce the same `decidedBy: "score"`.** The only thing
 * separating them is `failures`, so every case here asserts that side of the
 * verdict rather than only the winner — a panel that lost its failures on the
 * way out would report a run that quietly skipped its whole quality tier as
 * one that never had a quality tier at all.
 *
 * The second thing asserted throughout: a failure leaves this module carrying
 * the `kind` the provider gave it. Duties feed `verdict.failures` straight
 * into `failIfProtocolExhausted`, so a capacity failure rewritten as
 * `protocol` on the way through would turn an ordinary out-of-quota morning
 * into a red run, and a protocol failure rewritten as `capacity` would do the
 * reverse and hide a broken configuration.
 */
import { describe, expect, it, vi } from "vitest";

import { judge, type JudgeRequest } from "./judge.js";
import type { Completion, Provider } from "./provider.js";

interface Candidate {
  readonly model: string;
  readonly text: string;
}

function candidate(model: string): Candidate {
  return { model, text: `An answer from ${model}.` };
}

/** The stand-in for a duty's ballot: the candidates, numbered as shown. */
function ballot(shown: readonly Candidate[]): { role: "user"; content: string }[] {
  const numbered = shown
    .map((entry, at) => `--- CANDIDATE ${String(at + 1)} ---\n${entry.text}`)
    .join("\n\n");
  return [{ role: "user", content: numbered }];
}

/** A provider whose every model answers with the completion keyed by its id. */
function answering(answers: Record<string, string | Completion>): Provider {
  return {
    complete: vi.fn((model: string): Promise<Completion> => {
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({
          ok: false,
          model,
          reason: "not configured in this case",
          kind: "protocol",
        });
      }
      return Promise.resolve(
        typeof answer === "string"
          ? { ok: true, model, content: answer, finishReason: "stop" }
          : answer,
      );
    }),
  };
}

/** Every model whose seat could not be reached at all. */
function unreachable(models: readonly string[]): Record<string, Completion> {
  return Object.fromEntries(
    models.map((model) => [
      model,
      {
        ok: false as const,
        model,
        kind: "capacity" as const,
        usage: null,
        reason: "HTTP 503: upstream unavailable",
      },
    ]),
  );
}

function request(over: Partial<JudgeRequest<Candidate>> = {}): JudgeRequest<Candidate> {
  return {
    provider: answering({}),
    judges: [],
    candidates: [candidate("first"), candidate("second")],
    by: (entry) => entry.model,
    ballot,
    ...over,
  };
}

/** The models a provider was asked, in the order it was asked them. */
function asked(provider: Provider): string[] {
  return vi.mocked(provider.complete).mock.calls.map(([model]) => model);
}

describe("a panel the provider could not answer at all", () => {
  it("leaves the score's leader standing and names every seat that could not answer", async () => {
    const provider = answering(unreachable(["x", "y", "z"]));

    const verdict = await judge(request({ provider, judges: [["x"], ["y"], ["z"]] }));

    // The winner is unmoved — which is correct, and on its own is exactly
    // what a run with no panel configured looks like.
    expect(verdict.winner?.model).toBe("first");
    expect(verdict.decidedBy).toBe("score");
    expect(verdict.votes).toEqual([]);
    // …so the failures are the only thing that says the quality tier was
    // configured, asked, and lost. Losing them here is a false green: the run
    // would report a score-decided winner with nothing to suggest three
    // requests were spent and three votes never arrived.
    expect(verdict.failures.map((failure) => failure.model)).toEqual(["x", "y", "z"]);
  });

  it("hands the provider's own kind back out, so weather is not reported as configuration", async () => {
    const provider = answering({
      ...unreachable(["x"]),
      y: { ok: false, model: "y", kind: "protocol", reason: "HTTP 400: unknown model" },
    });

    const verdict = await judge(request({ provider, judges: [["x"], ["y"]] }));

    expect(verdict.failures.map((failure) => failure.kind)).toEqual(["capacity", "protocol"]);
  });

  it("asks each seat exactly once, never retrying the model that just failed", async () => {
    // Rotation's rule inside a panel: the failures a seat hits are quota, a
    // decommissioned id or an outage, and none of them clears inside one run.
    const provider = answering(unreachable(["x", "y"]));

    await judge(request({ provider, judges: [["x"], ["y"]] }));

    expect(asked(provider)).toEqual(["x", "y"]);
  });

  it("does not let an unreachable seat count as a vote for whatever it was shown first", async () => {
    // Seat 1 is shown the candidates rotated, so a reader that defaulted an
    // unusable answer to "the first one shown" would hand `second` a vote and
    // move the winner. Two seats, both unreachable, and the score's leader
    // must still be the leader.
    const provider = answering(unreachable(["x", "y"]));

    const verdict = await judge(request({ provider, judges: [["x"], ["y"]] }));

    expect(verdict.winner?.model).toBe("first");
    expect(verdict.votes).toEqual([]);
  });
});

describe("a panel that answered, and said nothing usable", () => {
  it("spoils a judge that echoes the ballot back instead of choosing", async () => {
    // What a weak model does with a long prompt and a one-digit instruction:
    // it repeats the prompt. Every candidate's own number is in that echo, so
    // reading the first number found would elect whichever candidate the
    // ballot happened to list first — the score's leader, dressed up as a
    // judge's decision.
    const shown = [candidate("first"), candidate("second")];
    const provider = answering({ j: ballot(shown)[0]?.content ?? "" });

    const verdict = await judge(request({ provider, judges: [["j"]], candidates: shown }));

    expect(verdict.votes).toEqual([]);
    expect(verdict.decidedBy).toBe("score");
    expect(verdict.failures[0]?.reason).toContain("named more than one candidate");
  });

  it("refuses an empty answer as a lost vote rather than reading it as an abstention nobody records", async () => {
    const provider = answering({ j: { ok: true, model: "j", content: "", finishReason: "stop" } });

    const verdict = await judge(request({ provider, judges: [["j"]] }));

    expect(verdict.votes).toEqual([]);
    expect(verdict.failures[0]?.reason).toContain("answered with no candidate number");
    expect(verdict.failures[0]?.kind).toBe("protocol");
  });

  it("reports every spoiled ballot, so a panel that voted on nothing is visible", async () => {
    const provider = answering({ x: "Both are good.", y: "I cannot choose." });

    const verdict = await judge(request({ provider, judges: [["x"], ["y"]] }));

    expect(verdict.decidedBy).toBe("score");
    expect(verdict.failures).toHaveLength(2);
    expect(verdict.failures.map((failure) => failure.model)).toEqual(["x", "y"]);
  });
});
