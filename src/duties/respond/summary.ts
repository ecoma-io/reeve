/**
 * What this duty's run did, as one page.
 *
 * The shape is the same three questions every other duty's page answers: what
 * was decided, what was not and why, and what it cost. A run that wrote
 * nothing has to answer all three too — "nobody had anything to say" and
 * "this run was never allowed to speak" look identical from the outside and
 * are very different configurations, which is why `ungranted` gets its own
 * branch here exactly as it does in `triage/summary.ts` and
 * `translate/summary.ts`.
 */
import type { Spend } from "../../core/meter.js";
import { shown, type Names } from "../../core/provider.js";
import { cell, cost, table } from "../../core/summary.js";
import type { Capability } from "../../core/warrant.js";

import type { Decision, Responded } from "./publish.js";

export interface Run {
  readonly thread: number;
  readonly dryRun: boolean;
  /**
   * Why this run stopped before drafting: the issue's opener is a bot, a
   * human already replied first, this thread already carries this duty's own
   * marker, or the cheap screen dropped it as spam or off-topic. `null` on
   * every run that reached a verdict, including one that produced no usable
   * draft.
   */
  readonly note: string | null;
  readonly language: string | null;
  /**
   * The winning draft, or `null` when this run never reached one — either it
   * stopped early (`note` is set) or every model was rotated past without
   * producing an admitted attempt.
   */
  readonly responded: Responded | null;
  /** The winning draft's own confidence, or `null` alongside `responded: null`. */
  readonly confidence: number | null;
  readonly floor: number;
  /**
   * True when a comment was posted this run. There is no update-in-place —
   * respond answers a thread once, so every `true` here is a brand-new
   * comment, never an edit of one already there.
   */
  readonly published: boolean;
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
  readonly judgeNames: Names;
  readonly warrant: string;
  /** True when no warrant file existed and this ran on its own defaults — nothing. */
  readonly implicit: boolean;
  /**
   * Why this duty was granted nothing, when a written `capabilities:` block
   * simply does not name it. `null` on every ordinary run.
   */
  readonly ungranted: string | null;
}

/**
 * The one sentence an implicit warrant earns here.
 *
 * Unlike triage's or translate's version of this sentence, there is no
 * default capability to point at — `respond` is the top rung, and the whole
 * design is that nothing short of an explicit `capabilities:` entry ever lets
 * it post. So the honest sentence is not "ran on its defaults", it is "ran
 * with nothing granted", and that is true whether the warrant is missing
 * entirely or present but silent about `respond`.
 */
function authority(run: Run): string {
  return (
    `No \`${run.warrant}\` — this duty found no warrant file. A first reply is the top ` +
    "rung of what Reeve may do, and it is granted nothing until a warrant explicitly " +
    "names it: add `capabilities: { respond: [comment] }` to grant it."
  );
}

export function summarize(run: Run): string {
  if (run.ungranted !== null) {
    const parts = [
      "## Reeve · respond",
      "",
      `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was written" : ""}.`,
      "",
      run.ungranted,
      "",
      "No model was asked anything. This is a real answer rather than a failure.",
      "",
      cost(run.spent, (spend) =>
        shown(spend.purpose === "judge" ? run.judgeNames : run.modelNames, spend.model),
      ),
    ];
    return `${parts.join("\n").trimEnd()}\n`;
  }

  const parts = [
    "## Reeve · respond",
    "",
    `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was written" : ""}.`,
    "",
    ...(run.implicit ? [authority(run), ""] : []),
    verdict(run),
    ...withheld(run),
    "",
    cost(run.spent, (spend) =>
      shown(spend.purpose === "judge" ? run.judgeNames : run.modelNames, spend.model),
    ),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

function verdict(run: Run): string {
  if (run.note !== null) return ["### Verdict", "", run.note].join("\n");

  const { responded, confidence } = run;
  if (responded === null || confidence === null) {
    return [
      "### Verdict",
      "",
      "No draft survived this run — every model was rotated past, or no admitted " +
        "answer parsed. Nothing was posted.",
    ].join("\n");
  }

  const rows = [
    ["Language", run.language === null ? "not identified" : cell(run.language)],
    ["Confidence", `${confidence.toFixed(2)} of 1.00 (floor ${run.floor.toFixed(2)})`],
    ...decisionRows(responded.decision),
    ["Outcome", cell(outcome(run))],
  ];

  return ["### Verdict", "", table(["Field", "Value"], rows)].join("\n");
}

function decisionRows(decision: Decision | null): string[][] {
  if (decision === null) return [];
  const rows = [
    ["Drafts", String(decision.drafts)],
    ["Decided by", decision.decidedBy],
  ];
  if (decision.votes.length > 0) {
    rows.push([
      "Votes",
      cell(decision.votes.map((vote) => `${vote.model}→${vote.pick}`).join(", ")),
    ]);
  }
  return rows;
}

/** The one sentence explaining why the draft was, or was not, posted. */
function outcome(run: Run): string {
  const { responded, confidence } = run;
  if (responded === null || confidence === null) return "nothing to post";
  if (confidence < run.floor) {
    return (
      `below the floor (${confidence.toFixed(2)} < ${run.floor.toFixed(2)}) — the draft was ` +
      "written to `respond-text` but nothing was posted"
    );
  }
  if (!run.permitted.includes("comment")) {
    return "`comment` was not granted — the draft was written to `respond-text` but nothing was posted";
  }
  if (run.dryRun) return "dry run — nothing was written";
  // Every guard above this line is a reason not to post, and each one already
  // returned. Reaching here means none of them applied, and `main.ts` never
  // reaches this point without posting — there is no update-in-place, so
  // there is no other outcome left for `published` to be.
  return "posted";
}

function withheld(run: Run): string[] {
  if (run.withheld.length === 0) return [];
  return [
    "",
    ...run.withheld.map(
      (capability) =>
        `\`apply\` asks for \`${capability}\`, which \`${run.warrant}\` does not grant to this ` +
        "duty. The narrower of the two wins, always.",
    ),
  ];
}
