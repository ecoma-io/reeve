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
