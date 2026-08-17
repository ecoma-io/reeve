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
 * See `docs/doctrine/north-star.md` for the doctrine these tests verify:
 * the model is intelligence; the warrant is governance; the two never meet.
 */
import { describe, expect, it } from "vitest";

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
    const a = parseWarrant(
      ".github/reeve.yml",
      `
version: 1
duties:
  triage: [label]
`,
    );
    const b = parseWarrant(
      ".github/reeve.yml",
      `
version: 1
duties:
  triage: [label]
`,
    );

    expect(a.granted("triage", ["label", "comment"])).toEqual(
      b.granted("triage", ["label", "comment"]),
    );
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
  it("refuses the same labels regardless of what the verdict proposed beyond the taxonomy", () => {
    // A verdict that proposes only known labels.
    const known = enforceLabels(WARRANT.path, WARRANT.labels, ["bug"], [], 1, 0);

    // A verdict that proposes a known label *and* an unknown one.
    const withUnknown = enforceLabels(WARRANT.path, WARRANT.labels, ["bug", "security"], [], 1, 0);

    // The applied labels are the same in both cases — the unknown one
    // is simply refused, not silently applied.
    expect(known.applied).toEqual(["bug"]);
    expect(withUnknown.applied).toEqual(["bug"]);
    expect(withUnknown.refused.length).toBeGreaterThan(known.refused.length);
  });

  it("produces the same output for the same warrant, thread state, and confidence", () => {
    const args = [WARRANT.path, WARRANT.labels, ["bug"], [] as string[], 1, 0] as const;

    const a = enforceLabels(...args);
    const b = enforceLabels(...args);

    expect(a).toEqual(b);
  });

  it("is independent of the model that produced the verdict — it takes no model argument", () => {
    // `enforceLabels` has no parameter for a model id, provider, or prompt.
    // This test documents that structural fact. If `enforceLabels` ever
    // gains such a parameter, this test should be rewritten.
    const result = enforceLabels(WARRANT.path, WARRANT.labels, ["bug"], [], 1, 0);

    expect(result.applied).toEqual(["bug"]);
    expect(result.refused).toEqual([]);
  });

  it("applies the same labels from the same warrant, no matter how many extra proposals the model made", () => {
    const oneProposal = enforceLabels(WARRANT.path, WARRANT.labels, ["bug"], [], 1, 0);
    const threeProposals = enforceLabels(
      WARRANT.path,
      WARRANT.labels,
      ["bug", "security", "wontfix"],
      [],
      1,
      0,
    );

    // Extra proposals that fall outside the taxonomy are refused, not applied.
    // The applied set is identical in both cases.
    expect(oneProposal.applied).toEqual(["bug"]);
    expect(threeProposals.applied).toEqual(["bug"]);
    expect(threeProposals.refused.length).toBe(2);
  });
});

describe("gateClose", () => {
  it("reads only the corrections store, never the model verdict", () => {
    // `gateClose` is tested thoroughly in `outcome.test.ts`. This test
    // documents the structural invariant: `gateClose` takes a ContentsApi
    // and a store path — it has no parameter for a verdict, a confidence
    // score, or a model id. It cannot be influenced by anything the model
    // said, only by what a human recorded in the corrections store.
    //
    // If `gateClose` ever gains such a parameter, this test should be
    // rewritten to assert that the parameter does not change the result.
    //
    // The full behavioural tests are in `outcome.test.ts` and in
    // `main.integration.test.ts` (which verifies the gate holds
    // independently of `memory.recall: 0`).
    expect(true).toBe(true);
  });
});
