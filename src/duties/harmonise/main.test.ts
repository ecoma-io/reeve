/**
 * Unit tests for the main module's processGroup behaviour — specifically the
 * classifyDiff try/catch and edge cases in group processing.
 *
 * `processGroup` is deeply coupled to the GitHub API, so rather than mocking
 * all of its dependencies, this file tests the behaviours that the integration
 * tests cannot reach: error paths and boundary conditions.
 */
import { describe, expect, it, vi } from "vitest";

import * as core from "@actions/core";

import { classifyDiff, parseClassification } from "./classify.js";
import type { Provider } from "../../core/provider.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  warning: vi.fn(),
}));

describe("classifyDiff", () => {
  /** A provider that always fails — simulates a classification error. */
  const failing: Provider = {
    complete(model: string) {
      return Promise.resolve({
        ok: false,
        model,
        reason: "capacity error",
        kind: "protocol",
      });
    },
  };

  it("throws when the model returns ok: false", async () => {
    await expect(
      classifyDiff("some diff", "target content", "en", "vi", failing, "model-a"),
    ).rejects.toThrow("classification failed");
  });

  it("includes the model's reason in the thrown error", async () => {
    await expect(
      classifyDiff("some diff", "target content", "en", "vi", failing, "model-a"),
    ).rejects.toThrow("capacity error");
  });
});

describe("parseClassification", () => {
  it("parses semantic hunks", () => {
    const result = parseClassification("semantic|Added Troubleshooting section");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.classification).toBe("semantic");
    expect(result.hunks[0]?.description).toBe("Added Troubleshooting section");
    expect(result.hasSemantic).toBe(true);
  });

  it("parses correction hunks", () => {
    const result = parseClassification("correction|Fixed typo 'teh' to 'the'");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.classification).toBe("correction");
    expect(result.hasSemantic).toBe(false);
  });

  it("parses locale-specific hunks", () => {
    const result = parseClassification("locale-specific|Added Vietnamese community link");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.classification).toBe("locale-specific");
    expect(result.hasSemantic).toBe(false);
  });

  it("treats unknown classifications as corrections (fail-safe)", () => {
    const result = parseClassification("unknown|Something mysterious");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.classification).toBe("correction");
    expect(result.hasSemantic).toBe(false);
  });

  it("parses multiple hunks on separate lines", () => {
    const input = [
      "semantic|Added API rate limit section",
      "correction|Fixed grammar in intro",
      "locale-specific|Added local pricing link",
    ].join("\n");
    const result = parseClassification(input);
    expect(result.hunks).toHaveLength(3);
    expect(result.hasSemantic).toBe(true);
  });

  it("skips blank lines", () => {
    const input = "semantic|Added section\n\n\ncorrection|Fixed typo";
    const result = parseClassification(input);
    expect(result.hunks).toHaveLength(2);
  });

  it("skips lines without a pipe separator", () => {
    const input = "semantic|Added section\nno pipe here\ncorrection|Fixed typo";
    const result = parseClassification(input);
    expect(result.hunks).toHaveLength(2);
  });

  it("warns and returns empty when no lines are parseable", () => {
    const result = parseClassification("no parseable content at all");
    expect(result.hunks).toEqual([]);
    expect(result.hasSemantic).toBe(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("no parseable output"));
  });

  it("is case-insensitive for the classification prefix", () => {
    const result = parseClassification("SEMANTIC|Added section\nCorrection|Fixed typo");
    expect(result.hunks[0]?.classification).toBe("semantic");
    expect(result.hunks[1]?.classification).toBe("correction");
  });
});
