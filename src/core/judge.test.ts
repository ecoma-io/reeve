import { describe, expect, it, vi } from "vitest";

import { judge, type JudgeRequest } from "./judge.js";
import type { Completion, Provider } from "./provider.js";

// Nothing is mocked, because there is nothing project-internal to mock: every
// collaborator this module has is a type, and the two things it calls — the
// provider and the duty's ballot — both arrive injected. A stub endpoint and a
// stub ballot are the whole of its environment.

/** A provider whose every model answers with the text keyed by its id. */
function answering(answers: Record<string, string | Completion>): Provider {
  return {
    complete: vi.fn((model: string): Promise<Completion> => {
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({ ok: false, model, reason: "not configured in this case" });
      }
      return Promise.resolve(
        typeof answer === "string"
          ? { ok: true, model, content: answer, finishReason: "stop" }
          : answer,
      );
    }),
  };
}

/**
 * A candidate as this module sees one: opaque, except that the duty can name
 * the model behind it. Deliberately not an `Attempt` — the panel is generic,
 * and a test written against a duty's shape would let a translation-only
 * assumption in without anyone noticing.
 */
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

describe("judge", () => {
  describe("when there is nothing for a panel to decide", () => {
    it("returns no winner when nothing was admitted", async () => {
      const verdict = await judge(request({ candidates: [], judges: [["j"]] }));

      expect(verdict.winner).toBeNull();
      expect(verdict.decidedBy).toBe("score");
    });

    it("does not ask a judge which of one candidate is best", async () => {
      const provider = answering({ j: "1" });

      const verdict = await judge(
        request({ provider, candidates: [candidate("only")], judges: [["j"]] }),
      );

      expect(verdict.winner?.model).toBe("only");
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it("lets the score decide when no judge is configured", async () => {
      const verdict = await judge(request({ judges: [] }));

      expect(verdict.winner?.model).toBe("first");
      expect(verdict.decidedBy).toBe("score");
      expect(verdict.votes).toEqual([]);
    });
  });

  describe("a single judge", () => {
    it("elects the candidate it picked, over the one the score ranked first", async () => {
      const provider = answering({ j: "2" });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.winner?.model).toBe("second");
      expect(verdict.decidedBy).toBe("judges");
      expect(verdict.votes).toEqual([{ model: "j", pick: "second" }]);
    });

    it("says the score decided when the judge failed", async () => {
      const provider = answering({ j: { ok: false, model: "j", reason: "quota exhausted" } });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.winner?.model).toBe("first");
      expect(verdict.decidedBy).toBe("score");
      expect(verdict.failures).toEqual([{ ok: false, model: "j", reason: "quota exhausted" }]);
    });
  });

  describe("reading a ballot", () => {
    it.each([
      ["the number alone", "2"],
      ["the number with the trailing punctuation a model adds", "2."],
      ["the number in a sentence naming no other candidate", "Candidate 2 is the best one."],
      ["the number emphasised", "**2**"],
      ["the number with surrounding whitespace", "\n  2\n"],
    ])("counts %s", async (_case, content) => {
      const provider = answering({ j: content });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.votes).toEqual([{ model: "j", pick: "second" }]);
    });

    it("spoils a ballot naming two candidates rather than guessing which it meant", async () => {
      // "2 is better than 1" and "not 2, so 1" have the same numbers in the
      // same order and opposite answers. Reading either position picks wrong on
      // one of them, and a lost vote costs a vote where a wrong one costs the
      // answer.
      const provider = answering({ j: "2 is better than 1" });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.votes).toEqual([]);
      expect(verdict.failures[0]?.reason).toContain("named more than one candidate");
    });

    it("counts a ballot that repeats the same candidate", async () => {
      const provider = answering({ j: "2, candidate 2" });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.votes).toEqual([{ model: "j", pick: "second" }]);
    });

    it("spoils a ballot naming no candidate, and says what it answered instead", async () => {
      const provider = answering({ j: "Both are good answers." });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.failures[0]?.reason).toBe(
        "answered with no candidate number — Both are good answers.",
      );
    });

    it("ignores a number that is not one of the candidates", async () => {
      // A judge quoting a line number or a version from the body has not voted.
      const provider = answering({ j: "See section 7" });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.votes).toEqual([]);
      expect(verdict.failures[0]?.reason).toContain("answered with no candidate number");
    });

    it("does not read a longer number as the candidate it starts with", async () => {
      const provider = answering({ j: "12" });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.votes).toEqual([]);
    });

    it("counts an answer the provider reported as cut off", async () => {
      // Unlike a draft: the whole answer is one digit, so `length` means the
      // model kept going after it rather than that it stopped short.
      const provider = answering({
        j: { ok: true, model: "j", content: "2", finishReason: "length" },
      });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.votes).toEqual([{ model: "j", pick: "second" }]);
    });

    it("shortens a long unusable answer before it reaches the log", async () => {
      const provider = answering({ j: "no".repeat(200) });

      const verdict = await judge(request({ provider, judges: [["j"]] }));

      expect(verdict.failures[0]?.reason).toMatch(/…$/);
      expect(verdict.failures[0]?.reason.length).toBeLessThan(200);
    });
  });

  describe("a panel", () => {
    it("elects the candidate the plurality picked", async () => {
      // Two candidates across three seats, so the rotation wraps: seats 0 and 2
      // are shown [first, second] and seat 1 [second, first]. `x` answering "2"
      // and `y` answering "1" are therefore the same vote read through two
      // orders, and `z` is the dissent the plurality overrules.
      const provider = answering({ x: "2", y: "1", z: "1" });

      const verdict = await judge(request({ provider, judges: [["x"], ["y"], ["z"]] }));

      expect(verdict.votes).toEqual([
        { model: "x", pick: "second" },
        { model: "y", pick: "second" },
        { model: "z", pick: "first" },
      ]);
      expect(verdict.winner?.model).toBe("second");
    });

    it("leaves the better-scoring candidate in front when the panel splits evenly", async () => {
      const provider = answering({ x: "2", y: "2" });

      const verdict = await judge(request({ provider, judges: [["x"], ["y"]] }));

      expect(verdict.votes.map((vote) => vote.pick)).toEqual(["second", "first"]);
      expect(verdict.winner?.model).toBe("first");
      // The panel voted, so this is a tie the score settled rather than a run
      // no judge reached.
      expect(verdict.decidedBy).toBe("judges");
    });

    it("decides on the judges that answered, without retrying the ones that did not", async () => {
      const provider = answering({ x: { ok: false, model: "x", reason: "quota" }, y: "1" });

      const verdict = await judge(request({ provider, judges: [["x"], ["y"]] }));

      const asked = vi.mocked(provider.complete).mock.calls.map(([model]) => model);
      expect(asked).toEqual(["x", "y"]);
      expect(verdict.winner?.model).toBe("second");
      expect(verdict.failures).toHaveLength(1);
    });

    it("asks every judge, where a rotation would have stopped at the first answer", async () => {
      // The difference between a panel and a fallback chain, and the whole
      // reason a quorum means anything.
      const provider = answering({ x: "1", y: "1", z: "1" });

      await judge(request({ provider, judges: [["x"], ["y"], ["z"]] }));

      expect(provider.complete).toHaveBeenCalledTimes(3);
    });
  });

  describe("what each judge is shown", () => {
    it("rotates the candidates by seat, so the leader does not lead every ballot", async () => {
      const provider = answering({ x: "1", y: "1", z: "1" });

      await judge(
        request({
          provider,
          judges: [["x"], ["y"], ["z"]],
          candidates: [candidate("first"), candidate("second"), candidate("third")],
        }),
      );

      const led = vi
        .mocked(provider.complete)
        .mock.calls.map(([, messages]) => leading(messages[0]?.content ?? ""));
      expect(led).toEqual(["first", "second", "third"]);
    });

    it("keeps every candidate on every ballot, whatever the seat", async () => {
      const provider = answering({ x: "1", y: "1" });

      await judge(
        request({ provider, judges: [["x"], ["y"]], candidates: [candidate("a"), candidate("b")] }),
      );

      expect(provider.complete).toHaveBeenCalledTimes(2);
      for (const [, messages] of vi.mocked(provider.complete).mock.calls) {
        expect(messages[0]?.content).toContain("An answer from a.");
        expect(messages[0]?.content).toContain("An answer from b.");
      }
    });

    it("asks the duty for the ballot rather than writing one of its own", async () => {
      // The whole boundary in one assertion: this module knows the order the
      // candidates are shown in and nothing about what they are.
      const provider = answering({ j: "1" });
      const duty = vi.fn(ballot);

      await judge(request({ provider, judges: [["j"]], ballot: duty }));

      expect(duty).toHaveBeenCalledTimes(1);
      expect(vi.mocked(provider.complete).mock.calls[0]?.[1]).toEqual(duty.mock.results[0]?.value);
    });
  });

  describe("a seat with more than one model in it", () => {
    it("does not ask the fallback when the seat's first model voted", async () => {
      const provider = answering({ a: "1", a2: "1" });

      const verdict = await judge(request({ provider, judges: [["a", "a2"]] }));

      expect(asked(provider)).toEqual(["a"]);
      expect(verdict.votes).toEqual([{ model: "a", pick: "first" }]);
    });

    it("falls back when the seat's first model could not be reached", async () => {
      const provider = answering({ a: { ok: false, model: "a", reason: "quota" }, a2: "1" });

      const verdict = await judge(request({ provider, judges: [["a", "a2"]] }));

      expect(asked(provider)).toEqual(["a", "a2"]);
      expect(verdict.votes).toEqual([{ model: "a2", pick: "first" }]);
    });

    it("falls back when the seat's first model answered without choosing", async () => {
      // A request spent on "both are good" leaves the seat exactly as empty as
      // a request that never connected, and the fallback is what empty is for.
      const provider = answering({ a: "Both are good answers.", a2: "2" });

      const verdict = await judge(request({ provider, judges: [["a", "a2"]] }));

      expect(asked(provider)).toEqual(["a", "a2"]);
      expect(verdict.votes).toEqual([{ model: "a2", pick: "second" }]);
      expect(verdict.failures[0]?.reason).toContain("answered with no candidate number");
    });

    it("casts one vote however far down the chain it had to go", async () => {
      const provider = answering({
        a: { ok: false, model: "a", reason: "quota" },
        a2: { ok: false, model: "a2", reason: "quota" },
        a3: "1",
      });

      const verdict = await judge(request({ provider, judges: [["a", "a2", "a3"]] }));

      expect(verdict.votes).toHaveLength(1);
      expect(verdict.failures).toHaveLength(2);
    });

    it("reports every model it rotated past, so the log names the whole chain", async () => {
      const provider = answering({ a: { ok: false, model: "a", reason: "quota" }, a2: "1" });

      const verdict = await judge(request({ provider, judges: [["a", "a2"]] }));

      expect(verdict.failures).toEqual([{ ok: false, model: "a", reason: "quota" }]);
    });

    it("leaves the score deciding when the whole chain is exhausted", async () => {
      const provider = answering({
        a: { ok: false, model: "a", reason: "quota" },
        a2: { ok: false, model: "a2", reason: "quota" },
      });

      const verdict = await judge(request({ provider, judges: [["a", "a2"]] }));

      expect(verdict.winner?.model).toBe("first");
      expect(verdict.decidedBy).toBe("score");
    });
  });

  describe("one model, one vote", () => {
    it("skips a model a later seat names when an earlier seat already voted with it", async () => {
      // `a, a|b` on the morning nothing is wrong. Counting `a` twice would be a
      // plurality of one model.
      const provider = answering({ a: "1", b: "1" });

      const verdict = await judge(request({ provider, judges: [["a"], ["a", "b"]] }));

      expect(asked(provider)).toEqual(["a", "b"]);
      // Seat 1 is shown [second, first], so its "1" is a vote for `second`.
      expect(verdict.votes).toEqual([
        { model: "a", pick: "first" },
        { model: "b", pick: "second" },
      ]);
    });

    it("skips a model a later seat names when an earlier seat already rotated past it", async () => {
      const provider = answering({
        a: { ok: false, model: "a", reason: "quota" },
        b: "1",
        c: "1",
      });

      await judge(
        request({
          provider,
          judges: [
            ["a", "b"],
            ["a", "c"],
          ],
        }),
      );

      // `a` is asked once, by the seat that reached it first. Quota does not
      // clear inside a run, so the second seat's copy of it is not a chance.
      expect(asked(provider)).toEqual(["a", "b", "c"]);
    });

    it("casts nothing for a seat every model of which is spoken for, and says so", async () => {
      const provider = answering({ a: "1" });

      const verdict = await judge(request({ provider, judges: [["a"], ["a"]] }));

      expect(asked(provider)).toEqual(["a"]);
      expect(verdict.votes).toHaveLength(1);
      expect(verdict.failures).toEqual([
        { ok: false, model: "a", reason: expect.stringContaining("seat cast nothing") as string },
      ]);
    });

    it("says nothing about a seat that names no model at all", async () => {
      // Unreachable through `parseSeats`, which drops an empty seat — and a
      // duty builds this request itself, so the type is the only thing between
      // an empty seat and a failure naming a model that is the empty string.
      const provider = answering({ a: "1" });

      const verdict = await judge(request({ provider, judges: [["a"], []] }));

      expect(verdict.failures).toEqual([]);
      expect(verdict.votes).toHaveLength(1);
    });
  });
});

/** The models a provider was asked, in the order it was asked them. */
function asked(provider: Provider): string[] {
  return vi.mocked(provider.complete).mock.calls.map(([model]) => model);
}

/** The candidate presented first on a ballot. */
function leading(text: string): string {
  return /An answer from (\w+)\./.exec(text.split("--- CANDIDATE 1 ---")[1] ?? "")?.[1] ?? "";
}
