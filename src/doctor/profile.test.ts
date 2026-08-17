import { describe, expect, it } from "vitest";

import { eld } from "eld/small";

import { PROFILE_CODES } from "./profile.js";

/**
 * The one thing that can drift: `PROFILE_CODES` is a hand-kept mirror of the
 * codes `eld/small`'s S60 profile actually recognises. `detectByProfile` keys
 * on `code.toLowerCase()` against the set `eld.setLanguageSubset` returns, so
 * a code this list lacks is a code the runtime would silently drop — exactly
 * the false "outside the profile" a doctor finding built on this list must
 * never emit. Parity is the point, asserted once here rather than trusted.
 */
describe("PROFILE_CODES", () => {
  it("matches the codes eld's S60 profile actually recognises", () => {
    const accepted = new Set(Object.values(eld.setLanguageSubset([...PROFILE_CODES])));
    expect(accepted.size).toBe(PROFILE_CODES.size);
    expect([...PROFILE_CODES].every((code) => accepted.has(code))).toBe(true);
  });
});
