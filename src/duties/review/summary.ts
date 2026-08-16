/**
 * What this duty's run did, as one page — the same three questions every other
 * duty's page answers: what was decided, what was not and why, and what it
 * cost.
 */
import type { Spend } from "../../core/meter.js";
import { shown, type Names } from "../../core/provider.js";
import { cell, cost, table } from "../../core/summary.js";
import type { Capability } from "../../core/warrant.js";

import type { Finding, Status } from "./findings.js";
import type { Posted } from "./publish.js";

export interface Run {
  readonly number: number;
  readonly dryRun: boolean;
  /** The pull request's head SHA, for the page and for the envelope. */
  readonly headSha: string;
  readonly note: string | null;
  /** The head SHA the previous run reviewed, when the envelope carried one. */
  readonly previousSha: string;
  /** Files the model was shown, for the summary's coverage table. */
  readonly shown: readonly { path: string }[];
  /** Files skipped, with their reason. */
  readonly skipped: readonly { path: string; reason: string }[];
  readonly findings: readonly { finding: Finding; status: Status }[];
  readonly confidence: number | null;
  readonly posted: Posted | null;
  readonly permitted: readonly Capability[];
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
  readonly language: string | null;
  readonly warrant: string;
  readonly implicit: boolean;
  readonly ungranted: string | null;
  readonly malformedAnswers: number;
  readonly readRules: string | null;
}

export function summarize(run: Run): string {
  if (run.ungranted !== null) {
    const parts = [
      "## Reeve · review",
      "",
      `Pull request #${String(run.number)}${run.dryRun ? " — **dry run**, nothing was written" : ""}.`,
      "",
      run.ungranted,
      "",
      "No model was asked anything, and no comment was left. This is a real answer rather than a failure.",
      "",
      cost(run.spent, (spend) => shown(run.modelNames, spend.model)),
    ];
    return `${parts.join("\n").trimEnd()}\n`;
  }

  const parts = [
    "## Reeve · review",
    "",
    `Pull request #${String(run.number)} — head ${code(run.headSha)}.`,
    "",
    ...(run.implicit ? [authority(run), ""] : []),
    verdict(run),
    ...(run.findings.length > 0 ? ["", findingsTable(run)] : []),
    ...(run.skipped.length > 0 ? ["", coverage(run)] : []),
    "",
    cost(run.spent, (spend) => shown(run.modelNames, spend.model)),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

function authority(run: Run): string {
  return (
    `No \`${run.warrant}\` — this duty found no warrant file. Review is granted nothing ` +
    "until a warrant explicitly names it: add `duties: { review: [comment] }` to let it leave a comment."
  );
}

function code(text: string): string {
  return `\`${text}\``;
}

function verdict(run: Run): string {
  if (run.note !== null) return ["### Verdict", "", run.note].join("\n");

  const rows = [
    ["Head", run.headSha === "" ? "unknown" : `\`${run.headSha}\``],
    ["Language", run.language === null ? "not identified" : cell(run.language)],
    ["Findings", String(run.findings.length)],
    ["Confidence", run.confidence === null ? "not measured" : run.confidence.toFixed(2)],
    ["Posted", run.posted ?? "nothing to post"],
  ];
  if (run.malformedAnswers > 0) {
    rows.push(["Unreadable", `${String(run.malformedAnswers)} answer(s) discarded`]);
  }
  if (run.readRules !== null) {
    rows.push(["Rules", cell(run.readRules)]);
  }
  if (run.previousSha.length > 0 && run.previousSha !== run.headSha) {
    rows.push(["Previously", `reviewed at \`${run.previousSha}\``]);
  }

  return ["### Verdict", "", table(["Field", "Value"], rows)].join("\n");
}

function findingsTable(run: Run): string {
  const rows = run.findings.map(({ finding, status }) => [
    status,
    `\`${finding.path}\`` + (finding.line === null ? "" : `:${String(finding.line)}`),
    finding.severity,
    cell(finding.body),
  ]);
  return ["### Findings", "", table(["State", "Location", "Severity", "Finding"], rows)].join("\n");
}

function coverage(run: Run): string {
  const rows = run.skipped.map(({ path, reason }) => [cell(path), cell(reason)]);
  const seen = new Set<string>();
  const shownRows = run.shown
    .map(({ path }) => ({ path, reason: "reviewed" }))
    .filter((entry) => {
      if (seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    })
    .map(({ path, reason }) => [cell(path), cell(reason)]);
  return [
    "### Coverage",
    "",
    "Files considered:",
    "",
    table(["File", "Why"], [...shownRows, ...rows]),
  ].join("\n");
}
