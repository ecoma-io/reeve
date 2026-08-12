import { describe, expect, it, vi } from "vitest";

import type { Correction } from "../../core/memory.js";
import type { Completion, Provider } from "../../core/provider.js";
import type { Label } from "../../core/warrant.js";

import { parseVerdict, prompt, triage, type TriageRequest } from "./verdict.js";

// Nothing is mocked but the endpoint. Rotation is the core's and is tested
// there; what is tested here is the parser — which is a guardrail rather than a
// convenience — and what a model is shown, which is the other half of the same
// question. Every case in `parseVerdict` is about an answer that should not
// become a verdict, because the shapes that fail to parse are the shapes an
// injection produces.

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

function label(over: Partial<Label> = {}): Label {
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
    ...over,
  };
}

function correction(over: Partial<Correction> = {}): Correction {
  return {
    repo: "ecoma-io/reeve",
    thread: 42,
    duty: "triage",
    at: "2026-01-01T00:00:00Z",
    title: "The button does nothing on mobile",
    excerpt: "Tapping it opens nothing.",
    language: "en",
    proposed: ["bug"],
    decided: ["bug", "mobile"],
    by: "maintainer",
    note: null,
    outcome: null,
    duplicateOf: null,
    pivot: null,
    ...over,
  };
}

function request(over: Partial<TriageRequest> = {}): TriageRequest {
  return {
    provider: answering({}),
    models: ["m"],
    title: "Crash on save",
    body: "It throws when I press save.",
    taxonomy: [label()],
    language: "English",
    recalled: [],
    ...over,
  };
}

/** The two messages the model was sent, as text. */
function messagesOf(over: Partial<TriageRequest> = {}): string[] {
  return prompt(request(over)).map((message) => message.content);
}

describe("triage", () => {
  it("returns what the first model that answered proposed", async () => {
    const triaged = await triage(
      request({
        provider: answering({
          m: '{"labels": ["bug"], "confidence": 0.9, "rationale": "It crashes."}',
        }),
      }),
    );

    expect(triaged.verdict.labels).toEqual(["bug"]);
    expect(triaged.verdict.confidence).toBe(0.9);
    expect(triaged.unreadable).toBeNull();
  });

  it("proposes nothing when every model failed, and says which", async () => {
    const triaged = await triage(request({ models: ["a", "b"], provider: answering({}) }));

    expect(triaged.verdict.labels).toEqual([]);
    expect(triaged.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
    // Null rather than the answer: nobody answered, so there is nothing to
    // show a maintainer that would tell them anything the failures do not.
    expect(triaged.unreadable).toBeNull();
  });

  it("hands back an unreadable answer whole, so a warning can quote it", async () => {
    const triaged = await triage(
      request({ provider: answering({ m: "I think this is probably a bug." }) }),
    );

    expect(triaged.verdict.labels).toEqual([]);
    expect(triaged.unreadable).toBe("I think this is probably a bug.");
  });

  it("rotates past a model that failed rather than retrying it", async () => {
    const provider = answering({ second: '{"labels": [], "confidence": 0.2}' });
    await triage(request({ provider, models: ["first", "second"] }));

    expect(vi.mocked(provider.complete).mock.calls.map((call) => call[0])).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("parseVerdict", () => {
  it("reads the shape it asked for", () => {
    const verdict = parseVerdict(
      '{"labels": ["bug", "mobile"], "confidence": 0.8, "duplicate_of": 12, "rationale": "Same crash."}',
    );

    expect(verdict).toEqual({
      labels: ["bug", "mobile"],
      confidence: 0.8,
      duplicateOf: 12,
      rationale: "Same crash.",
    });
  });

  it("unwraps an answer that is one fenced block and nothing else", () => {
    const verdict = parseVerdict('```json\n{"labels": [], "confidence": 0.1}\n```');

    expect(verdict?.confidence).toBe(0.1);
  });

  it("refuses an answer carrying prose beside the JSON", () => {
    // Which is what an answer carrying prose beside the JSON is: a model that
    // did something other than what it was asked. Scanning for the first `{`
    // would make this readable, and would make an injected object readable too.
    expect(parseVerdict('Sure!\n```json\n{"labels": [], "confidence": 0.1}\n```')).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(parseVerdict("null")).toBeNull();
    expect(parseVerdict('["bug"]')).toBeNull();
    expect(parseVerdict('"bug"')).toBeNull();
    expect(parseVerdict("not json at all")).toBeNull();
  });

  it("refuses labels that are not a list of strings", () => {
    expect(parseVerdict('{"confidence": 0.5}')).toBeNull();
    expect(parseVerdict('{"labels": "bug", "confidence": 0.5}')).toBeNull();
    expect(parseVerdict('{"labels": ["bug", 7], "confidence": 0.5}')).toBeNull();
  });

  it("refuses a confidence that is not a number between 0 and 1", () => {
    expect(parseVerdict('{"labels": [], "confidence": "high"}')).toBeNull();
    expect(parseVerdict('{"labels": [], "confidence": 75}')).toBeNull();
    expect(parseVerdict('{"labels": [], "confidence": -0.1}')).toBeNull();
    expect(parseVerdict('{"labels": []}')).toBeNull();
  });

  it("refuses a duplicate that is not an issue number", () => {
    // `0` is not an issue and neither is `12.5`. A model answering with one has
    // answered with something other than a reference to a thread.
    expect(parseVerdict('{"labels": [], "confidence": 0.5, "duplicate_of": 0}')).toBeNull();
    expect(parseVerdict('{"labels": [], "confidence": 0.5, "duplicate_of": 12.5}')).toBeNull();
    expect(parseVerdict('{"labels": [], "confidence": 0.5, "duplicate_of": "#12"}')).toBeNull();
  });

  it("discards the whole answer when one field is wrong, not the field", () => {
    // The half that parsed is not more trustworthy for having parsed. An answer
    // that came apart somewhere came apart everywhere.
    expect(
      parseVerdict('{"labels": ["bug"], "confidence": 0.9, "rationale": ["it", "crashes"]}'),
    ).toBeNull();
  });

  it("treats an absent duplicate and rationale as absent rather than as wrong", () => {
    const verdict = parseVerdict('{"labels": ["bug"], "confidence": 1}');

    expect(verdict).toEqual({
      labels: ["bug"],
      confidence: 1,
      duplicateOf: null,
      rationale: "",
    });
  });

  it("trims label names and drops the empty ones", () => {
    // `" bug"` means `bug` and GitHub does not agree. An empty entry is a model
    // padding a list rather than the answer coming apart, so it is dropped
    // instead of refused.
    const verdict = parseVerdict('{"labels": [" bug ", "", "  "], "confidence": 0.5}');

    expect(verdict?.labels).toEqual(["bug"]);
  });
});

describe("prompt", () => {
  it("puts the taxonomy in the system message, in the words it was written in", () => {
    const [system] = messagesOf({
      taxonomy: [
        label({
          name: "lỗi",
          description: "Thứ gì đó từng chạy và bây giờ thì không.",
          not: "Một tính năng chưa từng tồn tại.",
          examples: ["Ứng dụng thoát khi tôi bấm lưu"],
        }),
      ],
    });

    expect(system).toContain("- lỗi: Thứ gì đó từng chạy và bây giờ thì không.");
    expect(system).toContain("NOT: Một tính năng chưa từng tồn tại.");
    expect(system).toContain("e.g. Ứng dụng thoát khi tôi bấm lưu");
  });

  it("names the only labels that exist, so a verdict has somewhere to choose from", () => {
    const [system] = messagesOf({ taxonomy: [label({ name: "bug" }), label({ name: "docs" })] });

    expect(system).toContain("chosen from exactly these names: bug, docs");
  });

  it("tells the model what language it is reading rather than leaving it to infer", () => {
    expect(messagesOf({ language: "Tiếng Việt" })[0]).toContain("written in Tiếng Việt");
    expect(messagesOf({ language: null })[0]).toContain("could not be identified");
  });

  it("puts the thread behind a boundary the system message names", () => {
    const [system, user] = messagesOf({ title: "Crash", body: "It crashes." });
    const opened = /<untrusted-thread id="([a-f0-9]+)">/.exec(user ?? "");

    expect(opened?.[1]).toBeDefined();
    expect(system).toContain(opened?.[1] ?? "no id was found");
    expect(user).toContain("TITLE: Crash");
  });

  it("draws a new boundary for every call", () => {
    // A fixed delimiter is one anybody can read out of this repository and
    // close. The point of the nonce is that it did not exist before this call.
    const first = /id="([a-f0-9]+)"/.exec(messagesOf()[1] ?? "")?.[1];
    const second = /id="([a-f0-9]+)"/.exec(messagesOf()[1] ?? "")?.[1];

    expect(first).not.toBe(second);
  });

  it("keeps recalled corrections inside the fence with the thread", () => {
    // They are maintainer decisions, but they quote threads strangers wrote.
    // One fence rather than two: a rule stated twice reads as two rules.
    const [system, user] = messagesOf({ recalled: [correction()] });

    expect(user).toContain("--- DECISIONS THIS PROJECT ALREADY MADE ---");
    expect(user).toContain("#42: The button does nothing on mobile");
    expect(system).not.toContain("The button does nothing on mobile");
  });

  it("shows what a maintainer decided, and what was proposed only when they differ", () => {
    const [, user] = messagesOf({
      recalled: [
        correction({ thread: 1, proposed: ["bug"], decided: ["docs"], note: "It is documented." }),
        correction({ thread: 2, proposed: ["bug"], decided: ["bug"] }),
      ],
    });

    expect(user).toContain("#1: The button does nothing on mobile\n  DECIDED: docs");
    expect(user).toContain("(proposed at the time: bug)");
    expect(user).toContain("WHY: It is documented.");
    // The second agreed with itself, so there is nothing to teach and nothing
    // is shown.
    expect(user).toContain("#2: The button does nothing on mobile\n  DECIDED: bug");
    expect((user ?? "").match(/proposed at the time/g)).toHaveLength(1);
  });

  it("says nothing about examples when there are none", () => {
    const [, user] = messagesOf({ recalled: [] });

    expect(user).not.toContain("DECISIONS THIS PROJECT ALREADY MADE");
  });

  it("says an empty list is a real answer", () => {
    // Without it, a model asked to choose from a list chooses from the list.
    expect(messagesOf()[0]).toContain("An empty list is a real answer");
  });
});
