/**
 * Every output `triage` writes, and every summary page it builds — kept
 * together because all six functions here are pure renderings of a result
 * `main.ts`'s `run()` already reached (`Outcome`, `RecordOutcome` or
 * `SweepAccumulator`), onto one of the two surfaces a workflow reads a run
 * from. Nothing in this file decides anything a caller has not already
 * decided.
 *
 * Type-only import back to `main.ts` (`Outcome`, `SweepAccumulator`) is safe
 * for the same reason it is everywhere else in this duty: `main.ts` calls
 * `await run()` at import time, so a value import from this module back into
 * it would risk executing the action from a test file, but a type import is
 * erased before that ever matters — see `vitest.config.ts`'s coverage
 * exclusion and `inputs.ts`'s own doc comment for the fuller argument.
 */
import * as core from "@actions/core";

import type { RecordOutcome } from "./record.js";
import type { Settings } from "./inputs.js";
import { remainingOf } from "../../core/sweep.js";

import type { Outcome, SweepAccumulator } from "./main.js";
import { summarize, summarizeRecord, summarizeSweep, type Done, type Run } from "./summary.js";

/** What a run that touched nothing did. Also what every dry run reports. */
export const NOTHING_DONE: Done = { labels: [], commented: false, assigned: [], closed: false };

export { remainingOf };

interface OutputValues {
  readonly labels: string;
  readonly proposed: string;
  readonly confidence: string;
  readonly language: string;
  readonly "duplicate-of": string;
  readonly "screened-out": string;
  readonly applied: string;
  readonly starved: string;
  readonly processed: string;
  readonly skipped: string;
  readonly remaining: string;
  readonly recorded: string;
}

/**
 * The twelve keys `report` and `reportRecordRun` both answer in full, named
 * once here rather than in each — so the two can no longer drift onto
 * different keys as one gains a key the other does not.
 */
function writeOutputs(values: OutputValues): void {
  core.setOutput("labels", values.labels);
  core.setOutput("proposed", values.proposed);
  core.setOutput("confidence", values.confidence);
  core.setOutput("language", values.language);
  core.setOutput("duplicate-of", values["duplicate-of"]);
  core.setOutput("screened-out", values["screened-out"]);
  core.setOutput("applied", values.applied);
  core.setOutput("starved", values.starved);
  core.setOutput("processed", values.processed);
  core.setOutput("skipped", values.skipped);
  core.setOutput("remaining", values.remaining);
  core.setOutput("recorded", values.recorded);
}

/**
 * Every output, written on every path that reaches an answer — including the
 * ones that answer "nothing". A workflow branching on `screened-out` needs it to
 * be an empty string rather than an unset output on the run where everything
 * worked.
 */
export function report(
  outcome: Outcome,
  done: Done,
  dryRun: boolean,
  rosterStarved: boolean,
): void {
  writeOutputs({
    labels: JSON.stringify(outcome.applied),
    proposed: JSON.stringify(outcome.verdict.labels),
    confidence: outcome.verdict.confidence.toFixed(2),
    language: outcome.language ?? "",
    "duplicate-of": outcome.verdict.duplicateOf === null ? "" : String(outcome.verdict.duplicateOf),
    "screened-out": outcome.screenedOut?.reason ?? "",
    // Empty under a rehearsal, which is how a workflow tells one from a run: `{}`
    // is a shape no real run produces, because a real run always reports all four
    // keys whether or not it did anything with them.
    applied: dryRun ? "{}" : JSON.stringify(done),
    starved: String(rosterStarved),
    // `0`, not unset: `processed`/`skipped`/`remaining` are a sweep's own
    // outputs, and a single-thread run answers all three honestly at zero rather
    // than leaving a workflow that reads them on every run reading an empty
    // string on this one.
    processed: "0",
    skipped: "0",
    remaining: "0",
    // `false` here always: this is the ordinary decide/act pipeline, which
    // never writes to the corrections store. `recorded` only ever reads `true`
    // from the dedicated record path below.
    recorded: "false",
  });
}

/**
 * `processed`, `skipped` and `remaining` — a sweep's own outputs, distinct
 * from every output above because none of those name one thread. `starved` is
 * shared vocabulary between the two modes, so it keeps the same name here.
 */
export function reportSweep(bulk: SweepAccumulator, rosterStarved: boolean): void {
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("skipped", String(bulk.skipped));
  core.setOutput("remaining", String(remainingOf(bulk)));
  core.setOutput("starved", String(rosterStarved));
  // `true` only for bulk migration — `record` composed with `sweep`, decided
  // once for the whole run and carried on the accumulator. An ordinary
  // triaging sweep never records, the same as it always did.
  core.setOutput("recorded", String(bulk.recording));
}

/**
 * Every output, on a `record` run — the full contract every path answers, so
 * a workflow that reads `labels` or `confidence` on every run of this action
 * finds the neutral values a run that never triaged actually produced, rather
 * than an output some other path simply never set.
 */
export function reportRecordRun(outcome: RecordOutcome, rosterStarved: boolean): void {
  writeOutputs({
    labels: JSON.stringify([]),
    proposed: JSON.stringify([]),
    confidence: "0.00",
    language: outcome.language ?? "",
    "duplicate-of": "",
    "screened-out": "",
    applied: JSON.stringify(NOTHING_DONE),
    starved: String(rosterStarved),
    processed: "0",
    skipped: "0",
    remaining: "0",
    recorded: String(outcome.recorded),
  });
}

export function page(
  settings: Settings,
  thread: number,
  outcome: Outcome,
  done: Done,
  spent: Run["spent"],
): string {
  return summarize({
    thread,
    dryRun: settings.dryRun,
    warrant: settings.warrant,
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
    implicit: outcome.implicit,
    excludedLabels: outcome.excludedLabels,
    ungranted: outcome.ungranted,
    spent,
    modelNames: settings.modelNames,
    screenNames: settings.screenNames,
  });
}

export function recordPage(
  settings: Settings,
  thread: number,
  outcome: RecordOutcome,
  spent: Run["spent"],
): string {
  return summarizeRecord({
    thread,
    dryRun: settings.dryRun,
    recorded: outcome.recorded,
    language: outcome.language,
    decided: outcome.decided,
    pivot: outcome.pivot,
    pivotNote: outcome.pivotNote,
    correctionsDir: settings.correctionsDir,
    spent,
    modelNames: settings.modelNames,
    screenNames: settings.screenNames,
  });
}

export function sweepPage(settings: Settings, bulk: SweepAccumulator, spent: Run["spent"]): string {
  return summarizeSweep({
    dryRun: settings.dryRun,
    warrant: settings.warrant,
    results: bulk.results,
    skipped: bulk.skipped,
    remaining: remainingOf(bulk),
    starvedRun: bulk.starvedRun,
    ungranted: bulk.ungranted,
    recording: bulk.recording,
    spent,
    modelNames: settings.modelNames,
    screenNames: settings.screenNames,
  });
}
