/**
 * The `duties:` block, read as the whole authority it claims to be.
 *
 * `warrant.test.ts` covers the shapes a maintainer writes most often — a list,
 * `true`, `[none]`, an absent key. What is pinned here is the direction each
 * shape moves authority in, which is the half a test can accidentally leave
 * open: an assertion that a written grant is *honoured* still passes if the
 * grant is quietly unioned with the duty's own default, and an assertion that
 * `false` parses still passes if `false` came to mean "the default, spelled
 * differently".
 *
 * Nothing is mocked. Every question here is answered against the parsed file,
 * which is the entire point of the stage.
 */
import { describe, expect, it } from "vitest";

import { parseWarrant, type Capability, type Warrant } from "./warrant.js";

const PATH = ".github/reeve.yml";

const TAXONOMY = "version: 1\nlabels:\n  - name: bug\n    description: A defect.\n";

function warrant(duties: string): Warrant {
  return parseWarrant(PATH, `${TAXONOMY}duties:\n${duties}`);
}

/**
 * A fallback wider than anything written below, so a grant that fails to
 * narrow shows up as extra capabilities rather than as a passing test.
 */
const WIDE: readonly Capability[] = ["label", "comment", "close", "assign"];

describe("a written grant is the whole grant", () => {
  it("narrows a duty to what the file lists, discarding the wider default it would have had", () => {
    // The direction that matters. A grant read as "the default, plus whatever
    // the file adds" would pass every test that only ever names a fallback
    // narrower than the list — and it would hand `close` to a duty whose
    // maintainer wrote `[label]` precisely to take it away.
    expect(warrant("  triage: [label]\n").granted("triage", WIDE)).toEqual(["label"]);
  });

  it("keeps the file's order, which is the order a grant was written in", () => {
    expect(warrant("  triage: [comment, label]\n").granted("triage", WIDE)).toEqual([
      "comment",
      "label",
    ]);
  });

  it("reads a bare capability as the one-entry list it plainly is", () => {
    // `triage: label` is what somebody writes when there is one of them. The
    // scalar has to mean exactly that one grant — not the duty's default, and
    // not everything.
    expect(warrant("  triage: label\n").granted("triage", WIDE)).toEqual(["label"]);
  });

  it("reads a bare `none` as nothing at all, the same as `[none]`", () => {
    expect(warrant("  triage: none\n").granted("triage", WIDE)).toEqual([]);
  });

  it("refuses a bare capability that is misspelled, rather than reading it as an empty grant", () => {
    // The scalar form must be refused exactly as the list form is: a
    // misspelling that silently granted nothing is an absence a maintainer
    // discovers months later.
    expect(() => warrant("  triage: lablel\n")).toThrow(
      /names `lablel`, which is not something a duty can be granted/,
    );
  });
});

describe("`false` is a decision about a duty, not silence about it", () => {
  it("grants nothing, however wide the duty's own default is", () => {
    // `duties: { triage: false }` is the shortest way a maintainer turns a
    // duty off while leaving the rest of the block alone. If it ever came to
    // mean "the duty's own default" — the `true` sentinel is one character
    // away — every capability the duty defaults to would be handed back to a
    // file that plainly refused them.
    expect(warrant("  triage: false\n").granted("triage", WIDE)).toEqual([]);
  });

  it("still counts as the block having named the duty, so a run is not `unnamed`", () => {
    // `unnamed` is the call a duty makes to stop before spending anything.
    // `false` and "the block forgot me" both end in no capabilities, and they
    // are not the same fact: one was decided, the other was not.
    const w = warrant("  triage: false\n");

    expect(w.unnamed("triage")).toBe(false);
    expect(w.unnamed("translate")).toBe(true);
  });

  it("means the same grant as `[none]`, and the opposite one from `true`", () => {
    // The three sentinels side by side, because the risk is that one drifts
    // into another rather than that any one of them is wrong on its own.
    expect(warrant("  triage: false\n").granted("triage", WIDE)).toEqual([]);
    expect(warrant("  triage: [none]\n").granted("triage", WIDE)).toEqual([]);
    expect(warrant("  triage: true\n").granted("triage", WIDE)).toEqual(WIDE);
  });
});

describe("a duty a written block never named", () => {
  it("is refused everything, even a capability the block granted to a sibling", () => {
    // Once the enumeration exists it is the complete roster of who may act.
    const w = warrant("  triage: [label, comment]\n");

    expect(w.granted("translate", WIDE)).toEqual([]);
    expect(w.unnamed("translate")).toBe(true);
  });

  it("keeps its own default when there is no block to be missing from", () => {
    const w = parseWarrant(PATH, TAXONOMY);

    expect(w.granted("translate", WIDE)).toEqual(WIDE);
    expect(w.unnamed("translate")).toBe(false);
  });
});
