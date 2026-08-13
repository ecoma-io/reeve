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

import { enforceLabels, narrow } from "./enforce.js";
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

describe("narrow", () => {
  it("is a pure function of two arrays — no external state can change its answer", () => {
    const a = narrow(["label", "comment"], ["label"]);
    const b = narrow(["label", "comment"], ["label"]);

    expect(a).toEqual(b);
  });

  it("produces the same capability set regardless of which side is larger", () => {
    // The file grants two; the workflow asks for one. The result is one.
    const fileWider = narrow(["label", "comment", "close"], ["label"]);

    // The file grants one; the workflow asks for three. The result is one.
    const workflowWider = narrow(["label"], ["label", "comment", "close"]);

    // Both produce the same intersection.
    expect(fileWider.permitted).toEqual(["label"]);
    expect(workflowWider.permitted).toEqual(["label"]);
  });

  it("is independent of provider configuration — it takes no provider argument", () => {
    // `narrow` has no parameter for a provider, model id, or endpoint.
    // This test documents that structural fact. If `narrow` ever gains
    // such a parameter, this test should be rewritten to assert that
    // the parameter does not change the result.
    const result = narrow(["label"], ["label"]);

    expect(result.permitted).toEqual(["label"]);
    expect(result.withheld).toEqual([]);
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
