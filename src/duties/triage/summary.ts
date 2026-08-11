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
  /** How large the store was and how much of it reached the prompt. */
  readonly memory: { readonly size: number; readonly recalled: number };
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
      `Memory: ${String(run.memory.recalled)} of ${String(run.memory.size)} correction${run.memory.size === 1 ? "" : "s"} reached the prompt.`,
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
