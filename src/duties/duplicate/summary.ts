/**
 * What one duplicate check decided, as one page.
 *
 * Unlike triage, there is never more than one thing to decide here: a run
 * proposes at most one candidate, or none. So this report has no table of
 * label-by-label refusals — the whole verdict fits in the paragraph a reader
 * sees first, and what is left to explain is *why*: the corpus BM25 ranked,
 * whether the pivot bridge ran, and whether the confidence floor or the
 * warrant is what kept a proposal off the thread.
 *
 * The cost table is the core's, for the same reason it is in every other
 * duty's report: a bill is not this duty's business, only the two purposes
 * that spent against it are — `duplicate` for the judge, `pivot` for the
 * cross-language bridge, when either ran.
 */
import type { Spend } from "../../core/meter.js";
import { shown, type Names } from "../../core/provider.js";
import { cell, cost, table } from "../../core/summary.js";
import type { Capability } from "../../core/warrant.js";
import type { Posted } from "./publish.js";

/** What the run actually did, or would have done under a rehearsal. */
export interface Done {
  readonly commented: boolean;
}

/** What BM25 and the corpus listing produced, before the judge ever ran. */
export interface RankInfo {
  /** How many open threads the corpus listing carried, after `corpus-limit`/`corpus-since`. */
  readonly corpusSize: number;
  /** How many of those reached the judge, after `candidates` truncated the ranking. */
  readonly offered: number;
}

/** Whether the pivot bridge ran, and what to tell a reader about it. */
export interface PivotInfo {
  readonly used: boolean;
  /** Why it did or did not run, or null when the thread's own language already covered the corpus. */
  readonly note: string | null;
}

export interface Run {
  readonly thread: number;
  readonly dryRun: boolean;
  /** Where the authority was read from, so a withheld capability can name the file. */
  readonly warrant: string;
  /** The detected author language, or null for `unknown`. */
  readonly language: string | null;
  /**
   * Why this duty was granted nothing, when a written `capabilities:` block
   * simply does not name it — distinct from every other reason nothing was
   * proposed, because here the judge was never asked.
   */
  readonly ungranted: string | null;
  /** The candidate the verdict named, before the confidence floor is checked. Null for no proposal. */
  readonly duplicateOf: number | null;
  readonly confidence: number;
  readonly floor: number;
  /** The BM25 score that put the proposed candidate in front of the judge. 0 when there is no proposal. */
  readonly lexicalScore: number;
  readonly rank: RankInfo;
  readonly pivot: PivotInfo;
  /**
   * Why there is no verdict, when there is none. Every model failing and an
   * answer nobody could read are different configurations with the same
   * outcome, and a page reporting neither would look like a judge that saw
   * no candidates worth naming.
   */
  readonly note: string | null;
  /** What both the file and the workflow allow, and what only the workflow asked for. */
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  readonly done: Done;
  /** What the write step did, or null when no write was attempted at all. */
  readonly posted: Posted | null;
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
}

export function summarize(run: Run): string {
  const parts = [
    "## Reeve · duplicate",
    "",
    `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was applied" : ""}.`,
    "",
    verdict(run),
    "",
    cost(run.spent, (spend) => shown(run.modelNames, spend.model)),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

/** The headline: what happened to this thread, in the fewest lines that are true. */
function verdict(run: Run): string {
  const lines = ["### Verdict", ""];

  if (run.ungranted !== null) {
    lines.push(
      run.ungranted,
      "",
      "No expensive model was asked anything. This is a real answer rather than a failure.",
    );
    return lines.join("\n");
  }

  if (run.note !== null) {
    lines.push(`No verdict — ${run.note}.`, "");
  }

  lines.push(
    run.duplicateOf === null
      ? "No duplicate was proposed."
      : `Proposed as a duplicate of #${String(run.duplicateOf)}.`,
  );

  const language = run.language ?? "not one of the configured languages";
  lines.push(
    "",
    `Confidence ${run.confidence.toFixed(2)} against a floor of ${run.floor.toFixed(2)}. ` +
      `Author language: ${language}. ` +
      `${String(run.rank.offered)} of ${String(run.rank.corpusSize)} open ` +
      `thread${run.rank.corpusSize === 1 ? "" : "s"} reached the judge.`,
  );

  if (run.pivot.note !== null) {
    lines.push("", run.pivot.note);
  }

  if (run.duplicateOf !== null) {
    if (run.confidence < run.floor) {
      lines.push(
        "",
        "The verdict was under the floor, so it is reported and not applied. " +
          "`duplicate-of` and `score` still carry it.",
      );
    } else {
      lines.push("", disposition(run));
    }
  }

  const gap = withheld(run);
  if (gap.length > 0) lines.push("", gap);

  return lines.join("\n");
}

/** What became of a proposal that cleared the confidence floor. */
function disposition(run: Run): string {
  if (run.posted === null) {
    return "Nothing was posted — `apply` does not name `comment`. `duplicate-of` and `score` still carry it.";
  }

  const verb =
    run.posted === "posted"
      ? run.dryRun
        ? "Would have posted"
        : "Posted"
      : run.posted === "replaced"
        ? run.dryRun
          ? "Would have replaced its own previous comment with"
          : "Replaced its own previous comment with"
        : "Left its own previous comment unchanged — this run reached the same fingerprint as";

  return `${verb} a comment naming #${String(run.duplicateOf ?? 0)}.`;
}

/**
 * The capabilities the workflow asked for and the file does not grant.
 *
 * Not an error — the file is the authority — but a maintainer who wrote
 * `apply: comment` and got no comment would otherwise read a working action
 * as a broken one.
 */
function withheld(run: Run): string {
  if (run.withheld.length === 0) return "";

  return (
    `\`apply\` asks for ${run.withheld.map((capability) => `\`${capability}\``).join(", ")}, ` +
    `which \`${run.warrant}\` does not grant to this duty. The narrower of the two wins, always.`
  );
}

/**
 * One thread a sweep processed, and what came of it.
 *
 * A sweep's page has no room for the per-thread detail `summarize` above
 * writes, so what is kept is a single sentence per thread — enough to spot
 * the one that needs the full report and to follow with `number` into
 * single-thread mode for it.
 */
export interface SweptThread {
  readonly number: number;
  readonly outcome: string;
}

export interface SweepRun {
  readonly dryRun: boolean;
  readonly warrant: string;
  readonly results: readonly SweptThread[];
  /** Candidates this run did not reach: the limit, or the roster running dry. */
  readonly remaining: number;
  /** Every model starved on capacity before `limit` was reached. */
  readonly starvedRun: boolean;
  readonly ungranted: string | null;
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
}

/**
 * A sweep's own page: a table instead of one verdict, because there is no
 * single thread this report is about.
 *
 * There is no `skipped` row the way triage's sweep has one — triage skips a
 * thread that already carries a taxonomy label, a cheap fact read off the
 * thread itself. `duplicate` has no equivalent cheap pre-filter: whether a
 * thread is a duplicate is exactly the question every thread in the walk is
 * asked, so every thread the walk reaches is processed, not skipped.
 */
export function summarizeSweep(run: SweepRun): string {
  if (run.ungranted !== null) {
    return `${["## Reeve · duplicate — sweep", "", run.ungranted, "", cost(run.spent, () => "")].join("\n").trimEnd()}\n`;
  }

  const rows = run.results.map((result) => [`#${String(result.number)}`, cell(result.outcome)]);
  const rendered = table(["Thread", "Outcome"], rows);

  const parts = [
    "## Reeve · duplicate — sweep",
    "",
    `${run.dryRun ? "**Dry run** — nothing was applied. " : ""}Processed ${String(run.results.length)}, ` +
      `${String(run.remaining)} remaining.`,
    "",
    rendered.length === 0 ? "Nothing was processed this run." : rendered,
  ];

  if (run.starvedRun) {
    parts.push(
      "",
      "The roster ran out of capacity partway through — every model in `models` failed on " +
        "capacity this run. What is above was delivered; the rest is `remaining`, and the next " +
        "sweep picks up where this one stopped. Weather, not a failure.",
    );
  }

  parts.push(
    "",
    cost(run.spent, (spend) => shown(run.modelNames, spend.model)),
  );

  return `${parts.join("\n").trimEnd()}\n`;
}
