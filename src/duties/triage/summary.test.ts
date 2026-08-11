import { describe, expect, it } from "vitest";

import type { Spend } from "../../core/meter.js";

import {
  summarize,
  summarizeRecord,
  summarizeSweep,
  type RecordRun,
  type Run,
  type SweepRun,
} from "./summary.js";

// This page is read by the person who configured the run, and the question they
// open it with is never "what did it apply" — that is visible on the thread. It
// is "why is that different from what I expected", and every answer to that is
// something the run refused. So the cases below are mostly refusals.

function run(over: Partial<Run> = {}): Run {
  return {
    thread: 7,
    dryRun: false,
    warrant: ".github/reeve.yml",
    language: "English",
    screenedOut: null,
    proposed: ["bug"],
    confidence: 0.9,
    floor: 0.75,
    applied: ["bug"],
    refused: [],
    duplicateOf: null,
    permitted: ["label"],
    withheld: [],
    done: { labels: ["bug"], commented: false, assigned: [], closed: false },
    memory: { size: 0, recalled: 0, pivotRecalled: 0 },
    note: null,
    implicit: false,
    excludedLabels: [],
    ungranted: null,
    spent: [],
    modelNames: new Map(),
    screenNames: new Map(),
    ...over,
  };
}

function spend(over: Partial<Spend> = {}): Spend {
  return {
    purpose: "triage",
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
  it("names the thread and what was applied", () => {
    const page = summarize(run());

    expect(page).toContain("## Reeve · triage");
    expect(page).toContain("Thread #7");
    expect(page).toContain("Applied `bug`.");
  });

  it("says a dry run was a dry run, at the top", () => {
    expect(summarize(run({ dryRun: true }))).toContain("**dry run**, nothing was applied");
  });

  it("reports the confidence against the floor it was measured on", () => {
    // A number on its own is not information. The pair is what a maintainer
    // tunes.
    expect(summarize(run({ confidence: 0.42, floor: 0.75 }))).toContain(
      "Confidence 0.42 against a floor of 0.75",
    );
  });

  it("explains a verdict that was under the floor rather than reporting nothing", () => {
    const page = summarize(
      run({ confidence: 0.4, applied: [], proposed: ["bug", "docs"], refused: [] }),
    );

    expect(page).toContain("under the floor, so it is reported and not applied");
    expect(page).toContain("| `bug` | **not applied** | below the confidence floor of 0.75 |");
  });

  it("says which guardrail refused each label", () => {
    // The difference between `proposed` and `labels` is the guardrails, and this
    // is the only place a reader can see which guardrail it was.
    const page = summarize(
      run({
        proposed: ["bug", "invented"],
        applied: ["bug"],
        refused: [{ what: "invented", why: "`.github/reeve.yml` does not name it" }],
      }),
    );

    expect(page).toContain("| `bug` | applied | — |");
    expect(page).toContain("| `invented` | **refused** | `.github/reeve.yml` does not name it |");
  });

  it("says a verdict that proposed nothing is a real answer", () => {
    const page = summarize(run({ proposed: [], applied: [] }));

    expect(page).toContain("No label was applied.");
    expect(page).toContain("The verdict proposed no labels, which is a real answer.");
  });

  it("stops at the screen when the screen stopped the run", () => {
    const page = summarize(
      run({
        screenedOut: {
          reason: "template",
          note: "the issue template came back with nothing filled in",
        },
        proposed: [],
        applied: [],
        confidence: 0,
      }),
    );

    expect(page).toContain("Screened out as `template`");
    expect(page).toContain("This is a real answer rather than a failure.");
    // No table, because nothing was proposed and the reason it was not is at
    // the top of the page rather than in a column.
    expect(page).not.toContain("What the verdict proposed");
  });

  it("says why there is no verdict when there is none", () => {
    // Every model failing and an answer nobody could read are different
    // configurations with the same outcome, and a page reporting neither would
    // read as a model that agreed with nothing.
    expect(
      summarize(run({ note: "the verdict did not parse", proposed: [], applied: [] })),
    ).toContain("No verdict — the verdict did not parse.");
  });

  it("reports what memory contributed, including that it contributed nothing", () => {
    expect(summarize(run({ memory: { size: 12, recalled: 3, pivotRecalled: 0 } }))).toContain(
      "Memory: 3 of 12 corrections reached the prompt",
    );
    expect(summarize(run({ memory: { size: 1, recalled: 0, pivotRecalled: 0 } }))).toContain(
      "Memory: 0 of 1 correction reached the prompt",
    );
  });

  it("reports how many of the recalled corrections crossed a language", () => {
    expect(summarize(run({ memory: { size: 12, recalled: 3, pivotRecalled: 2 } }))).toContain(
      "2 of them found across languages",
    );
  });

  it("reports a duplicate it was not allowed to act on", () => {
    const page = summarize(run({ duplicateOf: 12 }));

    expect(page).toContain("possible duplicate of #12");
    expect(page).toContain("`apply` does not name `close`");
  });

  it("says so when it did close one", () => {
    const page = summarize(
      run({
        duplicateOf: 12,
        permitted: ["label", "close"],
        done: { labels: ["bug"], commented: false, assigned: [], closed: true },
      }),
    );

    expect(page).toContain("possible duplicate of #12, and closed.");
  });

  it("lists the effects beyond labelling, and only the ones that happened", () => {
    const page = summarize(
      run({ done: { labels: ["bug"], commented: true, assigned: ["ana"], closed: false } }),
    );

    expect(page).toContain("Also: a comment, assigned ana.");
  });

  it("says nothing about other effects when there were none", () => {
    expect(summarize(run())).not.toContain("Also:");
  });

  it("names the capabilities the workflow asked for and the file does not grant", () => {
    // Not an error — the file is the authority — but a maintainer who wrote
    // `apply: label, comment` and got no comment would otherwise read a working
    // action as a broken one.
    const page = summarize(run({ permitted: ["label"], withheld: ["comment", "close"] }));

    expect(page).toContain("`apply` asks for `comment`, `close`");
    expect(page).toContain("`.github/reeve.yml` does not grant to this duty");
  });

  it("says the same thing on a run the screen stopped", () => {
    // The gap between what was asked for and what is granted is a configuration
    // fact, and it is true whether or not the run reached a model.
    const page = summarize(
      run({
        screenedOut: { reason: "empty", note: "the thread carries no text to work from" },
        withheld: ["comment"],
      }),
    );

    expect(page).toContain("`apply` asks for `comment`");
  });

  it("bills the cheap roster and the expensive one as separate rows", () => {
    // Which is the whole point of metering them apart: a maintainer deciding
    // whether the cheap pass earns its keep needs two rows rather than one.
    const page = summarize(
      run({
        spent: [spend({ purpose: "screen", model: "small" }), spend()],
        screenNames: new Map([["small", "Quick"]]),
        modelNames: new Map([["big", "Careful"]]),
      }),
    );

    expect(page).toContain("| Screening | Quick |");
    expect(page).toContain("| Triage | Careful |");
  });

  it("says plainly when a run cost nothing", () => {
    expect(summarize(run())).toContain(
      "No model was asked anything this run — every decision was made by code.",
    );
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(summarize(run())).toMatch(/[^\n]\n$/);
  });

  it("says it ran at the narrowest authority when there was no warrant to read", () => {
    const page = summarize(run({ implicit: true, warrant: ".github/reeve.yml" }));

    expect(page).toContain(
      "No `.github/reeve.yml` — ran at the narrowest authority: labels only, from this " +
        "repository's own label descriptions.",
    );
  });

  it("names the labels the implicit taxonomy left out for carrying no description", () => {
    const page = summarize(run({ implicit: true, excludedLabels: ["question", "help wanted"] }));

    expect(page).toContain(
      "`question`, `help wanted` — these labels have no description on GitHub, so they " +
        "were not offered to the model — add a description there, or write a taxonomy in " +
        "`.github/reeve.yml`.",
    );
  });

  it("says nothing about an implicit authority when a warrant was actually read", () => {
    expect(summarize(run({ implicit: false }))).not.toContain("narrowest authority");
  });

  it("says why nothing was even attempted when a written block did not name this duty", () => {
    const page = summarize(
      run({
        ungranted:
          "`.github/reeve.yml`'s `capabilities:` block does not name `triage`; once that " +
          "block exists it is the whole answer, so add `triage: [label]` to it (or remove " +
          "the block to return to defaults).",
        proposed: [],
        applied: [],
        permitted: [],
      }),
    );

    expect(page).toContain("does not name `triage`");
    expect(page).toContain("No expensive model was asked anything. This is a real answer");
    // No table of refusals — nothing was ever proposed for one to hold.
    expect(page).not.toContain("### What the verdict proposed");
  });
});

/**
 * A `record` run never asks for a verdict, so this page carries none of
 * `Run`'s guardrail fields — only what was written to the store, and whether
 * a pivot rendering came with it.
 */
function recordRun(over: Partial<RecordRun> = {}): RecordRun {
  return {
    thread: 42,
    dryRun: false,
    recorded: true,
    language: "English",
    decided: ["bug"],
    pivot: false,
    pivotNote: null,
    corrections: ".reeve/corrections",
    spent: [],
    modelNames: new Map(),
    screenNames: new Map(),
    ...over,
  };
}

describe("summarizeRecord", () => {
  it("names the thread and what was recorded", () => {
    const page = summarizeRecord(recordRun());

    expect(page).toContain("## Reeve · triage — record");
    expect(page).toContain("Thread #42");
    expect(page).toContain("Recorded to `.reeve/corrections` as `bug`, in English.");
  });

  it("says a real answer when nothing was decided, rather than an empty list", () => {
    expect(summarizeRecord(recordRun({ decided: [] }))).toContain(
      "Recorded to `.reeve/corrections` as no labels, in English.",
    );
  });

  it("says the language is unidentified rather than naming none", () => {
    expect(summarizeRecord(recordRun({ language: null }))).toContain(
      "Recorded to `.reeve/corrections` as `bug`, in an unidentified language.",
    );
  });

  it("says a dry run rehearsed rather than committed, at the top", () => {
    expect(summarizeRecord(recordRun({ dryRun: true }))).toContain(
      "Thread #42 — **dry run**, nothing was committed.",
    );
  });

  it("says plainly when nothing was recorded", () => {
    // Not a shape `main.ts` produces today — `recordCorrection` always answers
    // `recorded: true` — but the page has to be honest about the field it
    // reads regardless of who is calling it.
    expect(summarizeRecord(recordRun({ recorded: false }))).toContain("Nothing was recorded.");
  });

  it("says a pivot rendering was stored alongside the correction", () => {
    expect(summarizeRecord(recordRun({ pivot: true }))).toContain(
      "A pivot-language rendering was translated and stored alongside it.",
    );
  });

  it("says why a pivot rendering is missing, when one was attempted and was not produced", () => {
    const page = summarizeRecord(
      recordRun({
        pivot: false,
        pivotNote:
          "A pivot-language rendering could not be produced this run, so the correction was " +
          "recorded without one.",
      }),
    );

    expect(page).toContain(
      "A pivot-language rendering could not be produced this run, so the correction was " +
        "recorded without one.",
    );
  });

  it("says nothing about a pivot rendering when none was attempted", () => {
    const page = summarizeRecord(recordRun({ pivot: false, pivotNote: null }));

    expect(page).not.toContain("pivot");
  });

  it("bills the pivot translation and the language detection as separate rows", () => {
    const page = summarizeRecord(
      recordRun({
        spent: [
          spend({ purpose: "detect", model: "small", requests: 1, prompt: 10, completion: 2 }),
          spend({ purpose: "pivot", model: "big" }),
        ],
        modelNames: new Map([
          ["small", "Quick"],
          ["big", "Careful"],
        ]),
      }),
    );

    expect(page).toContain("| Detection | Quick |");
    expect(page).toContain("| Pivot translation | Careful |");
  });

  it("says plainly when a run cost nothing", () => {
    expect(summarizeRecord(recordRun())).toContain(
      "No model was asked anything this run — every decision was made by code.",
    );
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(summarizeRecord(recordRun())).toMatch(/[^\n]\n$/);
  });
});

function sweep(over: Partial<SweepRun> = {}): SweepRun {
  return {
    dryRun: false,
    warrant: ".github/reeve.yml",
    results: [{ number: 7, outcome: "applied `bug`" }],
    skipped: 2,
    remaining: 0,
    starvedRun: false,
    ungranted: null,
    spent: [],
    modelNames: new Map(),
    screenNames: new Map(),
    ...over,
  };
}

describe("summarizeSweep", () => {
  it("names the mode and reports the three counts every sweep answers with", () => {
    const page = summarizeSweep(sweep({ results: [], skipped: 5, remaining: 3 }));

    expect(page).toContain("## Reeve · triage — sweep");
    expect(page).toContain("Processed 0, skipped 5 (already labelled), 3 remaining.");
  });

  it("says a dry run rehearsed rather than applied", () => {
    expect(summarizeSweep(sweep({ dryRun: true }))).toContain("**Dry run** — nothing was applied.");
  });

  it("tables one row per thread, with its outcome", () => {
    const page = summarizeSweep(
      sweep({
        results: [
          { number: 7, outcome: "applied `bug`" },
          { number: 9, outcome: "screened out — spam" },
        ],
      }),
    );

    expect(page).toContain("| #7 | applied `bug` |");
    expect(page).toContain("| #9 | screened out — spam |");
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

  it("bills the cheap roster and the expensive one as separate rows, as a single run does", () => {
    const page = summarizeSweep(
      sweep({
        spent: [
          {
            purpose: "screen",
            model: "small",
            requests: 1,
            failed: 0,
            prompt: 10,
            completion: 2,
            unreported: 0,
          },
          {
            purpose: "triage",
            model: "big",
            requests: 1,
            failed: 0,
            prompt: 900,
            completion: 40,
            unreported: 0,
          },
        ],
        screenNames: new Map([["small", "Quick"]]),
        modelNames: new Map([["big", "Careful"]]),
      }),
    );

    expect(page).toContain("| Screening | Quick |");
    expect(page).toContain("| Triage | Careful |");
  });

  it("reports why nothing was even attempted when a written block did not name this duty", () => {
    const page = summarizeSweep(
      sweep({
        ungranted:
          "`.github/reeve.yml`'s `capabilities:` block does not name `triage`; once that " +
          "block exists it is the whole answer, so add `triage: [label]` to it (or remove " +
          "the block to return to defaults).",
      }),
    );

    expect(page).toContain("## Reeve · triage — sweep");
    expect(page).toContain("does not name `triage`");
    // No table of results — nothing was ever attempted for one to hold.
    expect(page).not.toContain("| Thread | Outcome |");
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(summarizeSweep(sweep())).toMatch(/[^\n]\n$/);
  });
});
