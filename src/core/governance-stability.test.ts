/**
 * Governance stability tests — model-agnostic invariants of the enforcement layer.
 *
 * These tests exist separately from the functional tests in `enforce.test.ts`
 * and `outcome.test.ts` because they verify a different property: that
 * governance decisions are **deterministic** and **model-independent**, not
 * that any particular input produces any particular output.
 *
 * The separation is intentional. A functional test proves that `bug` is
 * refused when the warrant does not name it; a stability test proves that
 * nothing *outside the warrant* can change that answer. The two questions
 * are different, and a test file that answers both does neither clearly.
 *
 * ── Why every case here asserts a value ────────────────────────────────────
 *
 * A stability claim is the easiest kind of test to write vacuously, because
 * `expect(a).toEqual(b)` over two calls of a pure function is true of every
 * pure function — including one that has been gutted to return a constant.
 * This file previously carried four such cases, one of which was literally
 * `expect(true).toBe(true)`, and all four reported green for a suite that
 * would have survived deleting the code they named.
 *
 * So the rule this file now follows: **a stability case asserts the stable
 * value, not merely that two calls agree.** Agreement is the cheap half; the
 * value is what makes the case fail when the answer changes.
 *
 * ── Why two cases read a parameter list out of the source ──────────────────
 *
 * Two of the claims here are about a function's *shape* rather than its
 * output: `enforceLabels` and `gateClose` take no model id, no provider, no
 * prompt and no verdict, and that is why nothing the model said can reach
 * them. There is no input to vary that would demonstrate it — the absence of a
 * parameter is the whole property — so the check has to be structural.
 *
 * It was `expect(fn).toHaveLength(6)` first, and that was wrong in both
 * directions. `Function.prototype.length` counts parameters *before the first
 * defaulted one*, so the most likely way a model id would actually arrive —
 * `verdict: Verdict | null = null` appended for backward compatibility — left
 * the count at six and the suite green, which is the one case the check
 * existed for. And giving an existing parameter a default (`floor = 0`), which
 * changes nothing about what can reach the function, dropped the count to five
 * and turned the file red for nothing.
 *
 * So the parameter list is read from the declaration instead and asserted by
 * name. A default does not change a name, so the false red is gone; adding any
 * parameter does, so the question "what is this new input, and can a model
 * influence it?" lands in front of a reviewer, which is the entire job.
 * `capabilities.contract.test.ts` reads source for the same kind of claim and
 * for the same reason. Update the expected list when the answer to that
 * question is "no"; do not update it to make a suite green.
 *
 * See `docs/doctrine/north-star.md` for the doctrine these tests verify:
 * the model is intelligence; the warrant is governance; the two never meet.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { enforceLabels } from "./enforce.js";
import { parseWarrant, type Warrant } from "./warrant.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The parameter names a named function declares, read off its declaration.
 *
 * Every declaration this file asks about is formatted one parameter per line
 * by Prettier, which is what makes a line-anchored read of the names exact.
 * The region is bounded by the declaration and by the `)` that closes it at
 * column zero, so nothing below the signature can be mistaken for a parameter.
 */
async function parametersOf(file: string, name: string): Promise<string[]> {
  const text = await readFile(join(HERE, file), "utf8");
  const start = text.indexOf(`export function ${name}(`);
  const asyncStart = text.indexOf(`export async function ${name}(`);
  const from = start === -1 ? asyncStart : start;
  expect(from, `${file} no longer declares \`${name}\``).toBeGreaterThan(-1);

  const end = text.indexOf("\n)", from);
  expect(end, `\`${name}\` in ${file} is not formatted one parameter per line`).toBeGreaterThan(
    from,
  );

  return [...text.slice(from, end).matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1] ?? "");
}

/** A warrant with a fixed taxonomy, used as a stable baseline. */
const WARRANT: Warrant = parseWarrant(
  ".github/reeve.yml",
  `
version: 1
labels:
  - name: bug
    description: A defect in released behaviour.
  - name: enhancement
    description: A capability the project should add.
`,
);

describe("single-authority grants", () => {
  it("answers identically on repeated reads — no external state can change a grant", () => {
    const source = `
version: 1
duties:
  triage: [label]
`;
    const a = parseWarrant(".github/reeve.yml", source);
    const b = parseWarrant(".github/reeve.yml", source);

    // The value, not just the agreement: a `granted` gutted to return `[]`
    // would satisfy the equality on its own.
    expect(a.granted("triage", ["label", "comment"])).toEqual(["label"]);
    expect(b.granted("triage", ["label", "comment"])).toEqual(["label"]);
  });

  it("grants exactly what the file names — a workflow input cannot widen or narrow it", () => {
    // The file is the whole authority: the two arrays that used to meet in
    // `narrow` are now one, read from the warrant and bounded by it alone.
    const warrant = parseWarrant(
      ".github/reeve.yml",
      `
version: 1
duties:
  triage: [label, comment]
`,
    );
    expect(warrant.granted("triage", ["open-pr"])).toEqual(["label", "comment"]);
  });

  it("refuses a duty the block does not name, whatever the fallback grants", () => {
    const warrant = parseWarrant(
      ".github/reeve.yml",
      `
version: 1
duties:
  triage: [label]
`,
    );
    expect(warrant.granted("respond", ["comment"])).toEqual([]);
  });
});

describe("enforceLabels", () => {
  it("applies the same labels however many extra names the verdict proposed", () => {
    const one = enforceLabels(WARRANT.path, WARRANT.labels, ["bug"], [], 1, 0);
    const three = enforceLabels(
      WARRANT.path,
      WARRANT.labels,
      ["bug", "security", "wontfix"],
      [],
      1,
      0,
    );

    // The applied set is identical; the extra proposals are refused by name,
    // and each refusal says which file failed to name it. Asserting the
    // refusals rather than only their count is what stops this passing for a
    // `refused` that has forgotten what it refused.
    expect(one.applied).toEqual(["bug"]);
    expect(one.refused).toEqual([]);
    expect(three.applied).toEqual(["bug"]);
    expect(three.refused).toEqual([
      { what: "security", why: "`.github/reeve.yml` does not name it" },
      { what: "wontfix", why: "`.github/reeve.yml` does not name it" },
    ]);
  });

  it("carries nothing between calls — a second run cannot inherit the first run's labels", () => {
    const args = [WARRANT.path, WARRANT.labels, ["bug"], [] as string[], 1, 0] as const;

    const a = enforceLabels(...args);
    const b = enforceLabels(...args);

    // Equal in value and distinct in identity. The identity half is the part
    // that would catch an `applied` array hoisted to module scope and pushed
    // into on every call — which reads as stable until the second thread of
    // the same run inherits the first thread's labels.
    expect(a.applied).toEqual(["bug"]);
    expect(b.applied).toEqual(["bug"]);
    expect(a).toEqual(b);
    expect(a.applied).not.toBe(b.applied);
  });

  it("changes its answer for the confidence floor and for nothing the model said", () => {
    // The floor is the only lever here that moves the outcome, which is what
    // makes the two cases above stability claims rather than coincidences:
    // something *can* change the answer, and it is a number from the warrant.
    const above = enforceLabels(WARRANT.path, WARRANT.labels, ["bug"], [], 0.9, 0.5);
    const below = enforceLabels(WARRANT.path, WARRANT.labels, ["bug"], [], 0.4, 0.5);

    expect(above.applied).toEqual(["bug"]);
    expect(below.applied).toEqual([]);
    expect(below.refused).toHaveLength(1);
  });

  it("takes no model id, provider, prompt or verdict — every input is governance", async () => {
    // `confidence` is on this list and belongs there: it is a number the run
    // carries, and the case above shows the warrant's floor is what decides
    // against it. What must never appear is anything the model authored.
    expect(await parametersOf("enforce.ts", "enforceLabels")).toEqual([
      "path",
      "taxonomy",
      "proposed",
      "onThread",
      "confidence",
      "floor",
    ]);
  });
});

describe("gateClose", () => {
  it("takes no model id, confidence or verdict — every input is store or location", async () => {
    // The gate reads a file a human wrote and the coordinates of the thread it
    // is being asked about. There is no seventh input for the model to reach,
    // and unlike `enforceLabels` there is not even a confidence: a human's
    // recorded overrule is not weighed against how sure the model was.
    //
    // The behavioural cases for this function — a matching overruled record, a
    // record for a different thread, an unparseable line, an unreadable shard
    // — are in `src/duties/triage/outcome.test.ts`, which is where they
    // belong. This case pins only the shape.
    expect(await parametersOf("../duties/triage/outcome.ts", "gateClose")).toEqual([
      "contentsApi",
      "at",
      "path",
      "repo",
      "thread",
      "stateBranch",
    ]);
  });
});
