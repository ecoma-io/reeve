/**
 * Where the enforcement stage's gates actually sit, and what it accounts for.
 *
 * `enforce.test.ts` pins that each gate exists — a name the file does not
 * carry, a confidence under the floor, an exclusive conflict. What is pinned
 * here is the other half a reviewer asks about: the exact value each gate
 * opens at, whether a label's own floor really replaces the run's rather than
 * merely competing with it, and whether every proposal that did not become a
 * label is visible as a refusal rather than dropped on the way through.
 *
 * Nothing is mocked, for the same reason nothing is mocked next door: every
 * function here is a decision about a parsed file and a list of strings.
 */
import { describe, expect, it } from "vitest";

import { enforceLabels } from "./enforce.js";
import { parseWarrant, type Warrant } from "./warrant.js";

const PATH = ".github/reeve.yml";

const PLAIN = parseWarrant(
  PATH,
  `
version: 1
labels:
  - name: bug
    description: Released behaviour contradicts its documentation.
  - name: performance
    description: Correct behaviour that is too slow.
  - name: needs reproduction
    description: A plausible defect report without enough to reproduce it.
    exclusive_with: [bug]
`,
);

function decide(
  proposed: readonly string[],
  confidence: number,
  floor: number,
  w: Warrant = PLAIN,
  onThread: readonly string[] = [],
) {
  return enforceLabels(w.path, w.labels, proposed, onThread, confidence, floor);
}

describe("the confidence floor is a floor, not a threshold above it", () => {
  it("applies a proposal that meets the run's floor exactly", () => {
    // `confidence: 0.75` in a workflow means "0.75 is enough". A gate written
    // one comparison out would refuse the value a maintainer typed, and the
    // symptom is a duty that quietly stops labelling at exactly the number
    // they chose.
    expect(decide(["bug"], 0.75, 0.75).applied).toEqual(["bug"]);
  });

  it("refuses a proposal a hair under it", () => {
    // The other side of the same boundary, so the case above cannot be passing
    // because the gate opened for everything.
    expect(decide(["bug"], 0.7499999, 0.75).applied).toEqual([]);
  });

  it("applies a proposal that meets a label's own floor exactly", () => {
    const own = parseWarrant(
      PATH,
      "version: 1\nlabels:\n  - name: bug\n    description: A defect.\n    confidence: 0.9\n",
    );

    expect(decide(["bug"], 0.9, 0.1, own).applied).toEqual(["bug"]);
    expect(decide(["bug"], 0.8999999, 0.1, own).applied).toEqual([]);
  });
});

describe("a label's own floor replaces the run's, whatever it says", () => {
  it("lets a floor of zero opt a label out of a run-wide floor entirely", () => {
    // `confidence: 0` is a real setting — a label a maintainer wants applied
    // on whatever the model was willing to say. It is also the value a
    // fallback written as `entry.confidence || floor` swallows, silently
    // handing that label the run's floor instead and refusing every proposal
    // under it. Absent is the only thing that may fall back.
    const zero = parseWarrant(
      PATH,
      "version: 1\nlabels:\n  - name: bug\n    description: A defect.\n    confidence: 0\n",
    );

    expect(decide(["bug"], 0, 0.9, zero).applied).toEqual(["bug"]);
    expect(decide(["bug"], 0, 0.9, zero).refused).toEqual([]);
  });

  it("names that label's own floor in the refusal, so the message points at the line to change", () => {
    const own = parseWarrant(
      PATH,
      "version: 1\nlabels:\n  - name: security\n    description: A vulnerability.\n    confidence: 0.95\n",
    );

    expect(decide(["security"], 0.9, 0.1, own).refused).toEqual([
      { what: "security", why: "confidence 0.90 is under `security`'s own floor of 0.95" },
    ]);
  });
});

describe("every proposal is accounted for", () => {
  it("reports one outcome per distinct proposal, so nothing is dropped in silence", () => {
    // A warrant violation is supposed to end in a dropped effect that is
    // visible in the outputs, every time. A verdict mixing four kinds of
    // proposal has to come back with all four accounted for — a stage that
    // `continue`d past one without pushing a refusal would look identical to
    // one that never saw it.
    const decision = decide(["bug", "security", "needs reproduction", "performance"], 1, 0, PLAIN, [
      "performance",
    ]);

    expect(decision.applied).toEqual(["bug"]);
    expect(decision.refused.map((refusal) => refusal.what)).toEqual([
      "security",
      "needs reproduction",
      "performance",
    ]);
    expect(decision.applied.length + decision.refused.length).toBe(4);
  });

  it("answers a repeated proposal once, whether it was applied or refused", () => {
    // Two events landing in one run propose the same label twice. The applied
    // side is one label; the refused side has to be one line too, or a report
    // counts a single mistake as two.
    expect(decide(["security", "security"], 1, 0).refused).toEqual([
      { what: "security", why: "`.github/reeve.yml` does not name it" },
    ]);
    expect(decide(["bug", "bug"], 1, 0)).toEqual({ applied: ["bug"], refused: [] });
  });
});
