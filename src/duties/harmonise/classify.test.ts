/**
 * Unit tests for the classify module — diff classification parsing.
 */
import { describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";

import { parseClassification } from "./classify.js";

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
