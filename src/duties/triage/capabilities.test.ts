/**
 * The ladder `triage` asks for, and the default it holds when the warrant is
 * silent.
 *
 * Two constants, and both are read by something outside a run: `doctor` mode
 * narrows a warrant against `TRIAGE_CAPABILITIES` to tell a maintainer what
 * this duty would actually be allowed to do, and `DEFAULT_CAPABILITIES` is
 * what a repository with no `duties:` block grants. A ladder that has drifted
 * from the gates the duty really applies makes `doctor` answer a question
 * about a duty that no longer exists — quietly, and in the direction a
 * maintainer reads as authority.
 *
 * The sibling duties both pin their own (`review/capabilities.contract.test.ts`,
 * `remediation/capabilities.test.ts`); this file is triage's half, plus the
 * drift guard that reads the gates out of the source rather than out of a
 * second list somebody has to remember to update.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, type Capability } from "../../core/warrant.js";
import { DEFAULT_CAPABILITIES, TRIAGE_CAPABILITIES } from "./capabilities.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every capability this duty's own source actually gates on, read off the gates. */
async function gatedCapabilities(): Promise<readonly Capability[]> {
  const files = (await readdir(HERE)).filter(
    (name) => name.endsWith(".ts") && !name.includes(".test."),
  );
  // A directory that answered with nothing would make the check vacuous.
  expect(files).toContain("main.ts");

  const found = new Set<Capability>();
  for (const name of files) {
    const text = await readFile(join(HERE, name), "utf8");
    // Every `.includes("x")` whose argument is a capability the grammar knows
    // — which catches the gate however it is spelled, including the ones
    // written across a line break, and ignores the unrelated string checks
    // (`message.includes("sha")`) that share the shape.
    for (const [, capability] of text.matchAll(/\.includes\("([a-z-]+)"\)/g)) {
      if (CAPABILITIES.includes(capability as Capability)) found.add(capability as Capability);
    }
  }
  return [...found];
}

describe("what triage may do when the warrant says nothing", () => {
  it("grants a label and nothing else — the one effect a maintainer can undo in a click", () => {
    // The default belongs to the duty because only the duty knows what its
    // cheapest reversible action is. A comment cannot be un-read, a close
    // notifies everyone watching, and a recorded correction changes what the
    // next run believes.
    expect([...DEFAULT_CAPABILITIES]).toEqual(["label"]);
  });

  it("defaults to nothing that writes to the repository or speaks on the thread", () => {
    for (const capability of ["comment", "close", "assign", "record", "edit-file", "open-pr"]) {
      expect(DEFAULT_CAPABILITIES).not.toContain(capability);
    }
  });
});

describe("the ladder triage ever asks for", () => {
  it("is the seven capabilities its runtime gates on, and no others", () => {
    expect([...TRIAGE_CAPABILITIES].sort()).toEqual(
      ["assign", "close", "comment", "label", "open-pr", "propose", "record"].sort(),
    );
  });

  it("never asks to edit a file — writing source is a different duty's ladder", () => {
    // `open-pr` is on the ladder because a correction can be recorded to a
    // state branch and proposed; `edit-file` would be triage editing the
    // repository directly, which no triage decision has ever needed.
    expect(TRIAGE_CAPABILITIES).not.toContain("edit-file");
    expect(TRIAGE_CAPABILITIES).not.toContain("edit-body");
  });

  it("names only capabilities the warrant grammar can actually grant", () => {
    // A ladder entry the grammar does not know is inert, and an inert entry
    // that reads like authority is worse than a missing one.
    for (const capability of TRIAGE_CAPABILITIES) expect(CAPABILITIES).toContain(capability);
  });

  it("covers every gate the duty's own source applies, with nothing left over", async () => {
    // The drift guard. A new `permitted.includes("…")` added to a duty whose
    // ladder was not extended is a capability `doctor` would report as
    // ungranted while a run happily applies it — and a ladder entry no gate
    // reads is authority a maintainer grants for nothing.
    expect([...(await gatedCapabilities())].sort()).toEqual([...TRIAGE_CAPABILITIES].sort());
  });
});
