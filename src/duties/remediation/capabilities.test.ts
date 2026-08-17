/**
 * Unit tests for the capabilities module.
 */
import { describe, expect, it } from "vitest";

import { REMEDIATION_CAPABILITIES, REMEDIATION_DEFAULTS } from "./capabilities.js";

describe("REMEDIATION_DEFAULTS", () => {
  it("is empty — remediation proposes nothing without an explicit warrant", () => {
    expect(REMEDIATION_DEFAULTS).toEqual([]);
  });
});

describe("REMEDIATION_CAPABILITIES", () => {
  it("is exactly the proposal capability — the one effect this duty has", () => {
    expect(REMEDIATION_CAPABILITIES).toEqual(["propose"]);
  });
});
