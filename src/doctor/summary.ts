/**
 * `doctor: true`'s own page — the primary surface for a report that never
 * touches a thread.
 *
 * Shaped after `triage/summary.ts`: the question a maintainer opens this page
 * with is "would my configuration work", and the answer is a short headline,
 * every finding that would refuse a duty at runtime, and the table each
 * duty's own capability check reads at runtime. The cost table every other
 * duty's page carries has no place here — this never asks a model anything.
 */
import { cell, table } from "../core/summary.js";

import type { AuthorityRow, Finding, Report, Severity } from "./diagnose.js";

export function summarize(report: Report): string {
  const parts = [
    "## Reeve · doctor",
    "",
    headline(report),
    "",
    findingsSection(
      report.findings,
      "red",
      "### Problems",
      "None — nothing here would refuse a duty at runtime.",
    ),
    "",
    findingsSection(report.findings, "green", "### Notes", "Nothing else to report."),
    "",
    authoritySection(report),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

function headline(report: Report): string {
  const scope = report.duty === null ? "every duty" : `\`${report.duty}\``;
  return `\`${report.owner}/${report.repo}\`, against \`${report.warrantPath}\`, scoped to ${scope}.`;
}

/**
 * One severity's findings, as a list — rendered even when there is nothing
 * to list, the same "prove the check ran" convention `cost()` uses for a
 * run that asked no model anything: a page that skipped an empty section
 * reads like a check that never ran, not like a check that passed.
 */
function findingsSection(
  findings: readonly Finding[],
  severity: Severity,
  heading: string,
  whenEmpty: string,
): string {
  const matched = findings.filter((finding) => finding.severity === severity);
  return [
    heading,
    "",
    matched.length === 0 ? whenEmpty : matched.map((finding) => `- ${finding.text}`).join("\n"),
  ].join("\n");
}

/** Every scoped duty's effective grant, read from the same place a real run reads it. */
function authoritySection(report: Report): string {
  const rows = report.authority.map((row) => [`\`${row.duty}\``, capabilities(row), note(row)]);

  return ["### Effective authority", "", table(["Duty", "Capabilities", "Note"], rows)].join("\n");
}

function capabilities(row: AuthorityRow): string {
  return row.granted.length === 0
    ? "*(none)*"
    : row.granted.map((capability) => `\`${cell(capability)}\``).join(", ");
}

function note(row: AuthorityRow): string {
  const parts: string[] = [];
  if (row.denied) parts.push("denied — the `capabilities:` block does not name it");
  else if (row.isDefault) parts.push("this duty's own default");
  if (row.unused.length > 0) {
    const list = row.unused.map((capability) => `\`${capability}\``).join(", ");
    parts.push(`granted ${list} in warrant, this duty has no use for it`);
  }
  return parts.length > 0 ? parts.join("; ") : "—";
}
