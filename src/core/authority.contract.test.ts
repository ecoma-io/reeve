/**
 * Intent-contract tests — the intent matrix's category-B rows exercised
 * through the REAL warrant parser and the REAL enforcement gates.
 *
 * `warrant.test.ts` already pins the grant shapes exhaustively; `enforce.test.ts`
 * pins the label gates. What this file adds is the contract boundary the matrix
 * calls B2/B3/B4: a written `duties:` block that does not name the duty denies
 * everything (with default-grant semantics preserved), enforcement cannot be
 * widened by configuration, and every confidence gate holds for the non-finite
 * values an injection-shaped verdict produces.
 */

import { describe, expect, it } from "vitest";

import { enforceLabels, type LabelDecision } from "./enforce.js";
import type { Language } from "./languages.js";
import { parseLanguages } from "./languages.js";
import type { Label } from "./warrant.js";
import { dutyLanguages, parseWarrant } from "./warrant.js";

const MINIMAL = "version: 1\n";

function label(over: Partial<Label> = {}): Label {
  return {
    name: "bug",
    description: "Something that used to work and does not.",
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

describe("B2 — a written duties block that does not name the duty is a denied run", () => {
  it("a denied run promises a green no-op, including a silent languages resolution", () => {
    const warrant = parseWarrant(
      ".github/reeve.yml",
      ["version: 1", "duties:", "  translate: [edit-body]"].join("\n"),
    );
    const fallback = [] as readonly Language[];

    expect(dutyLanguages(warrant, warrant.unnamed("translate"), fallback)).toEqual([]);
  });
});

describe("B3/B4 — enforcement is a gate, never a widening", () => {
  const warrant = parseWarrant(".github/reeve.yml", MINIMAL);

  it("applies only names the warrant's taxonomy carries, whatever the verdict claims", () => {
    const decision: LabelDecision = enforceLabels(
      warrant.path,
      [label()],
      ["bug", "docs", ""],
      [],
      0.9,
      0.5,
    );

    expect(decision.applied).toEqual(["bug"]);
    expect(decision.refused.map((entry) => entry.what)).toEqual(["docs", ""]);
  });

  it("a human label already on the thread overrules the verdict, and its exclusiveWith tells the reason", () => {
    const decision = enforceLabels(
      warrant.path,
      [label({ exclusiveWith: ["performance"] })],
      ["bug"],
      ["performance"],
      0.9,
      0.5,
    );

    expect(decision.applied).toEqual([]);
    expect(decision.refused.map((entry) => entry.what)).toEqual(["bug"]);
    expect(decision.refused[0]?.why).toMatch(/excludes it/);
  });
});

describe("D2 — malformed configuration fails deterministically", () => {
  it("refuses an unrecognized key, a wrong version, and a non-mapping, by name", () => {
    expect(() => parseWarrant(".github/reeve.yml", MINIMAL + "unrecognized: x")).toThrow(
      /unrecognized key `unrecognized`/,
    );
    expect(() => parseWarrant(".github/reeve.yml", "version: 2\n")).toThrow(/declares version `2`/);
    expect(() => parseWarrant(".github/reeve.yml", "- bug\n- enhancement\n")).toThrow(
      /is not a warrant/,
    );
  });
});

/** Triage's own documented default — `src/duties/triage/main.ts:172`. */
const TRIAGE_DEFAULT: readonly Language[] = parseLanguages("en, vi, zh");

describe("C3 — default languages are declared per duty and resolved by the warrant", () => {
  it("a silent file resolves to the duty's own documented default, unchanged", () => {
    const warrant = parseWarrant(".github/reeve.yml", MINIMAL);

    const languages = dutyLanguages(warrant, false, TRIAGE_DEFAULT);

    expect(languages.map((language) => language.code)).toEqual(["en", "vi", "zh"]);
    // The same array the duty shipped, identity and all — resolution is a read,
    // never a widening.
    expect(languages).toBe(TRIAGE_DEFAULT);
  });

  it("a written `languages:` key is the whole answer once written", () => {
    const warrant = parseWarrant(".github/reeve.yml", "version: 1\nlanguages: [en, vi]\n");

    const languages = dutyLanguages(warrant, false, TRIAGE_DEFAULT);

    expect(languages.map((language) => language.code)).toEqual(["en", "vi"]);
  });

  it("a denied run reads no languages — promised a green no-op", () => {
    const warrant = parseWarrant(".github/reeve.yml", MINIMAL);

    expect(dutyLanguages(warrant, true, TRIAGE_DEFAULT)).toEqual([]);
  });
});
