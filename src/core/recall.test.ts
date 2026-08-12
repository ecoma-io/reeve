import { describe, expect, it } from "vitest";

import type { Correction } from "./memory.js";
import { renderRecall } from "./recall.js";

// Nothing is mocked: `renderRecall` is pure text-shaping over data this suite
// builds by hand. What matters is the structural claim the module's own doc
// comment makes — an ordinary decision and a reversal render under different
// headings, and a reversal never falls into the plain "DECIDED:" frame an
// ordinary decision gets, because that frame reads as an endorsement.

function decision(over: Partial<Correction> = {}): Correction {
  return {
    repo: "ecoma-io/reeve",
    thread: 1,
    duty: "triage",
    at: "2026-08-01T00:00:00Z",
    title: "Export produces an empty file",
    excerpt: "The export writes zero bytes when the table has exactly one row.",
    language: "en",
    proposed: ["bug"],
    decided: ["bug", "needs reproduction"],
    by: "maintainer",
    note: null,
    outcome: null,
    duplicateOf: null,
    pivot: null,
    ...over,
  };
}

function reversedLabel(over: Partial<Correction> = {}): Correction {
  return decision({
    thread: 2,
    title: "Dark mode setting is lost between sessions",
    proposed: ["bug"],
    decided: [],
    outcome: "overruled",
    duplicateOf: null,
    ...over,
  });
}

function reversedClose(over: Partial<Correction> = {}): Correction {
  return decision({
    thread: 3,
    title: "Crash on save with a long filename",
    proposed: [],
    decided: [],
    outcome: "overruled",
    duplicateOf: 40,
    ...over,
  });
}

describe("renderRecall", () => {
  it("returns an empty string for nothing recalled", () => {
    expect(renderRecall([])).toBe("");
  });

  it("renders an ordinary decision under the decisions heading, with its labels", () => {
    const rendered = renderRecall([decision()]);

    expect(rendered).toContain("--- DECISIONS THIS PROJECT ALREADY MADE ---");
    expect(rendered).toContain("#1: Export produces an empty file");
    expect(rendered).toContain("DECIDED: bug, needs reproduction");
  });

  it("shows what was proposed only when it differs from what was decided", () => {
    const same = renderRecall([decision({ proposed: ["bug"], decided: ["bug"] })]);
    expect(same).not.toContain("proposed at the time");

    const different = renderRecall([
      decision({ proposed: ["bug"], decided: ["needs reproduction"] }),
    ]);
    expect(different).toContain("(proposed at the time: bug)");
  });

  it("never renders a reversed correction under the plain DECIDED: frame", () => {
    // The one guarantee `recall.ts`'s doc comment names by name: a model must
    // never read a reversal as an ordinary endorsed decision.
    const rendered = renderRecall([reversedLabel()]);

    expect(rendered).not.toContain("DECIDED:");
    expect(rendered).toContain("--- REVERSED: A HUMAN UNDID ONE OF REEVE'S OWN ACTIONS ---");
  });

  it("states an S1 label reversal as a fact, not an instruction", () => {
    const rendered = renderRecall([reversedLabel({ proposed: ["bug"], decided: [] })]);

    expect(rendered).toContain("Automation applied bug. A human removed it.");
    expect(rendered).toContain("It stands as: no labels.");
    expect(rendered).not.toMatch(/do not|never apply/i);
  });

  it("states an S1 reversal generically when no single removed label survives the diff", () => {
    const rendered = renderRecall([reversedLabel({ proposed: ["bug"], decided: ["bug"] })]);

    expect(rendered).toContain("Automation labeled this thread. A human corrected the labels.");
  });

  it("states an S3 close reversal as a fact, naming the target it was closed against", () => {
    const rendered = renderRecall([reversedClose()]);

    expect(rendered).toContain("Automation closed this thread as a duplicate of #40.");
    expect(rendered).toContain("A human reopened it: that close was reversed.");
  });

  it("puts decisions before reversals, as two separate sections", () => {
    const rendered = renderRecall([reversedLabel(), decision()]);
    const decidedAt = rendered.indexOf("DECISIONS THIS PROJECT ALREADY MADE");
    const reversedAt = rendered.indexOf("REVERSED: A HUMAN UNDID");

    expect(decidedAt).toBeGreaterThanOrEqual(0);
    expect(reversedAt).toBeGreaterThan(decidedAt);
  });

  it("omits a section entirely when nothing recalled belongs to it", () => {
    expect(renderRecall([decision()])).not.toContain("REVERSED");
    expect(renderRecall([reversedLabel()])).not.toContain("DECISIONS THIS PROJECT ALREADY MADE");
  });

  it("carries a note onto a reversed line the same way it does an ordinary one", () => {
    expect(renderRecall([decision({ note: "flaky on CI" })])).toContain("WHY: flaky on CI");
    expect(renderRecall([reversedClose({ note: "wrong target" })])).toContain("WHY: wrong target");
  });
});
