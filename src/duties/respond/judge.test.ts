import { describe, expect, it, vi } from "vitest";

import type { Completion, Provider } from "../../core/provider.js";

import type { Attempt } from "./draft.js";
import { judge, type ReplyJudgeRequest } from "./judge.js";

// Nothing is mocked. The panel is the core's and is tested there; what is left
// in this module is a function from three values to a request, so a stub
// endpoint is the whole of its environment.

function answering(answers: Record<string, string>): Provider {
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
      return Promise.resolve({ ok: true, model, content: answer, finishReason: "stop" });
    }),
  };
}

function attempt(model: string, confidence = 0.5): Attempt {
  return { model, text: `A reply from ${model}.`, confidence };
}

function request(over: Partial<ReplyJudgeRequest> = {}): ReplyJudgeRequest {
  return {
    provider: answering({}),
    judges: [],
    title: "Crash on save",
    body: "It throws when I press save.",
    attempts: [attempt("first"), attempt("second")],
    ...over,
  };
}

/** The messages the first judge was sent. */
async function ballotOf(over: Partial<ReplyJudgeRequest> = {}): Promise<string[]> {
  const provider = answering({ j: "1" });
  await judge(request({ ...over, provider, judges: [["j"]] }));
  const [call] = vi.mocked(provider.complete).mock.calls;
  return (call?.[1] ?? []).map((message) => message.content);
}

describe("judge", () => {
  it("hands the panel the drafts, and elects what it picked", async () => {
    const verdict = await judge(request({ provider: answering({ j: "2" }), judges: [["j"]] }));

    expect(verdict.winner?.model).toBe("second");
    expect(verdict.decidedBy).toBe("judges");
  });

  it("names the model behind a draft, so a vote reads as a model id", async () => {
    const verdict = await judge(request({ provider: answering({ j: "2" }), judges: [["j"]] }));

    expect(verdict.votes).toEqual([{ model: "j", pick: "second" }]);
  });

  it("decides by score alone when there is no panel to ask, taking the best-first leader", async () => {
    // `attempts` arrives already sorted best confidence first, same as
    // `draft.ts` leaves it — the leader is simply `candidates[0]`.
    const verdict = await judge(
      request({ attempts: [attempt("b", 0.9), attempt("a", 0.3)], judges: [] }),
    );

    expect(verdict.winner?.model).toBe("b");
    expect(verdict.decidedBy).toBe("score");
  });

  describe("what a judge is shown", () => {
    it("puts the thread and the drafts inside one fence", async () => {
      const [instructions, drafts] = await ballotOf({ title: "Crash", body: "It crashes." });
      const opened = /<untrusted-thread id="([a-f0-9]+)">/.exec(drafts ?? "");

      expect(opened?.[1]).toBeDefined();
      expect(instructions).toContain(opened?.[1] ?? "no id was found");
      expect(drafts).toContain("TITLE: Crash");
    });

    it("numbers the drafts from one, which is what an answer names", async () => {
      const [, drafts] = await ballotOf();

      expect(drafts).toContain("--- REPLY 1 ---\nA reply from first.");
      expect(drafts).toContain("--- REPLY 2 ---\nA reply from second.");
    });

    it("says how many drafts there are, and what range an answer may take", async () => {
      const [instructions] = await ballotOf({
        attempts: [attempt("a"), attempt("b"), attempt("c")],
      });

      expect(instructions).toContain("3 draft first replies");
      expect(instructions).toContain("an integer from 1 to 3");
    });

    it("asks for a number and nothing else", async () => {
      const [instructions] = await ballotOf();

      expect(instructions).toContain("no reasoning, no punctuation, no explanation");
    });

    it("orders the criteria so fabrication is judged before style", async () => {
      const [instructions = ""] = await ballotOf();

      const order = [
        "fabricate a fix",
        "grounded in what this specific thread",
        "language the thread was written in",
        "reads as a maintainer would write it",
      ].map((criterion) => instructions.indexOf(criterion));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("keeps the instructions out of the message carrying the drafts", async () => {
      const [, drafts] = await ballotOf();

      expect(drafts).not.toContain("Judge in this order");
    });

    it("draws a new boundary for every call", async () => {
      const first = /id="([a-f0-9]+)"/.exec((await ballotOf())[1] ?? "")?.[1];
      const second = /id="([a-f0-9]+)"/.exec((await ballotOf())[1] ?? "")?.[1];

      expect(first).not.toBe(second);
    });
  });
});
