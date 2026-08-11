import { describe, expect, it } from "vitest";

import type { Completion, Provider } from "../../core/provider.js";
import { createWeather } from "../../core/provider.js";
import type { Candidate } from "./rank.js";
import { judge, NOTHING, parseVerdict, type JudgeRequest } from "./verdict.js";

const CANDIDATES: readonly Candidate[] = [
  { number: 7, title: "Login button does nothing on Safari", body: "It just sits there." },
  { number: 9, title: "Export crashes on large files", body: "Throws on a 2GB export." },
];

function providerAnswering(content: string): Provider {
  return {
    complete: (model: string): Promise<Completion> =>
      Promise.resolve({ ok: true, model, content, finishReason: null }),
  };
}

function baseRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    provider: providerAnswering('{"duplicate_of": 7, "confidence": 0.9, "rationale": "same bug"}'),
    models: ["gpt-4o-mini"],
    title: "Sign-in click has no effect",
    body: "Clicking sign-in does nothing on Safari.",
    language: "en",
    candidates: CANDIDATES,
    ...overrides,
  };
}

describe("judge", () => {
  it("parses a duplicate verdict naming one of the offered candidates", async () => {
    const judged = await judge(baseRequest());

    expect(judged.verdict).toEqual({ duplicateOf: 7, confidence: 0.9, rationale: "same bug" });
    expect(judged.failures).toEqual([]);
    expect(judged.unreadable).toBeNull();
    expect(judged.model).toBe("gpt-4o-mini");
  });

  it("answers NOTHING without asking a model when there are no candidates", async () => {
    let asked = false;
    const provider: Provider = {
      complete: (model: string) => {
        asked = true;
        return Promise.resolve({ ok: true, model, content: "{}", finishReason: null });
      },
    };

    const judged = await judge(baseRequest({ provider, candidates: [] }));

    expect(judged.verdict).toEqual(NOTHING);
    expect(asked).toBe(false);
    expect(judged.model).toBeNull();
  });

  it("answers NOTHING and reports failures when every model rotates past", async () => {
    const provider: Provider = {
      complete: (model: string): Promise<Completion> =>
        Promise.resolve({ ok: false, model, kind: "protocol", reason: "no route" }),
    };

    const judged = await judge(baseRequest({ provider }));

    expect(judged.verdict).toEqual(NOTHING);
    expect(judged.failures).toHaveLength(1);
    expect(judged.unreadable).toBeNull();
    expect(judged.model).toBeNull();
  });

  it("reports an unreadable answer rather than guessing at it", async () => {
    const judged = await judge(baseRequest({ provider: providerAnswering("not json at all") }));

    expect(judged.verdict).toEqual(NOTHING);
    expect(judged.unreadable).toBe("not json at all");
    // The model that answered is still known even when its answer did not
    // parse — an unreadable answer is not the same failure as no model
    // answering at all, and the attribution footer needs to tell them apart.
    expect(judged.model).toBe("gpt-4o-mini");
  });

  it("discards a length-truncated answer as the model's failure, even one that looks parseable", async () => {
    // A cutoff mid-object can still leave a prefix `JSON.parse` or even
    // `parseVerdict` would accept on a lucky truncation point — this is the
    // one place that still knows the answer was cut off before it finished,
    // so it has to refuse before that prefix ever reaches the parser, not
    // trust that a malformed shape will always give the truncation away.
    const provider: Provider = {
      complete: (model: string): Promise<Completion> =>
        Promise.resolve({
          ok: true,
          model,
          content: '{"duplicate_of": 7, "confidence": 0.9, "rationale": "same b',
          finishReason: "length",
        }),
    };

    const judged = await judge(baseRequest({ provider }));

    expect(judged.verdict).toEqual(NOTHING);
    // Treated the same as any other model failure — recorded in `failures`,
    // never surfaced as `unreadable`, because no model is ever credited with
    // having actually answered here.
    expect(judged.failures).toHaveLength(1);
    expect(judged.failures[0]?.reason).toContain("cut off");
    expect(judged.unreadable).toBeNull();
    expect(judged.model).toBeNull();
  });

  it("rotates past a length-truncated answer to a model with room to finish", async () => {
    let calls = 0;
    const provider: Provider = {
      complete: (model: string): Promise<Completion> => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            model,
            content: '{"duplicate_of": 7, "confid',
            finishReason: "length",
          });
        }
        return Promise.resolve({
          ok: true,
          model,
          content: '{"duplicate_of": 9, "confidence": 0.8, "rationale": "same crash"}',
          finishReason: null,
        });
      },
    };

    const judged = await judge(baseRequest({ provider, models: ["a", "b"] }));

    expect(judged.verdict).toEqual({ duplicateOf: 9, confidence: 0.8, rationale: "same crash" });
    expect(judged.model).toBe("b");
  });

  it("rotates capacity failures into weather rather than failing the run", async () => {
    let calls = 0;
    const provider: Provider = {
      complete: (model: string): Promise<Completion> => {
        calls += 1;
        if (calls === 1)
          return Promise.resolve({ ok: false, model, kind: "capacity", reason: "429" });
        return Promise.resolve({
          ok: true,
          model,
          content: '{"duplicate_of": null, "confidence": 0.4, "rationale": "not sure"}',
          finishReason: null,
        });
      },
    };
    const weather = createWeather();

    const judged = await judge(baseRequest({ provider, models: ["a", "b"], weather }));

    expect(judged.verdict.duplicateOf).toBeNull();
    expect(judged.model).toBe("b");
    expect(weather.grounded("a")).toBe(true);
    expect(weather.grounded("b")).toBe(false);
  });
});

describe("parseVerdict", () => {
  it("reads a well-formed verdict", () => {
    expect(
      parseVerdict('{"duplicate_of": 9, "confidence": 0.5, "rationale": "same crash"}', CANDIDATES),
    ).toEqual({ duplicateOf: 9, confidence: 0.5, rationale: "same crash" });
  });

  it("reads a null duplicate as a real answer", () => {
    expect(
      parseVerdict('{"duplicate_of": null, "confidence": 0.2, "rationale": ""}', CANDIDATES),
    ).toEqual({ duplicateOf: null, confidence: 0.2, rationale: "" });
  });

  it("unwraps a whole answer packaged in a single code fence", () => {
    const fenced = [
      "```json",
      '{"duplicate_of": 7, "confidence": 0.8, "rationale": "x"}',
      "```",
    ].join("\n");
    expect(parseVerdict(fenced, CANDIDATES)?.duplicateOf).toBe(7);
  });

  it("discards a verdict naming a candidate that was never offered", () => {
    expect(
      parseVerdict('{"duplicate_of": 42, "confidence": 0.9, "rationale": "x"}', CANDIDATES),
    ).toBeNull();
  });

  it("discards a duplicate_of that is not an integer", () => {
    expect(
      parseVerdict('{"duplicate_of": 7.5, "confidence": 0.9, "rationale": "x"}', CANDIDATES),
    ).toBeNull();
  });

  it("discards text that is not JSON", () => {
    expect(parseVerdict("sure, it's a duplicate of #7", CANDIDATES)).toBeNull();
  });

  it("discards an answer that is a JSON array rather than an object", () => {
    expect(parseVerdict("[1, 2, 3]", CANDIDATES)).toBeNull();
  });

  it("discards a confidence outside 0 to 1", () => {
    expect(
      parseVerdict('{"duplicate_of": null, "confidence": 1.5, "rationale": "x"}', CANDIDATES),
    ).toBeNull();
  });

  it("discards a missing confidence", () => {
    expect(parseVerdict('{"duplicate_of": null, "rationale": "x"}', CANDIDATES)).toBeNull();
  });

  it("discards a rationale that is not a string", () => {
    expect(
      parseVerdict('{"duplicate_of": null, "confidence": 0.5, "rationale": 5}', CANDIDATES),
    ).toBeNull();
  });

  it("treats a missing rationale as empty rather than discarding the verdict", () => {
    expect(parseVerdict('{"duplicate_of": null, "confidence": 0.5}', CANDIDATES)).toEqual({
      duplicateOf: null,
      confidence: 0.5,
      rationale: "",
    });
  });

  it("trims the rationale", () => {
    expect(
      parseVerdict(
        '{"duplicate_of": null, "confidence": 0.5, "rationale": "  same bug  "}',
        CANDIDATES,
      )?.rationale,
    ).toBe("same bug");
  });

  it("discards a verdict when there were no candidates to name at all", () => {
    expect(parseVerdict('{"duplicate_of": 7, "confidence": 0.9, "rationale": "x"}', [])).toBeNull();
  });
});
