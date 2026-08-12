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
import { chromeFallbackNote } from "../../core/chrome.js";
import type { Spend } from "../../core/meter.js";
import { shown, type Names } from "../../core/provider.js";
import { cell, cost, fence, table } from "../../core/summary.js";
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
    ...chromeNote(run),
    "",
    cost(run.spent, (spend) =>
      shown(spend.purpose === "judge" ? run.judgeNames : run.modelNames, spend.model),
    ),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * The one sentence a fallback earns, when {@link chromeFallbackNote} finds
 * one — see its own doc comment. `responded.languageCode` is the only code
 * this duty's chrome is ever keyed by, and only when a draft actually exists
 * to carry it — a run that stopped before drafting called no chrome at all.
 */
function chromeNote(run: Run): readonly string[] {
  if (run.responded === null || run.responded.text.length === 0) return [];
  const note = chromeFallbackNote([run.responded.languageCode]);
  return note === null ? [] : ["", note];
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

  const parts = ["### Verdict", "", table(["Field", "Value"], rows)];

  // Shown here unless the thread itself already carries these exact words —
  // `published` is `true` only at the one place `main.ts` actually posts a
  // comment, never for a dry run, so every other outcome (below the floor,
  // `comment` withheld, a dry run, or anything this summary's own `outcome`
  // ladder does not recognise) leaves the draft unread anywhere else.
  // `respond-text` carries the same text for a workflow to route elsewhere,
  // but a job summary reader cannot see a step output — this page is the
  // only place a human reads it, so it has to carry the draft itself, not
  // just the fact that one was written. Skipped for an empty draft: `text`
  // rendered nothing, and `outcome` already says so — a bare, empty fence
  // would only look like a rendering mistake. `fence` rather than a literal
  // ``` — a draft that itself quotes a fenced block would otherwise close
  // this one early.
  if (!run.published && responded.text.length > 0) parts.push("", ...fence(responded.text));

  return parts.join("\n");
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

/**
 * The one sentence explaining why the draft was, or was not, posted.
 *
 * `run.published` is the fact — set by `main.ts` at the one place a comment
 * is actually created, and nowhere else. The ladder below never decides
 * whether something was posted; it only picks which of `main.ts`'s guards
 * explains a `false` it has already been handed, in the same order `decide`
 * checks them.
 */
function outcome(run: Run): string {
  const { responded, confidence, published } = run;
  if (responded === null || confidence === null) return "nothing to post";
  if (published) return "posted";
  if (confidence < run.floor) {
    return (
      `below the floor (${confidence.toFixed(2)} < ${run.floor.toFixed(2)}) — the draft was ` +
      "written to `respond-text` but nothing was posted"
    );
  }
  if (!run.permitted.includes("comment")) {
    return "`comment` was not granted — the draft was written to `respond-text` but nothing was posted";
  }
  if (responded.text.length === 0) {
    return "the winning draft rendered nothing to post — refused rather than posted with nothing under the marker";
  }
  if (run.dryRun) return "dry run — nothing was written";
  // `published` came back false and none of the reasons above explain it —
  // a state this ladder does not expect from `decide`. Named honestly rather
  // than defaulting to "posted", which `published` has already ruled out.
  return "not posted, for a reason this summary does not recognise";
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
