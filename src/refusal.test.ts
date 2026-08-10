import { describe, expect, it } from "vitest";

import { DUTIES, PLANNED, normalise, refusal } from "./refusal.js";

describe("normalise", () => {
  it("lowercases and trims", () => {
    expect(normalise("  Triage\n")).toBe("triage");
  });

  it("leaves an empty value empty", () => {
    expect(normalise("   \n ")).toBe("");
  });
});

describe("refusal", () => {
  it("names no duty at all when the input was empty", () => {
    const message = refusal("");
    expect(message).toContain("is not a duty");
    expect(message).toContain("docs/north-star.md#6-roadmap");
  });

  it("points at the roadmap for a duty that is documented and not built", () => {
    const message = refusal("triage", []);
    expect(message).toContain("documented contract but no code");
    expect(message).toContain("docs/north-star.md#6-roadmap");
  });

  it("gives the corrected `uses:` line for a duty this ref carries", () => {
    // The branch that matters on the day `DUTIES` stops being empty. Written
    // now so it does not arrive untested with the first duty.
    expect(refusal("triage", ["triage"])).toContain("uses: ecoma-io/reeve/triage@v1");
  });

  it("lists what a ref carries when the duty asked for is not one of them", () => {
    const message = refusal("nonsense", ["triage", "translate"]);
    expect(message).toContain("no duty called `nonsense`");
    expect(message).toContain("ecoma-io/reeve/triage@v1, ecoma-io/reeve/translate@v1");
  });

  it("says nothing is built when nothing is, rather than listing an empty set", () => {
    expect(refusal("nonsense", [])).toContain("No duty has been built at this ref yet");
  });

  it("reads a misspelled case the way the corrected spelling would be read", () => {
    expect(refusal("  TRIAGE ", ["triage"])).toBe(refusal("triage", ["triage"]));
  });

  it("prefers what is built over what is planned", () => {
    // A duty can be in both lists during the release that builds it, and the
    // useful answer is the one the consumer can act on today.
    expect(refusal("triage", ["triage"])).toContain("uses: ecoma-io/reeve/triage@v1");
  });
});

describe("the duty lists", () => {
  it("plans every duty the documentation gives a contract to", () => {
    expect(PLANNED).toEqual(["triage", "translate", "duplicate", "respond"]);
  });

  it("claims only duties that are also planned", () => {
    // A ref cannot carry a duty nothing documents. This fails the day someone
    // adds an entry to `DUTIES` without a page for it.
    expect(DUTIES.every((duty) => PLANNED.includes(duty))).toBe(true);
  });
});
