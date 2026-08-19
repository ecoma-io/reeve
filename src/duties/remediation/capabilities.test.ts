/**
 * Unit tests for the capabilities module.
 */
import { describe, expect, it } from "vitest";

import { REMEDIATION_CAPABILITIES, DEFAULT_CAPABILITIES } from "./capabilities.js";

describe("DEFAULT_CAPABILITIES", () => {
  it("is empty — remediation proposes nothing without an explicit warrant", () => {
    expect(DEFAULT_CAPABILITIES).toEqual([]);
  });
});

describe("REMEDIATION_CAPABILITIES", () => {
  it("is exactly the proposal capability — the one effect this duty has", () => {
    expect(REMEDIATION_CAPABILITIES).toEqual(["propose"]);
  });
});
