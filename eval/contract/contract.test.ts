/**
 * The config contract: what the post-T1 warrant reader promises about the
 * `duties:` block, asserted against `src/core/warrant.ts` and the duty
 * capability modules, both read-only.
 *
 * Every eval fixture under `eval/fixtures/` stands on these shapes — a bug is
 * supported and retained report. A change to the reader that breaks one of them
 * breaks the fixtures first and loudest here, before any bundle has to chase a
 * misbehaving run.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CAPABILITIES as HARMONISE_DEFAULTS } from "../../src/duties/harmonise/capabilities.ts";
import { DEFAULT_CAPABILITIES as RESPOND_DEFAULTS } from "../../src/duties/respond/capabilities.ts";
import { DEFAULT_CAPABILITIES as TRIAGE_DEFAULTS } from "../../src/duties/triage/capabilities.ts";
import { parseWarrant } from "../../src/core/warrant.ts";
import type { Capability } from "../../src/core/warrant.ts";

/** A warrant body with a `duties:` block, the only shape this suite tests. */
function withDuties(duties: string): string {
  return `version: 1\nlabels: []\nduties:\n${duties}`;
}

/** The grant the reader hands `granted` for a duty, under a given body. */
function grant(body: string, duty: string, fallback: readonly Capability[]): readonly Capability[] {
  return parseWarrant("reeve.yml", body).granted(duty, fallback);
}

describe("the post-T1 warrant contract every eval fixture stands on", () => {
  it("names `duties` as the root key, refusing the old `apply` vocabulary", () => {
    // The pre-1.0 shape this key replaced, refused by name rather than read
    // as a silently ignored setting.
    expect(() => parseWarrant("reeve.yml", "version: 1\nlabels: []\napply: triage\n")).toThrow(
      /unrecognized key `apply`/,
    );
    expect(() => parseWarrant("reeve.yml", withDuties("  triage: true\n"))).not.toThrow();
  });

  it("grants `true` the duty's own documented default, not the caller's numbers", () => {
    expect(grant(withDuties("  triage: true\n"), "triage", TRIAGE_DEFAULTS)).toEqual(["label"]);
    expect(grant(withDuties("  respond: true\n"), "respond", RESPOND_DEFAULTS)).toEqual([]);
    expect(grant(withDuties("  harmonise: true\n"), "harmonise", HARMONISE_DEFAULTS)).toEqual([]);
  });

  it("spells `harmonise`'s write pair out explicitly — never defaulted", () => {
    // `edit-file` and `open-pr` commit files. The duty's own documented
    // default is nothing, so a fixture that wants the write pair grants it
    // explicitly, exactly as the harmonise eval fixtures do.
    expect(
      grant(withDuties("  harmonise: [edit-file, open-pr]\n"), "harmonise", HARMONISE_DEFAULTS),
    ).toEqual(["edit-file", "open-pr"]);
  });

  it("grants exactly the list written", () => {
    const granted = grant(withDuties("  triage: [label, comment, close]\n"), "triage", []);
    expect(granted).toEqual(["label", "comment", "close"]);
    // A single capability written bare is one entry — the same shape YAML
    // gives `triage: label`, which is what somebody writes when there is one.
    expect(grant(withDuties("  respond: comment\n"), "respond", [])).toEqual(["comment"]);
  });

  it("grants a listed duty exactly what it lists, never the default under a `true`", () => {
    // `duties: { triage: [label] }` means *only* label — `comment` applied by
    // the fixture above is not silently handed to the narrower grant.
    expect(grant(withDuties("  triage: [label]\n"), "triage", TRIAGE_DEFAULTS)).toEqual(["label"]);
  });

  it("leaves a duty it never names at its default, and a written block does not", () => {
    // No block at all: every duty keeps its fallback.
    const silent = parseWarrant("reeve.yml", "version: 1\nlabels: []\n");
    expect(silent.granted("triage", TRIAGE_DEFAULTS)).toEqual(["label"]);
    expect(silent.unnamed("triage")).toBe(false);

    // A block that exists and names other duties: the unlisted duty is granted
    // nothing — the enumeration forgot it, which is a decision.
    const block = parseWarrant("reeve.yml", withDuties("  triage: true\n"));
    expect(block.granted("respond", RESPOND_DEFAULTS)).toEqual([]);
    expect(block.unnamed("respond")).toBe(true);

    // `false` and `[none]` are named decisions, not omissions: nothing is
    // granted, but the duty is not *un* named.
    for (const body of [withDuties("  triage: false\n"), withDuties("  triage: [none]\n")]) {
      const parsed = parseWarrant("reeve.yml", body);
      expect(parsed.granted("triage", TRIAGE_DEFAULTS)).toEqual([]);
      expect(parsed.unnamed("triage")).toBe(false);
    }
  });

  it("refuses an empty `duties:` block as the half-finished edit it is", () => {
    expect(() => parseWarrant("reeve.yml", withDuties(""))).toThrow(
      /writes `duties:` with nothing/,
    );
  });

  it("refuses a duty that does not exist", () => {
    expect(() => parseWarrant("reeve.yml", withDuties("  notaduty: true\n"))).toThrow(
      /not a known duty/,
    );
  });

  it("refuses a capability no duty can be granted", () => {
    expect(() => parseWarrant("reeve.yml", withDuties("  triage: [warp]\n"))).toThrow(
      /not something a duty can be granted/,
    );
  });
});
