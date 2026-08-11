/**
 * What this duty's run decided, as one page.
 *
 * The question a maintainer opens this page with is never "what did it apply" —
 * that is visible on the thread. It is "why is that different from what I
 * expected", and every answer to that is a thing the run refused: a label the
 * warrant does not name, a verdict under the floor, a capability the workflow
 * asked for and the file does not grant. So the refusals are the body of this
 * report and the applied labels are one line at the top of it.
 *
 * The cost table is the core's, because a bill is not a duty's business. What is
 * here is only what is about triage.
 */
import type { Refusal } from "../../core/enforce.js";
import type { Spend } from "../../core/meter.js";
import { shown, type Names } from "../../core/provider.js";
import { cell, cost, table } from "../../core/summary.js";
import type { Capability } from "../../core/warrant.js";

/** What the run actually did, or would have done under a rehearsal. */
export interface Done {
  readonly labels: readonly string[];
  readonly commented: boolean;
  readonly assigned: readonly string[];
  readonly closed: boolean;
}

export interface Run {
  readonly thread: number;
  readonly dryRun: boolean;
  /** Where the authority was read from, so every refusal can name the file. */
  readonly warrant: string;
  /** The detected author language, or null for `unknown`. */
  readonly language: string | null;
  /** Why the cheap pass stopped the run, or null when it went through in full. */
  readonly screenedOut: { readonly reason: string; readonly note: string } | null;
  /** Every label the verdict named, including the ones that were refused. */
  readonly proposed: readonly string[];
  readonly confidence: number;
  readonly floor: number;
  readonly applied: readonly string[];
  readonly refused: readonly Refusal[];
  readonly duplicateOf: number | null;
  /** What both the file and the workflow allow, and what only the workflow asked for. */
  readonly permitted: readonly Capability[];
  readonly withheld: readonly Capability[];
  readonly done: Done;
  /**
   * How large the store was, how much of it reached the prompt, and how many
   * of those arrived through the pivot bridge rather than the thread's own
   * language.
   */
  readonly memory: {
    readonly size: number;
    readonly recalled: number;
    readonly pivotRecalled: number;
  };
  /**
   * Why there is no verdict, when there is none. Every model failing and an
   * answer nobody could read are different configurations with the same
   * outcome, and a page that reported neither would look like a model that
   * agreed with nothing.
   */
  readonly note: string | null;
  /** True when there was no warrant file, and this ran at the narrowest authority instead. */
  readonly implicit: boolean;
  /** Repository labels the implicit warrant left out for carrying no description. */
  readonly excludedLabels: readonly string[];
  /**
   * Why this duty was granted nothing, when a written `capabilities:` block
   * simply does not name it — distinct from every other reason nothing was
   * applied, because here nothing was even attempted.
   */
  readonly ungranted: string | null;
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
  readonly screenNames: Names;
}

export function summarize(run: Run): string {
  const parts = [
    "## Reeve · triage",
    "",
    `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was applied" : ""}.`,
    "",
    ...(run.implicit ? [authority(run), ""] : []),
    verdict(run),
    "",
    decisions(run),
    "",
    cost(run.spent, (spend) =>
      shown(spend.purpose === "screen" ? run.screenNames : run.modelNames, spend.model),
    ),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

/** What a `record` run decided, for its own page. */
export interface RecordRun {
  readonly thread: number;
  readonly dryRun: boolean;
  readonly recorded: boolean;
  /** The detected author language, or null for `unknown`. */
  readonly language: string | null;
  /** The taxonomy-filtered labels standing on the thread at the moment it was recorded. */
  readonly decided: readonly string[];
  /** Whether a pivot-language rendering was produced and stored alongside the correction. */
  readonly pivot: boolean;
  /** Why a pivot rendering was not produced, when one was attempted and was not. */
  readonly pivotNote: string | null;
  readonly corrections: string;
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
  readonly screenNames: Names;
}

/**
 * A `record` run's own page, deliberately short: this pipeline never asks for
 * a verdict, so there is no confidence, no proposal and no guardrail table to
 * report — only what was written to the store, and whether a pivot rendering
 * came with it.
 */
export function summarizeRecord(run: RecordRun): string {
  const parts = [
    "## Reeve · triage — record",
    "",
    `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was committed" : ""}.`,
    "",
    run.recorded
      ? `Recorded to \`${run.corrections}\` as ` +
        (run.decided.length > 0
          ? run.decided.map((name) => `\`${name}\``).join(", ")
          : "no labels") +
        `${run.language !== null ? `, in ${run.language}` : ", in an unidentified language"}.`
      : "Nothing was recorded.",
  ];

  if (run.pivot) {
    parts.push("", "A pivot-language rendering was translated and stored alongside it.");
  } else if (run.pivotNote !== null) {
    parts.push("", run.pivotNote);
  }

  parts.push(
    "",
    cost(run.spent, (spend) =>
      shown(spend.purpose === "screen" ? run.screenNames : run.modelNames, spend.model),
    ),
  );

  return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * Said once, at the top, when this run had nothing written to read.
 *
 * The difference between a warrant a maintainer wrote and the narrowest one
 * this build assumed in its place is the first thing a reader needs — before
 * a single label, because it changes how every line after it should be read.
 */
function authority(run: Run): string {
  const lines = [
    `No \`${run.warrant}\` — ran at the narrowest authority: labels only, from this ` +
      "repository's own label descriptions.",
  ];

  if (run.excludedLabels.length > 0) {
    lines.push(
      "",
      `${run.excludedLabels.map((name) => `\`${name}\``).join(", ")} — these labels have no ` +
        "description on GitHub, so they were not offered to the model — add a description " +
        `there, or write a taxonomy in \`${run.warrant}\`.`,
    );
  }

  return lines.join("\n");
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

  if (run.screenedOut !== null) {
    lines.push(
      `Screened out as \`${run.screenedOut.reason}\` — ${run.screenedOut.note}.`,
      "",
      "No expensive model was asked anything. This is a real answer rather than a failure.",
    );
    return lines.join("\n");
  }

  if (run.note !== null) {
    lines.push(`No verdict — ${run.note}.`, "");
  }

  const language = run.language ?? "not one of the configured languages";
  lines.push(
    run.applied.length === 0
      ? "No label was applied."
      : `Applied ${run.applied.map((name) => `\`${name}\``).join(", ")}.`,
    "",
    `Confidence ${run.confidence.toFixed(2)} against a floor of ${run.floor.toFixed(2)}. ` +
      `Author language: ${language}. ` +
      `Memory: ${String(run.memory.recalled)} of ${String(run.memory.size)} correction${run.memory.size === 1 ? "" : "s"} reached the prompt` +
      (run.memory.pivotRecalled > 0
        ? `, ${String(run.memory.pivotRecalled)} of ${run.memory.pivotRecalled === 1 ? "it" : "them"} found across languages.`
        : "."),
  );

  if (run.confidence < run.floor && run.proposed.length > 0) {
    lines.push(
      "",
      "The verdict was under the floor, so it is reported and not applied. `proposed` has it.",
    );
  }

  if (run.duplicateOf !== null) {
    lines.push(
      "",
      `Reported as a possible duplicate of #${String(run.duplicateOf)}` +
        (run.done.closed
          ? ", and closed."
          : ". Nothing was done about it — `apply` does not name `close`."),
    );
  }

  return lines.join("\n");
}

/**
 * Every label the verdict named and what became of it.
 *
 * The one table in this report, and the reason it exists: the difference
 * between `proposed` and `labels` is the guardrails, and this is the only place
 * a reader can see which guardrail it was.
 */
function decisions(run: Run): string {
  if (run.screenedOut !== null || run.ungranted !== null) return withheld(run);

  const refusals = new Map(run.refused.map((refusal) => [refusal.what, refusal.why]));
  const rows = run.proposed.map((name) => {
    const why = refusals.get(name);
    return [
      // In code formatting, because a label name is a string GitHub matches
      // exactly — including its case and its spaces, which are invisible in
      // prose and are the difference between a name that exists and one that
      // does not.
      `\`${cell(name)}\``,
      why === undefined
        ? run.applied.includes(name)
          ? "applied"
          : "**not applied**"
        : "**refused**",
      why === undefined
        ? run.applied.includes(name)
          ? "—"
          : cell(`below the confidence floor of ${run.floor.toFixed(2)}`)
        : cell(why),
    ];
  });

  const rendered = table(["Label", "Result", "Why"], rows);
  const parts = [
    "### What the verdict proposed",
    "",
    rendered.length === 0 ? "The verdict proposed no labels, which is a real answer." : rendered,
  ];

  const actions = [
    ...(run.done.commented ? ["a comment"] : []),
    ...(run.done.assigned.length > 0 ? [`assigned ${run.done.assigned.join(", ")}`] : []),
    ...(run.done.closed ? ["closed"] : []),
  ];
  if (actions.length > 0) {
    parts.push("", `Also${run.dryRun ? " would have" : ""}: ${actions.join(", ")}.`);
  }

  const gap = withheld(run);
  if (gap.length > 0) parts.push("", gap);

  return parts.join("\n");
}

/**
 * The capabilities the workflow asked for and the file does not grant.
 *
 * Not an error — the file is the authority — but a maintainer who wrote
 * `apply: label, comment` and got no comment would otherwise read a working
 * action as a broken one.
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
 * writes — that report is already the size a maintainer will read for one
 * thread, and a sweep touches many. What is kept is a single sentence per
 * thread, which is enough to spot the one that needs the full report and to
 * follow with `number` into single-thread mode for it.
 */
export interface SweptThread {
  readonly number: number;
  readonly outcome: string;
}

export interface SweepRun {
  readonly dryRun: boolean;
  readonly warrant: string;
  readonly results: readonly SweptThread[];
  /** Threads already carrying a taxonomy label — the idempotent skip. */
  readonly skipped: number;
  /** Candidates this run did not reach: the limit, or the roster running dry. */
  readonly remaining: number;
  /** Every model starved on capacity before `limit` was reached. */
  readonly starvedRun: boolean;
  readonly ungranted: string | null;
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
  readonly screenNames: Names;
}

/**
 * A sweep's own page: a table instead of one verdict, because there is no
 * single thread this report is about.
 *
 * `starvedRun` is reported as weather, in the same words `docs/usage/sweep.md`
 * uses, because it is not a failure of this run — it is next week's sweep
 * being told where to resume.
 */
export function summarizeSweep(run: SweepRun): string {
  if (run.ungranted !== null) {
    // Cost is still shown, empty, for the same reason `summarize` above shows
    // it on every path: it is what tells a reader "nothing was asked" from a
    // report that forgot to say.
    return `${["## Reeve · triage — sweep", "", run.ungranted, "", cost(run.spent, () => "")].join("\n").trimEnd()}\n`;
  }

  const rows = run.results.map((result) => [`#${String(result.number)}`, cell(result.outcome)]);
  const rendered = table(["Thread", "Outcome"], rows);

  const parts = [
    "## Reeve · triage — sweep",
    "",
    `${run.dryRun ? "**Dry run** — nothing was applied. " : ""}Processed ${String(run.results.length)}, ` +
      `skipped ${String(run.skipped)} (already labelled), ${String(run.remaining)} remaining.`,
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
    cost(run.spent, (spend) =>
      shown(spend.purpose === "screen" ? run.screenNames : run.modelNames, spend.model),
    ),
  );

  return `${parts.join("\n").trimEnd()}\n`;
}
