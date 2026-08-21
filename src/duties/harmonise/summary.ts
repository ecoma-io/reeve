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
  /** Synced locales whose file did not exist before — bootstrap translations. */
  readonly created: readonly string[];
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

/**
 * Renders the classification column with a per-hunk breakdown when there are
 * multiple hunks or mixed classifications.
 *
 * A single-semantic-hunk group still shows `semantic` (no parenthetical).
 * A group with 3 semantic + 1 correction shows `semantic (3), correction (1)`.
 * A group with no hunks shows the group-level classification as-is.
 */
function hunkBreakdown(
  hunks: readonly ClassifiedHunk[],
  fallback: GroupResult["classification"],
): string {
  if (hunks.length === 0) return fallback;

  const counts = new Map<string, number>();
  for (const hunk of hunks) {
    counts.set(hunk.classification, (counts.get(hunk.classification) ?? 0) + 1);
  }

  // Single classification, single hunk — no breakdown needed
  if (counts.size === 1 && hunks.length === 1) {
    const only = hunks[0];
    return only !== undefined ? only.classification : fallback;
  }

  // Multiple classifications or multiple hunks — show breakdown
  const parts = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, count]) => (count > 1 ? `${cls} (${String(count)})` : cls));
  return parts.join(", ");
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
          hunkBreakdown(r.hunks, r.classification),
          r.synced.length > 0
            ? r.synced.map((l) => (r.created.includes(l) ? `${l} (new)` : l)).join(", ")
            : "—",
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
