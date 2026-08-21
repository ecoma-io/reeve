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
 * ── Why two cases assert an arity ──────────────────────────────────────────
 *
 * Two of the claims here are about a function's *shape* rather than its
 * output: `enforceLabels` and `gateClose` take no model id, no provider, no
 * prompt and no verdict, and that is why nothing the model said can reach
 * them. There is no input to vary that would demonstrate this — the absence
 * of a parameter is the whole property — so the only mechanically checkable
 * form is the parameter count. It is a coarse instrument and deliberately so:
 * adding any parameter to either function turns this file red, which puts the
 * question "what is this new input, and can a model influence it?" in front of
 * a reviewer. That is the entire job. Update the number when the answer to
 * that question is "no"; do not update it to make a suite green.
 *
 * See `docs/doctrine/north-star.md` for the doctrine these tests verify:
 * the model is intelligence; the warrant is governance; the two never meet.
 */
import { describe, expect, it } from "vitest";

import { gateClose } from "../duties/triage/outcome.js";
import { enforceLabels } from "./enforce.js";
import { parseWarrant, type Warrant } from "./warrant.js";

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

  it("takes no model id, provider, prompt or verdict — six inputs, all governance", () => {
    // path, taxonomy, proposed, onThread, confidence, floor. See the file's
    // doc comment for why this is an arity and not a behavioural case.
    expect(enforceLabels).toHaveLength(6);
  });
});

describe("gateClose", () => {
  it("takes no model id, confidence or verdict — six inputs, all store and location", () => {
    // contentsApi, at, path, repo, thread, stateBranch. The gate reads a file
    // a human wrote and the coordinates of the thread it is being asked
    // about; there is no seventh input for the model to reach.
    //
    // The behavioural cases for this function — a matching overruled record,
    // a record for a different thread, an unparseable line, an unreadable
    // shard — are in `src/duties/triage/outcome.test.ts`, which is where they
    // belong. This case pins only the shape.
    expect(gateClose).toHaveLength(6);
  });
});
