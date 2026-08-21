/**
 * What this duty's run did, as one page — the same three questions every other
 * duty's page answers: what was decided, what was not and why, and what it
 * cost.
 */
import type { Spend } from "../../core/meter.js";
import { shown, type Names } from "../../core/provider.js";
import { cell, cost, table } from "../../core/summary.js";
import type { Capability } from "../../core/warrant.js";

import type { Disposition, Finding, Status } from "./findings.js";
import type { Posted } from "./publish.js";
import { describeRisk, type RiskAssessment } from "./risk.js";
import type { ThreadSync } from "./threads.js";

export interface Run {
  readonly number: number;
  readonly dryRun: boolean;
  /** The pull request's head SHA, for the page and for the envelope. */
  readonly headSha: string;
  readonly note: string | null;
  /** Why the stored memory was unreadable, when a corrupt envelope was recovered from — never silent. */
  readonly memoryNote: string | null;
  /** The head SHA the previous run reviewed, when the envelope carried one. */
  readonly previousSha: string;
  /** Files the model was shown, for the summary's coverage table. */
  readonly shown: readonly { path: string }[];
  /** Files skipped, with their reason. */
  readonly skipped: readonly { path: string; reason: string }[];
  readonly findings: readonly {
    finding: Finding;
    status: Status;
    disposition: Disposition | null;
  }[];
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
  /** The risk assessment, when the run reached one — `null` on early stops. */
  readonly risk: RiskAssessment | null;
  /** One row per model pass that ran, for the verdict table's "Passes" row. */
  readonly passes: readonly {
    readonly id: string;
    readonly name: string;
    readonly answered: boolean;
    readonly unreadable: boolean;
    readonly failed: boolean;
    readonly findings: number;
  }[];
  /** How many workspace reads the context engine made this run. */
  readonly contextReadFiles: number;
  /** What this run's inline-thread sync did, when one ran — for the "Threads" row. */
  readonly threads: ThreadSync | null;
  /** The test-aware pass's summary line, when the rules file enabled it. */
  readonly readTests: string | null;
  /** The agentic aggregate for the Tool calls row - null outside agentic mode. */
  readonly toolCalls: string | null;
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
    ...(run.risk !== null && run.risk.signals.length > 0 ? ["", riskSection(run)] : []),
    ...(run.memoryNote !== null ? ["", `> ⚠️ ${run.memoryNote}`, ""] : []),
    ...(run.findings.length > 0 ? ["", findingsTable(run)] : []),
    ...(run.skipped.length > 0 ? ["", coverage(run)] : []),
    ...(run.contextReadFiles > 0
      ? [
          "",
          `**Context:** ${String(run.contextReadFiles)} workspace file(s) read for surrounding source, tests, config and callers.`,
        ]
      : []),
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
    ["Risk", run.risk === null ? "not assessed" : `${run.risk.tier} — ${describeRisk(run.risk)}`],
    ["Findings", String(run.findings.length)],
    ["Confidence", run.confidence === null ? "not measured" : run.confidence.toFixed(2)],
    ["Posted", run.posted ?? "nothing to post"],
  ];
  if (run.permitted.length > 0) {
    rows.push(["Granted", run.permitted.join(", ")]);
  }
  if (run.malformedAnswers > 0) {
    rows.push(["Unreadable", `${String(run.malformedAnswers)} answer(s) discarded`]);
  }
  if (run.passes.length > 0) {
    rows.push([
      "Passes",
      run.passes
        .map((pass) =>
          pass.answered
            ? `${pass.name} (${String(pass.findings)} finding${pass.findings === 1 ? "" : "s"})`
            : `${pass.name} (did not answer)`,
        )
        .join(", "),
    ]);
  }
  if (run.readRules !== null) {
    rows.push(["Rules", cell(run.readRules)]);
  }
  if (run.readTests !== null) {
    rows.push(["Tests", cell(run.readTests)]);
  }
  if (run.toolCalls !== null) {
    rows.push(["Tool calls", cell(run.toolCalls)]);
  }
  if (run.previousSha.length > 0 && run.previousSha !== run.headSha) {
    rows.push(["Previously", `reviewed at \`${run.previousSha}\``]);
  }
  if (run.findings.length > 0) {
    const verified = run.findings.filter(
      ({ finding }) => finding.verification === "verified",
    ).length;
    const unverified = run.findings.filter(
      ({ finding }) => finding.verification === "unverified",
    ).length;
    rows.push([
      "Verification",
      `${String(verified)} verified · ${String(unverified)} not verified`,
    ]);
  }
  if (run.threads !== null) {
    rows.push(["Threads", threadsCell(run.threads)]);
  }

  return ["### Verdict", "", table(["Field", "Value"], rows)].join("\n");
}

/** The "Threads" verdict row: what the inline sync did, when one ran. */
function threadsCell(threads: ThreadSync): string {
  const parts = [
    threads.created > 0 ? `${String(threads.created)} inline` : "",
    threads.updated > 0 ? `${String(threads.updated)} updated` : "",
    threads.fallback.length > 0 ? `${String(threads.fallback.length)} to summary` : "",
  ].filter((part) => part.length > 0);
  const text = parts.length > 0 ? parts.join(", ") : "none";
  return threads.uncertain ? `${text} — listing uncertain` : text;
}

function riskSection(run: Run): string {
  const risk = run.risk;
  if (risk === null) return "";
  const passes = risk.tier === "high" ? 3 : risk.tier === "medium" ? 2 : 1;
  const rows = risk.signals.map((signal) => [
    signal.signal.replace(/_/g, "-"),
    String(signal.weight),
    signal.evidence.join(", "),
  ]);
  return [
    `### Risk: ${risk.tier}`,
    "",
    table(["Signal", "Weight", "Evidence"], rows),
    "",
    `Score ${String(risk.score)} — medium ≥ ${String(risk.thresholds.medium)}, high ≥ ${String(risk.thresholds.high)} — ${String(passes)} review pass${passes === 1 ? "" : "es"}.`,
  ].join("\n");
}

function findingsTable(run: Run): string {
  const rows = run.findings.map(({ finding, status, disposition }) => [
    status,
    `\`${finding.path}\`` + (finding.line === null ? "" : `:${String(finding.line)}`),
    finding.severity,
    cell(finding.body),
    finding.verification ?? "—",
    disposition === null ? "—" : `${disposition.value} by @${disposition.by}`,
  ]);
  return [
    "### Findings",
    "",
    table(["State", "Location", "Severity", "Finding", "Verified", "Disposition"], rows),
  ].join("\n");
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
