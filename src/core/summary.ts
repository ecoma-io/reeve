/**
 * The run's own report, written where a run is looked at.
 *
 * GitHub gives every job a summary page beside its log, and it is the right
 * place for everything a maintainer wants to know about a run and nobody
 * reading the thread wants to see. The log has all of this too, in the order it
 * happened and interleaved with everything else; this is the same run arranged
 * for the person deciding whether the configuration is working.
 *
 * It is not the thread. Nothing here is ever published into a body — a
 * contributor came for the translation, and the token count is noise in it.
 *
 * **Writing this can never fail a job.** The report is a record of work that is
 * already done; a runner too old to set the variable, a summary file that has
 * hit its size limit, and a permissions oddity are all reasons to lose the
 * report and none of them are reasons to lose the run.
 */
import * as core from "@actions/core";

import { STAGE, total, type Spend } from "./meter.js";

export async function writeSummary(markdown: string): Promise<void> {
  // Set by every current runner and by nothing else — `act` and a local
  // `node dist/index.js` have no summary to write to, and warning about it on
  // every local run would train a reader to ignore warnings.
  if ((process.env.GITHUB_STEP_SUMMARY ?? "").length === 0) {
    core.debug("No step summary to write to (GITHUB_STEP_SUMMARY is unset).");
    return;
  }

  try {
    await core.summary.addRaw(markdown).write();
  } catch (error) {
    core.warning(
      `The run summary could not be written — ${error instanceof Error ? error.message : String(error)}. ` +
        "The run itself was unaffected.",
    );
  }
}

/**
 * A markdown table, or nothing at all when there are no rows.
 *
 * An empty table renders as a header over a rule, which reads like a bug in the
 * report rather than as the absence it is. The caller decides what to say
 * instead, because "no requests were made" and "no languages were translated"
 * are different sentences.
 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";

  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/**
 * A count as a reader counts, grouped in thousands.
 *
 * `Intl` rather than a hand-rolled regex, and the invariant locale rather than
 * the runner's: a report whose thousands separator depends on which machine
 * picked up the job is a report two people cannot compare.
 */
const COUNT = new Intl.NumberFormat("en-US");

export function count(value: number): string {
  return COUNT.format(value);
}

/**
 * Cell text that cannot break the row it sits in.
 *
 * The backslash goes first and in the same pass, because it is the escape
 * character: a name ending in one would otherwise have it escape the `\` this
 * function just added, and the `|` behind it would end the cell after all.
 */
export function cell(text: string): string {
  return text.replace(/[\\|]/g, "\\$&").replace(/\r?\n/g, " ");
}

/**
 * What the run spent, per stage and model, and what it adds up to.
 *
 * Here rather than in each duty because none of it is a duty's business: the
 * columns are the meter's, the arithmetic is the meter's, and the sentences
 * under the table are about the provider protocol rather than about labels or
 * languages. A second duty rendering its own would be a second chance to leave
 * out the line that says the totals are a floor.
 *
 * `name` is the one thing a duty knows and this does not: which of its rosters
 * a model id came from, so a judge seat called `Careful` reads as `Careful`
 * rather than as the id a maintainer masked out of the log.
 */
export function cost(spent: readonly Spend[], name: (spend: Spend) => string): string {
  const sum = total(spent);
  const rows = spent.map((spend) => [
    STAGE[spend.purpose],
    cell(name(spend)),
    count(spend.requests),
    spend.failed === 0 ? "—" : count(spend.failed),
    count(spend.prompt),
    count(spend.completion),
    count(spend.prompt + spend.completion),
  ]);

  if (rows.length === 0) {
    return [
      "### Cost",
      "",
      "No model was asked anything this run — every decision was made by code.",
    ].join("\n");
  }

  rows.push([
    "**Total**",
    "",
    `**${count(sum.requests)}**`,
    sum.failed === 0 ? "—" : `**${count(sum.failed)}**`,
    `**${count(sum.prompt)}**`,
    `**${count(sum.completion)}**`,
    `**${count(sum.prompt + sum.completion)}**`,
  ]);

  const lines = [
    "### Cost",
    "",
    table(["Stage", "Model", "Requests", "Failed", "Prompt", "Completion", "Tokens"], rows),
  ];

  // Said plainly, because the alternative is a reader treating a floor as a
  // total. Many OpenAI-compatible gateways send no `usage` at all, and a run
  // against one of those reports every request and no tokens — which is the
  // truth, and is only misleading if it goes unlabelled.
  if (sum.unreported > 0) {
    lines.push(
      "",
      `${count(sum.unreported)} of ${count(sum.requests)} request${sum.requests === 1 ? "" : "s"} ` +
        "came back without a `usage` field, so the token counts above are a floor rather than a total.",
    );
  }
  if (sum.failed > 0) {
    lines.push(
      "",
      `${count(sum.failed)} request${sum.failed === 1 ? " was" : "s were"} unusable and rotated past. ` +
        "That is what rotation costs, and it is in the totals because the provider counted it too.",
    );
  }

  return lines.join("\n");
}
