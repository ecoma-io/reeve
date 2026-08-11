import { describe, expect, it } from "vitest";

import type { Spend } from "../../core/meter.js";

import { summarize, summarizeSweep, type Run, type SweepRun } from "./summary.js";

function run(over: Partial<Run> = {}): Run {
  return {
    thread: 7,
    dryRun: false,
    warrant: ".github/reeve.yml",
    language: "English",
    ungranted: null,
    duplicateOf: 12,
    confidence: 0.9,
    floor: 0.75,
    lexicalScore: 4.2,
    rank: { corpusSize: 20, offered: 5 },
    pivot: { used: false, note: null },
    note: null,
    permitted: ["comment"],
    withheld: [],
    done: { commented: true },
    posted: "posted",
    spent: [],
    modelNames: new Map(),
    ...over,
  };
}

function spend(over: Partial<Spend> = {}): Spend {
  return {
    purpose: "duplicate",
    model: "big",
    requests: 1,
    failed: 0,
    prompt: 900,
    completion: 40,
    unreported: 0,
    ...over,
  };
}

describe("summarize", () => {
  it("names the thread and the duty", () => {
    const page = summarize(run());

    expect(page).toContain("## Reeve · duplicate");
    expect(page).toContain("Thread #7");
  });

  it("says a dry run was a dry run, at the top", () => {
    expect(summarize(run({ dryRun: true }))).toContain("**dry run**, nothing was applied");
  });

  it("reports the confidence against the floor it was measured on", () => {
    expect(summarize(run({ confidence: 0.42, floor: 0.75 }))).toContain(
      "Confidence 0.42 against a floor of 0.75",
    );
  });

  it("reports how much of the corpus reached the judge", () => {
    expect(summarize(run({ rank: { corpusSize: 20, offered: 5 } }))).toContain(
      "5 of 20 open threads reached the judge",
    );
  });

  it("never says '1 of it' — the singular reads exactly like every other count", () => {
    expect(summarize(run({ rank: { corpusSize: 1, offered: 1 } }))).toContain(
      "1 of 1 open thread reached the judge",
    );
  });

  it("says plainly when no duplicate was proposed", () => {
    const page = summarize(run({ duplicateOf: null, confidence: 0, posted: null }));

    expect(page).toContain("No duplicate was proposed.");
    expect(page).not.toContain("Proposed as a duplicate of");
  });

  it("names the proposed candidate", () => {
    expect(summarize(run({ duplicateOf: 12 }))).toContain("Proposed as a duplicate of #12.");
  });

  it("explains a verdict that was under the floor rather than reporting nothing", () => {
    const page = summarize(run({ duplicateOf: 12, confidence: 0.4, floor: 0.75, posted: null }));

    expect(page).toContain("under the floor, so it is reported and not applied");
    expect(page).toContain("`duplicate-of` and `score` still carry it");
  });

  it("says why there is no verdict when there is none", () => {
    expect(
      summarize(run({ note: "every model failed", duplicateOf: null, posted: null })),
    ).toContain("No verdict — every model failed.");
  });

  it("says a comment was posted", () => {
    expect(summarize(run({ posted: "posted", dryRun: false }))).toContain(
      "Posted a comment naming #12.",
    );
  });

  it("says a dry run would have posted", () => {
    expect(summarize(run({ posted: "posted", dryRun: true }))).toContain(
      "Would have posted a comment naming #12.",
    );
  });

  it("says its own previous comment was replaced", () => {
    expect(summarize(run({ posted: "replaced", dryRun: false }))).toContain(
      "Replaced its own previous comment with a comment naming #12.",
    );
  });

  it("says a rerun that reached the same fingerprint left the comment alone", () => {
    expect(summarize(run({ posted: "unchanged" }))).toContain(
      "Left its own previous comment unchanged",
    );
  });

  it("says nothing was posted when comment was not asked for", () => {
    const page = summarize(run({ posted: null }));

    expect(page).toContain("Nothing was posted — `apply` does not name `comment`");
    expect(page).toContain("`duplicate-of` and `score` still carry it");
  });

  it("names the capabilities the workflow asked for and the file does not grant", () => {
    const page = summarize(run({ permitted: [], withheld: ["comment"] }));

    expect(page).toContain("`apply` asks for `comment`");
    expect(page).toContain("`.github/reeve.yml` does not grant to this duty");
  });

  it("reports a pivot note when the cross-language bridge was used", () => {
    const page = summarize(
      run({
        pivot: { used: true, note: "Translated the query to English to compare candidates." },
      }),
    );

    expect(page).toContain("Translated the query to English to compare candidates.");
  });

  it("says nothing extra about the pivot when it was not used", () => {
    expect(summarize(run({ pivot: { used: false, note: null } }))).not.toContain("pivot");
  });

  it("bills the judge and the pivot translation as separate rows", () => {
    const page = summarize(
      run({
        spent: [
          spend({ purpose: "duplicate", model: "big" }),
          spend({ purpose: "pivot", model: "small" }),
        ],
        modelNames: new Map([
          ["big", "Careful"],
          ["small", "Quick"],
        ]),
      }),
    );

    expect(page).toContain("| Duplicate check | Careful |");
    expect(page).toContain("| Pivot translation | Quick |");
  });

  it("says plainly when a run cost nothing", () => {
    expect(summarize(run())).toContain(
      "No model was asked anything this run — every decision was made by code.",
    );
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(summarize(run())).toMatch(/[^\n]\n$/);
  });

  it("says why nothing was even attempted when a written block did not name this duty", () => {
    const page = summarize(
      run({
        ungranted:
          "`.github/reeve.yml`'s `capabilities:` block does not name `duplicate`; once that " +
          "block exists it is the whole answer, so add `duplicate: [comment]` to it (or remove " +
          "the block to return to defaults).",
        duplicateOf: null,
        posted: null,
        permitted: [],
      }),
    );

    expect(page).toContain("does not name `duplicate`");
    expect(page).toContain("No expensive model was asked anything. This is a real answer");
    expect(page).not.toContain("Proposed as a duplicate of");
  });
});

function sweep(over: Partial<SweepRun> = {}): SweepRun {
  return {
    dryRun: false,
    warrant: ".github/reeve.yml",
    results: [{ number: 7, outcome: "proposed #12" }],
    remaining: 0,
    starvedRun: false,
    ungranted: null,
    spent: [],
    modelNames: new Map(),
    ...over,
  };
}

describe("summarizeSweep", () => {
  it("names the mode and reports processed/remaining, with no skipped count", () => {
    const page = summarizeSweep(sweep({ results: [], remaining: 3 }));

    expect(page).toContain("## Reeve · duplicate — sweep");
    expect(page).toContain("Processed 0, 3 remaining.");
    expect(page).not.toContain("skipped");
  });

  it("says a dry run rehearsed rather than applied", () => {
    expect(summarizeSweep(sweep({ dryRun: true }))).toContain("**Dry run** — nothing was applied.");
  });

  it("tables one row per thread, with its outcome", () => {
    const page = summarizeSweep(
      sweep({
        results: [
          { number: 7, outcome: "proposed #12" },
          { number: 9, outcome: "no duplicate" },
        ],
      }),
    );

    expect(page).toContain("| #7 | proposed #12 |");
    expect(page).toContain("| #9 | no duplicate |");
  });

  it("says plainly when nothing was processed, rather than an empty table", () => {
    expect(summarizeSweep(sweep({ results: [] }))).toContain("Nothing was processed this run.");
  });

  it("explains a starved roster as weather, not a failure", () => {
    const page = summarizeSweep(sweep({ starvedRun: true, remaining: 4 }));

    expect(page).toContain("ran out of capacity partway through");
    expect(page).toContain("Weather, not a failure.");
  });

  it("says nothing about the roster when it was never starved", () => {
    expect(summarizeSweep(sweep({ starvedRun: false }))).not.toContain("ran out of capacity");
  });

  it("bills the judge roster by name", () => {
    const page = summarizeSweep(
      sweep({
        spent: [spend({ purpose: "duplicate", model: "big" })],
        modelNames: new Map([["big", "Careful"]]),
      }),
    );

    expect(page).toContain("| Duplicate check | Careful |");
  });

  it("reports why nothing was even attempted when a written block did not name this duty", () => {
    const page = summarizeSweep(
      sweep({
        ungranted:
          "`.github/reeve.yml`'s `capabilities:` block does not name `duplicate`; once that " +
          "block exists it is the whole answer, so add `duplicate: [comment]` to it (or remove " +
          "the block to return to defaults).",
      }),
    );

    expect(page).toContain("## Reeve · duplicate — sweep");
    expect(page).toContain("does not name `duplicate`");
    expect(page).not.toContain("| Thread | Outcome |");
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(summarizeSweep(sweep())).toMatch(/[^\n]\n$/);
  });
});
