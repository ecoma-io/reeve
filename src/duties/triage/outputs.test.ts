import { beforeEach, describe, expect, it, vi } from "vitest";

const { summarize, summarizeRecord, summarizeSweep, setOutput } = vi.hoisted(() => ({
  summarize: vi.fn(() => "PAGE"),
  summarizeRecord: vi.fn(() => "RECORD-PAGE"),
  summarizeSweep: vi.fn(() => "SWEEP-PAGE"),
  setOutput: vi.fn(),
}));

vi.mock("./summary.js", () => ({ summarize, summarizeRecord, summarizeSweep }));

import * as core from "@actions/core";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  setOutput,
}));

import type { Settings } from "./inputs.js";
import type { Outcome, SweepAccumulator } from "./main.js";
import type { RecordOutcome } from "./record.js";
import {
  NOTHING_DONE,
  page,
  recordPage,
  remainingOf,
  report,
  reportRecordRun,
  reportSweep,
  sweepPage,
} from "./outputs.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function outcomeOf(over: Partial<Outcome> = {}): Outcome {
  return {
    language: "English",
    screenedOut: null,
    verdict: { labels: ["bug"], confidence: 0.9, duplicateOf: null, rationale: "" },
    applied: ["bug"],
    refused: [],
    permitted: ["label"],
    withheld: [],
    note: null,
    memory: { size: 3, recalled: 1, pivotRecalled: 0 },
    implicit: false,
    excludedLabels: [],
    ungranted: null,
    ...over,
  };
}

function recordOutcomeOf(over: Partial<RecordOutcome> = {}): RecordOutcome {
  return {
    recorded: true,
    language: "English",
    decided: ["bug"],
    pivot: false,
    pivotNote: null,
    machineOnly: false,
    unattributable: false,
    ...over,
  };
}

function settingsOf(over: Partial<Settings> = {}): Settings {
  return {
    warrant: ".github/reeve.yml",
    confidence: 0.75,
    correctionsDir: "corrections/",
    dryRun: false,
    modelNames: new Map(),
    screenNames: new Map(),
    stateBranch: "",
    ...over,
  } as Settings;
}

function accumulatorOf(over: Partial<SweepAccumulator> = {}): SweepAccumulator {
  return {
    results: [],
    skipped: 0,
    starvedRun: false,
    candidates: 0,
    ungranted: null,
    recording: false,
    ...over,
  };
}

describe("remainingOf", () => {
  it("is candidates minus what was processed and what was skipped", () => {
    expect(
      remainingOf(
        accumulatorOf({ candidates: 10, results: [{ number: 1, outcome: "x" }], skipped: 2 }),
      ),
    ).toBe(7);
  });

  it("never goes below zero", () => {
    expect(
      remainingOf(
        accumulatorOf({ candidates: 1, results: [{ number: 1, outcome: "x" }], skipped: 3 }),
      ),
    ).toBe(0);
  });
});

describe("NOTHING_DONE", () => {
  it("is the neutral `Done` every dry run and every unattempted path reports", () => {
    expect(NOTHING_DONE).toEqual({ labels: [], commented: false, assigned: [], closed: false });
  });
});

describe("report", () => {
  /**
   * The raw call log, in call order, values coerced to `string` the same way
   * `@actions/core`'s own `setOutput` does — unlike a `Map`, this keeps
   * order and every call, including a duplicate key, rather than collapsing
   * to whichever write landed last.
   */
  function calls(): (readonly [string, string])[] {
    return vi.mocked(core.setOutput).mock.calls.map(([key, value]) => [key, String(value)]);
  }

  it("writes all twelve keys, in `writeOutputs`' own order, on an ordinary run", () => {
    const outcome = outcomeOf({
      applied: ["bug"],
      verdict: { labels: ["bug", "docs"], confidence: 0.83, duplicateOf: 12, rationale: "" },
      language: "French",
      screenedOut: null,
    });
    const done = { labels: ["bug"], commented: true, assigned: [], closed: false };

    report(outcome, done, false, false);

    expect(calls()).toEqual([
      ["labels", JSON.stringify(["bug"])],
      ["proposed", JSON.stringify(["bug", "docs"])],
      ["confidence", "0.83"],
      ["language", "French"],
      ["duplicate-of", "12"],
      ["screened-out", ""],
      ["applied", JSON.stringify(done)],
      ["starved", "false"],
      ["processed", "0"],
      ["skipped", "0"],
      ["remaining", "0"],
      ["recorded", "false"],
    ]);
  });

  it("reports `applied` as `{}` under a rehearsal, never the `done` it would have taken", () => {
    const outcome = outcomeOf();
    const done = { labels: ["bug"], commented: false, assigned: [], closed: false };

    report(outcome, done, true, false);

    expect(calls()).toContainEqual(["applied", "{}"]);
  });

  it("reports `duplicate-of` and `screened-out` and `language` empty when the outcome has none", () => {
    const outcome = outcomeOf({
      language: null,
      screenedOut: { reason: "spam", note: "looked like spam" },
      verdict: { labels: [], confidence: 0, duplicateOf: null, rationale: "" },
    });

    report(outcome, NOTHING_DONE, false, false);

    expect(calls()).toContainEqual(["language", ""]);
    expect(calls()).toContainEqual(["duplicate-of", ""]);
    expect(calls()).toContainEqual(["screened-out", "spam"]);
  });

  it("reports `starved` from the caller, independent of the outcome", () => {
    report(outcomeOf(), NOTHING_DONE, false, true);

    expect(calls()).toContainEqual(["starved", "true"]);
  });
});

describe("reportSweep", () => {
  it("writes the sweep's own five keys, `recorded` from `bulk.recording`", () => {
    const bulk = accumulatorOf({
      results: [
        { number: 1, outcome: "applied `bug`" },
        { number: 2, outcome: "no label" },
      ],
      skipped: 3,
      candidates: 10,
      recording: true,
    });

    reportSweep(bulk, false);

    expect(core.setOutput).toHaveBeenCalledWith("processed", "2");
    expect(core.setOutput).toHaveBeenCalledWith("skipped", "3");
    expect(core.setOutput).toHaveBeenCalledWith("remaining", "5");
    expect(core.setOutput).toHaveBeenCalledWith("starved", "false");
    expect(core.setOutput).toHaveBeenCalledWith("recorded", "true");
  });

  it("reports `recorded` false for an ordinary sweep", () => {
    reportSweep(accumulatorOf({ recording: false }), false);

    expect(core.setOutput).toHaveBeenCalledWith("recorded", "false");
  });
});

describe("reportRecordRun", () => {
  /** Same call-order-and-duplicate-preserving log as `report`'s own `calls()`, above. */
  function calls(): (readonly [string, string])[] {
    return vi.mocked(core.setOutput).mock.calls.map(([key, value]) => [key, String(value)]);
  }

  it("writes the full twelve-key contract, in order, with the record path's own neutral values", () => {
    reportRecordRun(recordOutcomeOf({ recorded: true, language: "Spanish" }), false);

    expect(calls()).toEqual([
      ["labels", "[]"],
      ["proposed", "[]"],
      ["confidence", "0.00"],
      ["language", "Spanish"],
      ["duplicate-of", ""],
      ["screened-out", ""],
      ["applied", JSON.stringify(NOTHING_DONE)],
      ["starved", "false"],
      ["processed", "0"],
      ["skipped", "0"],
      ["remaining", "0"],
      ["recorded", "true"],
    ]);
  });

  it("reports `language` empty when the outcome detected none", () => {
    reportRecordRun(recordOutcomeOf({ language: null }), false);

    expect(calls()).toContainEqual(["language", ""]);
  });

  it("reports `recorded` false when the outcome did not write", () => {
    reportRecordRun(recordOutcomeOf({ recorded: false }), false);

    expect(calls()).toContainEqual(["recorded", "false"]);
  });
});

describe("page", () => {
  it("passes the outcome and done through to `summarize`, field for field", () => {
    const settings = settingsOf({ warrant: ".github/other.yml", dryRun: true });
    const outcome = outcomeOf({
      implicit: true,
      excludedLabels: ["wontfix"],
      ungranted: "not named",
    });
    const done = { labels: ["bug"], commented: true, assigned: ["octocat"], closed: true };

    const result = page(settings, 7, outcome, done, []);

    expect(result).toBe("PAGE");
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: 7,
        dryRun: true,
        warrant: ".github/other.yml",
        language: outcome.language,
        screenedOut: outcome.screenedOut,
        proposed: outcome.verdict.labels,
        confidence: outcome.verdict.confidence,
        floor: settings.confidence,
        applied: outcome.applied,
        refused: outcome.refused,
        duplicateOf: outcome.verdict.duplicateOf,
        permitted: outcome.permitted,
        withheld: outcome.withheld,
        done,
        memory: outcome.memory,
        note: outcome.note,
        implicit: true,
        excludedLabels: ["wontfix"],
        ungranted: "not named",
        spent: [],
        modelNames: settings.modelNames,
        screenNames: settings.screenNames,
      }),
    );
  });
});

describe("recordPage", () => {
  it("passes the record outcome through to `summarizeRecord`, field for field", () => {
    const settings = settingsOf({ correctionsDir: "corrections/custom.jsonl" });
    const outcome = recordOutcomeOf({ pivot: true, pivotNote: "rendered" });

    const result = recordPage(settings, 9, outcome, []);

    expect(result).toBe("RECORD-PAGE");
    expect(summarizeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: 9,
        dryRun: settings.dryRun,
        recorded: outcome.recorded,
        language: outcome.language,
        decided: outcome.decided,
        pivot: true,
        pivotNote: "rendered",
        correctionsDir: "corrections/custom.jsonl",
        spent: [],
        modelNames: settings.modelNames,
        screenNames: settings.screenNames,
      }),
    );
  });
});

describe("sweepPage", () => {
  it("passes the accumulator through to `summarizeSweep`, including the computed `remaining`", () => {
    const settings = settingsOf();
    const bulk = accumulatorOf({
      results: [{ number: 1, outcome: "applied `bug`" }],
      skipped: 1,
      candidates: 5,
      starvedRun: true,
      ungranted: null,
      recording: true,
    });

    const result = sweepPage(settings, bulk, []);

    expect(result).toBe("SWEEP-PAGE");
    expect(summarizeSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: settings.dryRun,
        warrant: settings.warrant,
        results: bulk.results,
        skipped: 1,
        remaining: 3,
        starvedRun: true,
        ungranted: null,
        recording: true,
        spent: [],
        modelNames: settings.modelNames,
        screenNames: settings.screenNames,
      }),
    );
  });
});
