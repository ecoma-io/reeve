/**
 * Unit tests for the capabilities module.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CAPABILITIES } from "./capabilities.js";

describe("DEFAULT_CAPABILITIES", () => {
  it("is empty — harmonise requires explicit warrant", () => {
    expect(DEFAULT_CAPABILITIES).toEqual([]);
  });
});
