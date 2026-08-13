/**
 * Summary page rendering for the `harmonise` duty.
 *
 * Shows what was classified, what was synced, what conflicted, and what
 * was skipped — plus cost and model information.
 */
import { cost, table } from "../../core/summary.js";
import { type Spend } from "../../core/meter.js";
import { shown, type Names } from "../../core/provider.js";
import type { ClassifiedHunk } from "./classify.js";
import type { DocumentGroup } from "./discover.js";

/** One document group's run outcome. */
export interface GroupResult {
  readonly group: DocumentGroup;
  /** What the source diff was classified as. */
  readonly classification: "semantic" | "correction" | "locale-specific" | "none";
  /** Semantic hunks that will be / were propagated. */
  readonly hunks: readonly ClassifiedHunk[];
  /** Locales that were synced (draft produced). */
  readonly synced: readonly string[];
  /** Locales that had conflicts. */
  readonly conflicts: readonly string[];
  /** Locales that were skipped (no propagation needed). */
  readonly skipped: readonly string[];
}

/** What a run page needs to render. */
export interface Run {
  readonly dryRun: boolean;
  readonly results: readonly GroupResult[];
  readonly warrant: string;
  readonly implicit: boolean;
  readonly ungranted: string | null;
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
}

export function summarize(run: Run): string {
  const lines: string[] = [];

  lines.push("## Reeve · harmonise");

  if (run.dryRun) lines.push("\n> **Dry run** — nothing was committed or merged.");
  if (run.ungranted !== null) lines.push(`\n> **Not granted:** ${run.ungranted}`);

  if (run.results.length === 0) {
    lines.push("\n_No document groups need synchronisation._");
  } else {
    const rows = run.results.map(
      (r) =>
        [
          r.group.id,
          r.classification,
          r.synced.length > 0 ? r.synced.join(", ") : "—",
          r.conflicts.length > 0 ? r.conflicts.join(", ") : "—",
          r.skipped.length > 0 ? r.skipped.join(", ") : "—",
        ] as const,
    );

    lines.push("");
    lines.push(table(["Group", "Classification", "Synced", "Conflicts", "Skipped"], rows));
  }

  lines.push(cost(run.spent, (spend) => shown(run.modelNames, spend.model)));

  return lines.join("\n");
}
