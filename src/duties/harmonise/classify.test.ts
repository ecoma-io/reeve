/**
 * Unit tests for the classify module — diff classification parsing.
 */
import { describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";

import type { Completion, Provider } from "../../core/provider.js";
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
