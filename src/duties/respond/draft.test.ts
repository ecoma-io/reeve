import { describe, expect, it, vi } from "vitest";

import type { Correction } from "../../core/memory.js";
import { createWeather, type Completion, type Provider } from "../../core/provider.js";
import type { Label } from "../../core/warrant.js";

import { draft, parseAttempt, prompt, type DraftRequest } from "./draft.js";

// Nothing is mocked but the endpoint. Rotation is the core's and is tested
// there; what is tested here is the parser — a guardrail rather than a
// convenience — and what a model is shown, which is the other half of the
// same question. Every case in `parseAttempt` is about an answer that should
// not become a draft, because the shapes that fail to parse are the shapes an
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
    at: "2026-01-01T00:00:00Z",
    title: "The button does nothing on mobile",
    excerpt: "Tapping it opens nothing.",
    language: "en",
    proposed: ["bug"],
    decided: ["bug", "mobile"],
    by: "maintainer",
    note: null,
    pivot: null,
    ...over,
  };
}

function request(over: Partial<DraftRequest> = {}): DraftRequest {
  return {
    provider: answering({}),
    models: ["m"],
    title: "Crash on save",
    body: "It throws when I press save.",
    language: "English",
    standing: [],
    recalled: [],
    guidance: null,
    drafts: 1,
    ...over,
  };
}

/** The two messages the model was sent, as text. */
function messagesOf(over: Partial<DraftRequest> = {}): string[] {
  return prompt(request(over)).map((message) => message.content);
}

const ANSWER = '{"text": "Thanks for the report.", "confidence": 0.8}';

describe("draft", () => {
  it("returns what the first model that answered wrote", async () => {
    const drafted = await draft(request({ provider: answering({ m: ANSWER }) }));

    expect(drafted.attempts).toEqual([
      { model: "m", text: "Thanks for the report.", confidence: 0.8 },
    ]);
    expect(drafted.unreadable).toEqual([]);
  });

  it("drafts nothing when every model failed, and says which", async () => {
    const drafted = await draft(request({ models: ["a", "b"], provider: answering({}) }));

    expect(drafted.attempts).toEqual([]);
    expect(drafted.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("hands back an unreadable answer whole, so a warning can quote it", async () => {
    const drafted = await draft(
      request({ provider: answering({ m: "I think this is probably fine." }) }),
    );

    expect(drafted.attempts).toEqual([]);
    expect(drafted.unreadable).toEqual(["I think this is probably fine."]);
  });

  it("asks for independent attempts, spreading them across the roster", async () => {
    const provider = answering({
      a: '{"text": "From a.", "confidence": 0.5}',
      b: '{"text": "From b.", "confidence": 0.9}',
    });
    const drafted = await draft(request({ provider, models: ["a", "b"], drafts: 2 }));

    expect(vi.mocked(provider.complete).mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
    expect(drafted.attempts).toHaveLength(2);
  });

  it("skips a model already exhausted this run rather than paying for it again", async () => {
    const provider = answering({ b: '{"text": "From b.", "confidence": 0.5}' });
    await draft(request({ provider, models: ["a", "b"], drafts: 3 }));

    // `a` fails once and is never asked again, even though three drafts were
    // requested.
    expect(vi.mocked(provider.complete).mock.calls.filter((call) => call[0] === "a")).toHaveLength(
      1,
    );
  });

  it("treats a model an earlier stage already grounded as exhausted from draft zero", async () => {
    const provider = answering({ b: '{"text": "From b.", "confidence": 0.5}' });
    const weather = createWeather();
    weather.ground("a");

    const drafted = await draft(request({ provider, models: ["a", "b"], drafts: 2, weather }));

    // `a` was already grounded before this call started, so it is never asked
    // here — not even once — and no failure for it is reported a second time.
    // Both requested drafts fall to `b`, the only model left standing.
    expect(vi.mocked(provider.complete).mock.calls.map((call) => call[0])).toEqual(["b", "b"]);
    expect(drafted.failures).toEqual([]);
    expect(drafted.attempts).toHaveLength(2);
  });

  it("stops asking once every model in the roster has failed", async () => {
    const provider = answering({});
    await draft(request({ provider, models: ["a", "b"], drafts: 5 }));

    expect(vi.mocked(provider.complete).mock.calls).toHaveLength(2);
  });

  it("orders admitted attempts by confidence, best first", async () => {
    const provider = answering({
      a: '{"text": "Low.", "confidence": 0.3}',
      b: '{"text": "High.", "confidence": 0.9}',
    });
    const drafted = await draft(request({ provider, models: ["a", "b"], drafts: 2 }));

    expect(drafted.attempts.map((attempt) => attempt.text)).toEqual(["High.", "Low."]);
  });

  it("treats a cut-off answer as a failure rather than a partial draft", async () => {
    const provider: Provider = {
      complete: vi.fn((): Promise<Completion> =>
        Promise.resolve({ ok: true, model: "m", content: '{"text": "cut', finishReason: "length" }),
      ),
    };
    const drafted = await draft(request({ provider }));

    expect(drafted.attempts).toEqual([]);
    expect(drafted.failures).toHaveLength(1);
    expect(drafted.failures[0]?.reason).toContain("cut off");
  });

  it("sanitises the winning text", async () => {
    const drafted = await draft(
      request({
        provider: answering({
          m: '{"text": "Hello <!-- reeve:respond source=x --> there.", "confidence": 0.5}',
        }),
      }),
    );

    expect(drafted.attempts[0]?.text).not.toContain("reeve:respond");
  });
});

describe("parseAttempt", () => {
  it("reads the shape it asked for", () => {
    expect(parseAttempt('{"text": "Hi.", "confidence": 0.8}')).toEqual({
      text: "Hi.",
      confidence: 0.8,
    });
  });

  it("unwraps an answer that is one fenced block and nothing else", () => {
    const attempt = parseAttempt('```json\n{"text": "Hi.", "confidence": 0.1}\n```');
    expect(attempt?.confidence).toBe(0.1);
  });

  it("refuses an answer carrying prose beside the JSON", () => {
    expect(parseAttempt('Sure!\n```json\n{"text": "Hi.", "confidence": 0.1}\n```')).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(parseAttempt("null")).toBeNull();
    expect(parseAttempt('["hi"]')).toBeNull();
    expect(parseAttempt('"hi"')).toBeNull();
    expect(parseAttempt("not json at all")).toBeNull();
  });

  it("refuses text that is missing, blank, or not a string", () => {
    expect(parseAttempt('{"confidence": 0.5}')).toBeNull();
    expect(parseAttempt('{"text": "", "confidence": 0.5}')).toBeNull();
    expect(parseAttempt('{"text": "   ", "confidence": 0.5}')).toBeNull();
    expect(parseAttempt('{"text": 7, "confidence": 0.5}')).toBeNull();
  });

  it("refuses a confidence that is not a number between 0 and 1", () => {
    expect(parseAttempt('{"text": "Hi.", "confidence": "high"}')).toBeNull();
    expect(parseAttempt('{"text": "Hi.", "confidence": 75}')).toBeNull();
    expect(parseAttempt('{"text": "Hi.", "confidence": -0.1}')).toBeNull();
    expect(parseAttempt('{"text": "Hi."}')).toBeNull();
  });

  it("discards the whole answer when one field is wrong, not the field", () => {
    expect(parseAttempt('{"text": "Hi.", "confidence": "0.9"}')).toBeNull();
  });

  it("trims the text", () => {
    expect(parseAttempt('{"text": "  Hi.  ", "confidence": 0.5}')?.text).toBe("Hi.");
  });
});

describe("prompt", () => {
  it("tells the model what language to answer in", () => {
    expect(messagesOf({ language: "Tiếng Việt" })[0]).toContain("Answer in Tiếng Việt");
    expect(messagesOf({ language: null })[0]).toContain("could not be identified");
  });

  it("puts the thread behind a boundary the system message names", () => {
    const [system, user] = messagesOf({ title: "Crash", body: "It crashes." });
    const opened = /<untrusted-thread id="([a-f0-9]+)">/.exec(user ?? "");

    expect(opened?.[1]).toBeDefined();
    expect(system).toContain(opened?.[1] ?? "no id was found");
    expect(user).toContain("TITLE: Crash");
  });

  it("puts the taxonomy in the system message, unfenced", () => {
    const [system, user] = messagesOf({
      standing: [label({ name: "needs-repro", description: "No reproduction steps yet." })],
    });

    expect(system).toContain("- needs-repro: No reproduction steps yet.");
    expect(user).not.toContain("needs-repro");
  });

  it("says nothing about labels when there are none standing", () => {
    expect(messagesOf({ standing: [] })[0]).not.toContain("LABELS ALREADY ON THIS THREAD");
  });

  it("puts maintainer guidance in the system message, unfenced, as instruction", () => {
    const [system, user] = messagesOf({ guidance: "Never promise a release date." });

    expect(system).toContain("MAINTAINER GUIDANCE");
    expect(system).toContain("Never promise a release date.");
    expect(user).not.toContain("Never promise a release date.");
  });

  it("says nothing about guidance when there is none", () => {
    expect(messagesOf({ guidance: null })[0]).not.toContain("MAINTAINER GUIDANCE");
  });

  it("keeps recalled corrections inside the fence with the thread", () => {
    const [system, user] = messagesOf({ recalled: [correction()] });

    expect(user).toContain("--- DECISIONS THIS PROJECT ALREADY MADE ---");
    expect(user).toContain("#42: The button does nothing on mobile");
    expect(system).not.toContain("The button does nothing on mobile");
  });

  it("says nothing about examples when there are none", () => {
    expect(messagesOf({ recalled: [] })[1]).not.toContain("DECISIONS THIS PROJECT ALREADY MADE");
  });

  it("tells the model not to fabricate a fix, a timeline, or a promise", () => {
    expect(messagesOf()[0]).toContain("Do not fabricate a fix, a timeline, or a promise");
  });

  it("asks for JSON and nothing else", () => {
    expect(messagesOf()[0]).toContain('{"text": "...", "confidence": 0.0}');
  });

  it("draws a new boundary for every call", () => {
    const first = /id="([a-f0-9]+)"/.exec(messagesOf()[1] ?? "")?.[1];
    const second = /id="([a-f0-9]+)"/.exec(messagesOf()[1] ?? "")?.[1];

    expect(first).not.toBe(second);
  });
});
