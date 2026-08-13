/**
 * Unit tests for the classify module — diff classification parsing.
 */
import { describe, expect, it } from "vitest";

import { parseClassification } from "./classify.js";

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

  it("returns empty for empty input", () => {
    const result = parseClassification("");
    expect(result.hunks).toHaveLength(0);
    expect(result.hasSemantic).toBe(false);
  });

  it("handles whitespace around entries", () => {
    const raw = "  semantic  |  Added section  ";
    const result = parseClassification(raw);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.classification).toBe("semantic");
    expect(result.hunks[0]!.description).toBe("Added section");
  });
});
