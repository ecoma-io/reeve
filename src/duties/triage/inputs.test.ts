import { describe, expect, it } from "vitest";

import { DEFAULT_PROPOSE_WORKSPACE, type Label, type Warrant } from "../../core/warrant.js";

import { parseSweepState, resolveTaxonomy, taxonomyNames, type Settings } from "./inputs.js";

describe("parseSweepState", () => {
  it.each(["open", "closed", "all"] as const)("accepts `%s`", (state) => {
    expect(parseSweepState(state)).toBe(state);
  });

  it("trims and lower-cases before matching", () => {
    expect(parseSweepState(" CLOSED \n")).toBe("closed");
  });

  it("rejects anything else", () => {
    expect(() => parseSweepState("archived")).toThrow(
      "sweep-state: expected one of open, closed, all, got `archived`.",
    );
  });
});

function labelOf(over: Partial<Label> = {}): Label {
  return {
    name: "bug",
    description: "Something is broken.",
    not: null,
    examples: [],
    owner: null,
    exclusiveWith: [],
    confidence: null,
    paths: [],
    create: false,
    color: null,
    ...over,
  };
}

function warrantOf(labels: readonly Label[]): Warrant {
  const byName = new Map(labels.map((label) => [label.name, label]));
  return {
    path: ".github/reeve.yml",
    labels,
    languages: null,
    pivot: null,
    memory: null,
    about: null,
    lifecycle: null,
    dependa: null,
    propose: DEFAULT_PROPOSE_WORKSPACE,
    granted: (_duty, fallback) => fallback,
    unnamed: () => false,
    labelNamed: (name) => byName.get(name),
  };
}

describe("resolveTaxonomy", () => {
  it("is the whole taxonomy, in the warrant's own order, when `labels` names nothing", () => {
    const bug = labelOf({ name: "bug" });
    const docs = labelOf({ name: "docs" });
    const warrant = warrantOf([bug, docs]);

    expect(resolveTaxonomy(warrant, "")).toEqual([bug, docs]);
  });

  it("narrows to the named subset, still in the warrant's own order", () => {
    const bug = labelOf({ name: "bug" });
    const docs = labelOf({ name: "docs" });
    const question = labelOf({ name: "question" });
    const warrant = warrantOf([bug, docs, question]);

    // Requested out of order — the warrant's order wins, not the input's.
    expect(resolveTaxonomy(warrant, "question, bug")).toEqual([bug, question]);
  });

  it("splits on newlines as well as commas, and trims whitespace", () => {
    const bug = labelOf({ name: "bug" });
    const docs = labelOf({ name: "docs" });
    const warrant = warrantOf([bug, docs]);

    expect(resolveTaxonomy(warrant, "bug\n docs \n")).toEqual([bug, docs]);
  });

  it("refuses a name the taxonomy does not have, rather than dropping it silently", () => {
    const warrant = warrantOf([labelOf({ name: "bug" })]);

    expect(() => resolveTaxonomy(warrant, "typo-name")).toThrow(
      /`typo-name` is not in `\.github\/reeve\.yml`'s taxonomy/,
    );
  });
});

describe("taxonomyNames", () => {
  it("is the set of the resolved taxonomy's own names", () => {
    const settings = {
      taxonomy: [labelOf({ name: "bug" }), labelOf({ name: "docs" })],
    } as unknown as Settings;

    expect(taxonomyNames(settings)).toEqual(new Set(["bug", "docs"]));
  });

  it("is empty when the taxonomy is", () => {
    const settings = { taxonomy: [] } as unknown as Settings;

    expect(taxonomyNames(settings)).toEqual(new Set());
  });
});
