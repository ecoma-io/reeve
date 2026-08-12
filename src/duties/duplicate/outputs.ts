/**
 * Every output this duty writes, and the two job-summary pages built from the
 * same run state — the transport layer that turns an already-decided
 * `Outcome`/`SweepAccumulator` into what a workflow or a reader actually
 * sees. Nothing here decides anything; `decide`/`runSweep` in `main.ts` own
 * that, and are done by the time any function here runs.
 */
import * as core from "@actions/core";

import type { Outcome, Settings, SweepAccumulator } from "./main.js";
import type { Posted } from "./publish.js";
import { summarize, summarizeSweep, type Done, type Run } from "./summary.js";

/** Candidates the walk did not reach — the limit, or the roster running dry. */
export function remainingOf(acc: SweepAccumulator): number {
  return Math.max(acc.candidates - acc.results.length, 0);
}

/**
 * Every output, written on every single-thread path that reaches an answer —
 * including the ones that answer "nothing". A workflow branching on
 * `duplicate-of` needs it to be an empty string rather than an unset output
 * on the run where nothing was proposed.
 */
export function report(outcome: Outcome, done: Done, rosterStarved: boolean): void {
  core.setOutput("duplicate-of", outcome.duplicateOf === null ? "" : String(outcome.duplicateOf));
  core.setOutput("score", outcome.confidence.toFixed(2));
  core.setOutput("language", outcome.language ?? "");
  core.setOutput("commented", String(done.commented));
  core.setOutput("starved", String(rosterStarved));
  // `0`, not unset — a single-thread run answers a sweep's own outputs
  // honestly at zero rather than leaving a workflow that reads them on every
  // run reading an empty string on this one.
  core.setOutput("processed", "0");
  core.setOutput("remaining", "0");
}

/**
 * `processed` and `remaining` — a sweep's own outputs. `starved` is shared
 * vocabulary between the two modes, so it keeps the same name here. The
 * single-thread outputs are left unset on a sweep run, the same choice
 * `triage/main.ts`'s own `reportSweep` makes: none of them name one thread,
 * and a workflow reading `duplicate-of` off a sweep was never going to find
 * one thread's answer there either way.
 */
export function reportSweep(bulk: SweepAccumulator, rosterStarved: boolean): void {
  core.setOutput("processed", String(bulk.results.length));
  core.setOutput("remaining", String(remainingOf(bulk)));
  core.setOutput("starved", String(rosterStarved));
}

export function page(
  settings: Settings,
  thread: number,
  outcome: Outcome,
  done: Done,
  posted: Posted | null,
  spent: Run["spent"],
): string {
  return summarize({
    thread,
    dryRun: settings.dryRun,
    warrant: settings.warrant,
    language: outcome.language,
    // The code the proposal's own chrome is keyed by, not the label
    // `language` above carries — only present alongside a real `proposal`,
    // which is exactly when this duty's chrome renders anything at all.
    languageCode: outcome.proposal?.language ?? null,
    ungranted: outcome.ungranted,
    duplicateOf: outcome.duplicateOf,
    confidence: outcome.confidence,
    floor: settings.confidence,
    lexicalScore: outcome.lexicalScore,
    rank: outcome.rank,
    pivot: outcome.pivot,
    note: outcome.note,
    permitted: outcome.permitted,
    withheld: outcome.withheld,
    rationale: outcome.rationale,
    done,
    posted,
    spent,
    modelNames: settings.modelNames,
  });
}

export function sweepPage(settings: Settings, bulk: SweepAccumulator, spent: Run["spent"]): string {
  return summarizeSweep({
    dryRun: settings.dryRun,
    warrant: settings.warrant,
    results: bulk.results,
    remaining: remainingOf(bulk),
    starvedRun: bulk.starvedRun,
    ungranted: bulk.ungranted,
    spent,
    modelNames: settings.modelNames,
  });
}
