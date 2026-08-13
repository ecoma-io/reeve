import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  // Every corrected line repeats the ref the consumer pinned, which the runner
  // hands over in `GITHUB_ACTION_REF`. Set here so the assertions below read as
  // the message a real consumer sees rather than as the off-runner placeholder.
  const REF = process.env.GITHUB_ACTION_REF;
  beforeEach(() => {
    process.env.GITHUB_ACTION_REF = "v0.1";
  });
  afterEach(() => {
    if (REF === undefined) delete process.env.GITHUB_ACTION_REF;
    else process.env.GITHUB_ACTION_REF = REF;
  });

  it("names no duty at all when the input was empty", () => {
    const message = refusal("");
    expect(message).toContain("is not a duty");
    expect(message).toContain("ecoma-io/reeve/translate@v0.1");
  });

  it("repeats the ref the consumer pinned rather than a version of its own", () => {
    // The whole point: somebody pinned to a tag is told to write that same tag.
    process.env.GITHUB_ACTION_REF = "a1b2c3d";
    expect(refusal("triage", ["triage"])).toContain("uses: ecoma-io/reeve/triage@a1b2c3d");
  });

  it("says so plainly when there is no ref to repeat", () => {
    // Off a runner — someone running the bundle by hand — there is no pin, and
    // a guess would be worse than a blank to fill in.
    delete process.env.GITHUB_ACTION_REF;
    expect(refusal("triage", ["triage"])).toContain(
      "uses: ecoma-io/reeve/triage@<the ref you pinned>",
    );
  });

  it("points a bare `uses:` at the roadmap while a ref carries nothing", () => {
    const message = refusal("", []);
    expect(message).toContain("is not a duty");
    expect(message).toContain("docs/doctrine/north-star.md#7-roadmap");
  });

  it("points at the roadmap for a duty that is documented and not built", () => {
    // `PLANNED` is empty at this ref — every documented duty has landed — so
    // the planned-branch is exercised with an injected list rather than the
    // real one, the same way `built` is exercised above with an injected list
    // before any ref carries anything.
    const message = refusal("someday", [], ["someday"]);
    expect(message).toContain("documented contract but no code");
    expect(message).toContain("docs/doctrine/north-star.md#7-roadmap");
  });

  it("gives the corrected `uses:` line for a duty this ref carries", () => {
    expect(refusal("triage", ["triage"])).toContain("uses: ecoma-io/reeve/triage@v0.1");
  });

  it("lists what a ref carries when the duty asked for is not one of them", () => {
    const message = refusal("nonsense", ["triage", "translate"]);
    expect(message).toContain("no duty called `nonsense`");
    expect(message).toContain("ecoma-io/reeve/triage@v0.1, ecoma-io/reeve/translate@v0.1");
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
    expect(refusal("duplicate", ["duplicate"])).toContain("uses: ecoma-io/reeve/duplicate@v0.1");
  });
});

describe("the duty lists", () => {
  it("covers every duty the documentation gives a contract to", () => {
    expect([...DUTIES, ...PLANNED].sort()).toEqual(
      ["triage", "translate", "duplicate", "respond", "lifecycle", "harmonise"].sort(),
    );
  });

  it("carries every duty this ref builds", () => {
    expect(DUTIES).toContain("translate");
    expect(DUTIES).toContain("triage");
    expect(DUTIES).toContain("duplicate");
    expect(DUTIES).toContain("respond");
    expect(DUTIES).toContain("lifecycle");
  });

  it("never lists the same duty as both built and planned", () => {
    // Both lists reach a message, and only one of them is true of a given ref.
    // A duty that stayed in `PLANNED` after it was built would still be
    // answered correctly — built is checked first — but the roadmap branch
    // would then be unreachable for it, which is a claim nothing tests.
    expect(DUTIES.filter((duty) => PLANNED.includes(duty))).toEqual([]);
  });

  it("names exactly the directories that ship their own action.yml", () => {
    // The drift this guards against: a duty lands (a new directory with its
    // own `action.yml` beside `dist/index.js`) and `DUTIES` is never told, so
    // the root action's refusal keeps recommending only the old set. Reading
    // the filesystem rather than a second hand-maintained list is the point —
    // this is the one place that would catch the omission.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dutyDirs = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== "node_modules" && name !== ".git")
      .filter((name) => existsSync(join(repoRoot, name, "action.yml")));

    expect(dutyDirs.sort()).toEqual([...DUTIES].sort());
  });
});
