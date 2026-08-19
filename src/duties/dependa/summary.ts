/**
 * Run summary for the `dependa` duty.
 *
 * Follows the same pattern as every other duty's summary module.
 */
import { cell, table } from "../../core/summary.js";
import type { GroupResult, Refusal } from "./model.js";
import type { Weather } from "../../core/provider.js";
import { starved } from "../../core/provider.js";

export interface RunSummary {
  readonly groups: readonly GroupSummary[];
  readonly starved: boolean;
  readonly budgetExhausted: boolean;
}

export interface GroupSummary {
  readonly groupId: string;
  readonly ecosystem: string | null;
  readonly security: boolean;
  readonly proposalCount: number;
  readonly pr: number | null;
  readonly outcome: string;
  readonly refused: readonly Refusal[];
}

export function summarize(
  groupResults: readonly GroupResult[],
  weather: Weather,
  models: readonly string[],
  budgetExhausted: boolean,
): RunSummary {
  return {
    groups: groupResults.map(groupSummary),
    starved: starved(models, weather),
    budgetExhausted,
  };
}

function groupSummary(result: GroupResult): GroupSummary {
  return {
    groupId: result.group.id,
    ecosystem: result.group.ecosystem,
    security: result.group.security,
    proposalCount: result.group.proposals.length,
    pr: result.pr,
    outcome: result.outcome,
    refused: result.refused,
  };
}

/**
 * Render the run summary as a Markdown table for the job summary.
 */
export function renderSummary(summary: RunSummary): string {
  const rows = summary.groups.map((g) => [
    cell(`${g.groupId}${g.security ? " 🛡️" : ""}`),
    cell(g.ecosystem ?? "mixed"),
    cell(String(g.proposalCount)),
    cell(g.outcome),
    cell(g.pr !== null ? `[#${String(g.pr)}](#${String(g.pr)})` : "—"),
  ]);

  const headers = ["Group", "Ecosystem", "Updates", "Outcome", "PR"] as const;
  // core table() returns "" for an empty page; the empty run still names its
  // columns, so keep exactly what the hand-built render printed for that case.
  const rendered =
    rows.length === 0
      ? "| Group | Ecosystem | Updates | Outcome | PR |\n|---|---|---|---|---|"
      : table(headers, rows);

  let body = `## Reeve · dependa\n\n${rendered}`;

  if (summary.starved) {
    body += "\n\n⚠️ All models failed on capacity this run. No proposals were made.";
  }

  if (summary.budgetExhausted) {
    body += "\n\n⚠️ Request budget exhausted before all groups were processed.";
  }

  const totalRefused = summary.groups.reduce((sum, g) => sum + g.refused.length, 0);
  if (totalRefused > 0) {
    body += `\n\n${String(totalRefused)} proposal(s) refused by enforcement.`;
  }

  return body;
}
