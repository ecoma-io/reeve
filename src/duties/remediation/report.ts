/**
 * What one run reports: the outputs and the job-summary page.
 *
 * The proposal records are this duty's auditable deliverable. They are
 * published where GitHub already collects runs — `GITHUB_OUTPUT` and the job
 * summary — and nowhere else, because the proposal-only boundary is exactly
 * "nothing written to the repository". The summary carries a `Proposals`
 * table, one row per record, plus a boundary footer that says what was not
 * written and why.
 */
import * as core from "@actions/core";

import { cell, table } from "../../core/summary.js";
import type { RemediationProposal } from "./proposal.js";

/** Every output, written on every path that reaches an answer — including "nothing". */
export function report(proposals: readonly RemediationProposal[], note: string): void {
  core.setOutput("proposed", String(proposals.length > 0));
  core.setOutput("proposals", String(proposals.length));
  core.setOutput("note", note);
}

/** The summary page: the Proposals table and the boundary footer. */
export function page(
  proposals: readonly RemediationProposal[],
  note: string,
  dryRun = false,
): string {
  const lines = ["## Remediation", ""];
  if (proposals.length === 0) {
    lines.push(
      `No remediation proposals were derived this run.${note.length === 0 ? "" : ` ${note}`}`,
    );
    return lines.join("\n");
  }
  lines.push(
    table(
      ["Fingerprint", "Finding", "Rule", "Where", "Standing", "Severity", "Remediation"],
      proposals.map((proposal) => [
        cell(proposal.fingerprint),
        cell(proposal.findingId),
        cell(proposal.ruleId),
        cell(proposal.line === null ? proposal.path : `${proposal.path}:${String(proposal.line)}`),
        cell(proposal.standing),
        cell(proposal.severity),
        cell(proposal.remediation),
      ]),
    ),
    "",
    ...footer(dryRun),
  );
  return lines.join("\n");
}

/** The boundary footer: nothing was written, and a fixing PR needs a future grant. */
function footer(dryRun: boolean): string[] {
  const lines = [
    dryRun
      ? "**Dry run** — these proposals were derived and reported, and nothing was written to the repository."
      : "This run derived these proposals deterministically from the review envelope — no model was asked, and nothing was written to the repository.",
    "Opening a fixing pull request is a later, separate capability; granting `edit-file` or `open-pr` to this duty fails red rather than acting.",
  ];
  return lines;
}
