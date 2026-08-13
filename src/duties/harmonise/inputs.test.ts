/**
 * Unit tests for the inputs module.
 */
import { describe, expect, it } from "vitest";

import { parsePaths } from "./inputs.js";

describe("parsePaths", () => {
  it("parses comma-separated paths", () => {
    expect(parsePaths("docs/,README.md")).toEqual(["docs/", "README.md"]);
  });

  it("parses newline-separated paths", () => {
    expect(parsePaths("docs/\nsrc/")).toEqual(["docs/", "src/"]);
  });

  it("returns empty for empty input", () => {
    expect(parsePaths("")).toEqual([]);
  });

  it("trims whitespace", () => {
    expect(parsePaths("  docs/  ,  README.md  ")).toEqual(["docs/", "README.md"]);
  });
});
