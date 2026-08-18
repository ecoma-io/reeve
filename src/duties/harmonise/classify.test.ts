/**
 * Unit tests for the classify module — diff classification parsing.
 */
import { describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";

import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { classifyDiff, parseClassification } from "./classify.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  warning: vi.fn(),
}));

describe("parseClassification", () => {
  it("parses semantic classification", () => {
    const result = parseClassification("semantic|Added new troubleshooting section");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.classification).toBe("semantic");
    expect(result.hunks[0]!.description).toBe("Added new troubleshooting section");
    expect(result.hasSemantic).toBe(true);
  });

  it("parses correction classification", () => {
    const result = parseClassification("correction|Fixed typo in heading");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.classification).toBe("correction");
    expect(result.hasSemantic).toBe(false);
  });

  it("parses locale-specific classification", () => {
    const result = parseClassification("locale-specific|Added Vietnamese community link");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.classification).toBe("locale-specific");
    expect(result.hasSemantic).toBe(false);
  });

  it("parses multiple classifications", () => {
    const raw = [
      "semantic|Added troubleshooting section",
      "correction|Fixed typo in introduction",
      "locale-specific|Added Vietnamese link",
    ].join("\n");

    const result = parseClassification(raw);
    expect(result.hunks).toHaveLength(3);
    expect(result.hasSemantic).toBe(true);
  });

  it("treats unknown classifications as corrections (fail-safe)", () => {
    const result = parseClassification("unknown-category|Something weird");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.classification).toBe("correction"); // Safe: no propagation
    expect(result.hasSemantic).toBe(false);
  });

  it("skips lines without a pipe separator", () => {
    const result = parseClassification("just some text\nsemantic|Valid entry");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.description).toBe("Valid entry");
  });

  it("returns empty for empty input and emits a warning (D5)", () => {
    const warningSpy = vi.spyOn(core, "warning");

    const result = parseClassification("");
    expect(result.hunks).toHaveLength(0);
    expect(result.hasSemantic).toBe(false);
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining("classifier produced no parseable output"),
    );

    warningSpy.mockRestore();
  });

  it("handles whitespace around entries", () => {
    const raw = "  semantic  |  Added section  ";
    const result = parseClassification(raw);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.classification).toBe("semantic");
    expect(result.hunks[0]!.description).toBe("Added section");
  });
});

describe("classifyDiff rotation", () => {
  const SOURCE = "added a section";
  const TARGET = "existing content";

  /** An endpoint whose models answer with whatever the case scripted for them. */
  function scripted(answers: Record<string, string | Completion>): Provider {
    return {
      complete(model: string): Promise<Completion> {
        const answer = answers[model];
        if (answer === undefined) {
          return Promise.resolve({
            ok: false,
            model,
            reason: "no answer scripted",
            kind: "protocol",
          });
        }
        return Promise.resolve(
          typeof answer === "string"
            ? { ok: true, model, content: answer, finishReason: "stop" }
            : answer,
        );
      },
    };
  }

  it("rotates past a failing first model and classifies on the second", async () => {
    const provider = scripted({
      first: { ok: false, model: "first", reason: "overloaded", kind: "capacity" },
      second: "semantic|Added a section",
    });

    const result = await classifyDiff(SOURCE, TARGET, "en", "vi", provider, ["first", "second"]);

    expect(result.hasSemantic).toBe(true);
    expect(result.hunks[0]?.description).toBe("Added a section");
  });

  it("throws only when the whole roster is exhausted", async () => {
    const provider = scripted({
      first: { ok: false, model: "first", reason: "overloaded", kind: "capacity" },
      second: { ok: false, model: "second", reason: "down", kind: "capacity" },
    });

    await expect(
      classifyDiff(SOURCE, TARGET, "en", "vi", provider, ["first", "second"]),
    ).rejects.toThrow("classification failed");
  });

  it("uses the first model that answers when it never fails", async () => {
    const provider = scripted({ first: "correction|Fixed a typo" });

    const result = await classifyDiff(SOURCE, TARGET, "en", "vi", provider, ["first", "second"]);

    expect(result.hasSemantic).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D12's run-wide memory, at this consumption site.
//
// `classifyDiff` takes a `Weather` and hands it to `rotateModels`. Nothing
// pinned that it does — and a version that dropped the argument is silent: the
// run still classifies, it just re-buys the same 429 once per document group,
// and drafting (which shares the same weather) is left thinking a model it has
// already exhausted is still standing.
// ---------------------------------------------------------------------------

describe("classifyDiff under D12 weather", () => {
  const CLASSIFICATION = "semantic|Added a section";

  /** A provider that records which models it was asked, in order. */
  function recording(answers: Record<string, string | Completion>): {
    provider: Provider;
    asked: string[];
  } {
    const asked: string[] = [];
    return {
      asked,
      provider: {
        complete: (model: string) => {
          asked.push(model);
          const answer = answers[model];
          return Promise.resolve<Completion>(
            answer === undefined
              ? { ok: false, model, reason: "no answer", kind: "protocol" }
              : typeof answer === "string"
                ? { ok: true, model, content: answer, finishReason: "stop" }
                : answer,
          );
        },
      },
    };
  }

  async function classify(
    provider: Provider,
    models: readonly string[],
    weather?: Weather,
  ): Promise<unknown> {
    return classifyDiff("a diff", "target content", "en", "vi", provider, models, weather);
  }

  it("never_asks_a_model_an_earlier_stage_already_grounded_for_capacity", async () => {
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: CLASSIFICATION });

    await classify(provider, ["busy", "live"], weather);

    expect(asked).toEqual(["live"]);
  });

  it("grounds_a_capacity_failed_model_so_the_next_document_group_skips_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: { ok: false, model: "busy", reason: "HTTP 429", kind: "capacity" },
      live: CLASSIFICATION,
    });

    await classify(provider, ["busy", "live"], weather);
    expect(asked).toEqual(["busy", "live"]);

    await classify(provider, ["busy", "live"], weather);

    expect(asked).toEqual(["busy", "live", "live"]);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("fails_the_run_red_the_instant_a_model_reports_an_auth_failure", async () => {
    const { provider, asked } = recording({
      a: { ok: false, model: "a", reason: "HTTP 401", kind: "auth" },
      b: CLASSIFICATION,
    });

    await expect(classify(provider, ["a", "b"])).rejects.toThrow(AuthenticationFailure);
    expect(asked).toEqual(["a"]);
  });
});
