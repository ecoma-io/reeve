/**
 * What one lifecycle run decided, as a job-summary page.
 *
 * No cost table here, unlike every duty that ever calls a model — `main.ts`'s
 * own doc comment already says why: this duty spends nothing, ever, so a
 * cost section would only ever render as a row of zeros.
 *
 * The shapes below mirror `main.ts`'s own `Outcome`/`Done`, the way
 * `duplicate/summary.ts`'s `Run` mirrors its `main.ts`, rather than
 * importing them directly — `main.ts` calls `run()` at import, so nothing
 * should ever import it back, tests included.
 */
import { cell, table } from "../../core/summary.js";
import type { Capability, LifecycleTrack } from "../../core/warrant.js";

/** One track's step, due right now — mirrors `clock.ts`'s own `DueStep`. */
export interface DueStepSummary {
  readonly track: LifecycleTrack;
  readonly stepIndex: number;
}

/** Mirrors `main.ts`'s own (unexported) `Outcome`. */
export interface OutcomeSummary {
  readonly language: string | null;
  readonly actions: readonly DueStepSummary[];
  readonly unstale: readonly string[];
  readonly permanentlyExempt: string | null;
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  readonly ungranted: string | null;
}

/** Mirrors `main.ts`'s own (exported) `Done`. */
export interface DoneSummary {
  readonly labeled: readonly string[];
  readonly commented: boolean;
  readonly closed: boolean;
  readonly unstaled: readonly string[];
  readonly dueNotGranted: number;
}

/**
 * One sentence naming everything a thread's evaluation actually did — the
 * common core `renderRow` and `renderThreadPage` both build on, so a sweep's
 * one-line-per-thread table and the single-thread page never disagree about
 * what happened.
 */
function verdict(outcome: OutcomeSummary, done: DoneSummary): string {
  if (outcome.ungranted !== null) return outcome.ungranted;
  if (outcome.permanentlyExempt !== null) {
    return `Permanently exempt — \`${outcome.permanentlyExempt}\` is on the thread.`;
  }

  const parts: string[] = [];
  if (done.labeled.length > 0) {
    parts.push(`labeled ${done.labeled.map((label) => `\`${label}\``).join(", ")}`);
  }
  if (done.commented) parts.push("commented");
  if (done.closed) parts.push("closed as not planned");
  if (done.unstaled.length > 0) {
    parts.push(`un-staled ${done.unstaled.map((label) => `\`${label}\``).join(", ")}`);
  }
  if (done.dueNotGranted > 0) {
    parts.push(
      `${String(done.dueNotGranted)} step${done.dueNotGranted === 1 ? "" : "s"} due but withheld`,
    );
  }

  return parts.length === 0 ? "Nothing due." : `${parts.join("; ")}.`;
}

/** One sweep row's cells: the thread, and the one-sentence verdict above. */
export function renderRow(
  number: number,
  outcome: OutcomeSummary,
  done: DoneSummary,
): readonly string[] {
  return [`#${String(number)}`, cell(verdict(outcome, done))];
}

/**
 * The capabilities the workflow asked for and the file does not grant — the
 * same shape `duplicate/summary.ts`'s own `withheld` reports, repeated here
 * rather than shared because the wording names a different duty.
 */
function withheldLine(warrantPath: string, withheld: readonly Capability[]): string {
  if (withheld.length === 0) return "";
  return (
    `\`apply\` asks for ${withheld.map((capability) => `\`${capability}\``).join(", ")}, ` +
    `which \`${warrantPath}\` does not grant to lifecycle. The narrower of the two wins, always.`
  );
}

export interface SweptThreadSummary {
  readonly number: number;
  readonly outcome: OutcomeSummary;
  readonly done: DoneSummary;
}

/** A sweep's own page: a table instead of one verdict, the same shape `duplicate`'s sweep page uses. */
export function renderSweepPage(
  warrantPath: string,
  dryRun: boolean,
  results: readonly SweptThreadSummary[],
  ungranted: string | null,
  starved = false,
): string {
  if (ungranted !== null) {
    return `${["## Reeve · lifecycle — sweep", "", ungranted].join("\n").trimEnd()}\n`;
  }

  const rows = results.map((result) => renderRow(result.number, result.outcome, result.done));
  const rendered = table(["Thread", "Outcome"], rows);

  const parts = [
    "## Reeve · lifecycle — sweep",
    "",
    `${dryRun ? "**Dry run** — nothing was applied. " : ""}Processed ${String(results.length)} thread${
      results.length === 1 ? "" : "s"
    }.`,
  ];
  if (starved) {
    parts.push(
      "",
      "**Stopped early** — GitHub's own capacity (rate limit, or a slow/unavailable request) " +
        "ran out mid-sweep. Everything above this line was actually done; the rest of the " +
        "backlog is still there for the next run.",
    );
  }
  parts.push("", rendered.length === 0 ? "Nothing was processed this run." : rendered);

  const gaps = new Set<string>();
  for (const result of results) {
    const line = withheldLine(warrantPath, result.outcome.withheld);
    if (line.length > 0) gaps.add(line);
  }
  for (const gap of gaps) parts.push("", gap);

  return `${parts.join("\n").trimEnd()}\n`;
}

/** One thread's own page — the full detail a sweep's single row has no room for. */
export function renderThreadPage(
  warrantPath: string,
  dryRun: boolean,
  number: number,
  outcome: OutcomeSummary,
  done: DoneSummary,
): string {
  const parts = [
    "## Reeve · lifecycle",
    "",
    `Thread #${String(number)}${dryRun ? " — **dry run**, nothing was applied" : ""}.`,
    "",
    "### Verdict",
    "",
    verdict(outcome, done),
  ];

  if (outcome.ungranted === null) {
    const language = outcome.language ?? "not one of the configured languages";
    parts.push(
      "",
      `Author language: ${language}. ${String(outcome.actions.length)} due step(s) this run.`,
    );

    for (const action of outcome.actions) {
      parts.push(`- \`${action.track.name}\`, step ${String(action.stepIndex + 1)}.`);
    }

    const gap = withheldLine(warrantPath, outcome.withheld);
    if (gap.length > 0) parts.push("", gap);
  }

  return `${parts.join("\n").trimEnd()}\n`;
}
