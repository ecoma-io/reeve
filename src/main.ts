/**
 * The root action's entry point.
 *
 * Its ordinary job is an explain, then a refusal: `uses: ecoma-io/reeve@v0.1`
 * is not how Reeve is used, so this writes the step-summary page that says
 * which leaf action runs which duty, publishes the corrected `leaf-action`
 * output when `duty` named one, and fails red — a run that cannot do a job
 * must say so rather than exit green having done nothing. The message it
 * fails with is built in `refusal.ts`, which is where the reasoning lives.
 *
 * `doctor: true` is the one exception, and a narrow one: it still runs no
 * duty, but it can read one's configuration and say whether it would work —
 * see `doctor/run.ts` for what that means. `doctor: false`, the default,
 * leaves this the refusal it has always been, now with the explain page in
 * front of it.
 *
 * Every duty gets its own entry point beside this one as it lands —
 * `src/duties/<name>/main.ts`, bundled to `<name>/dist/index.js`. This file is
 * not their runner and never becomes one.
 */
import * as core from "@actions/core";

import { runDoctor } from "./doctor/run.js";
import { leafActionFor, refusal } from "./refusal.js";

export async function run(): Promise<void> {
  // Guarded, not a bare `if`: a `doctor:` value outside the accepted
  // spellings throws from inside `@actions/core` itself, and an uncaught
  // throw here would surface as a raw stack trace rather than the house
  // voice every other configuration mistake in this project fails with —
  // see D5. The thrown message already names the accepted spellings, so
  // relaying it is enough; there is nothing this file could add to it.
  let doctor: boolean;
  try {
    doctor = core.getBooleanInput("doctor");
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
    return;
  }

  if (doctor) {
    await runDoctor();
    return;
  }

  const duty = core.getInput("duty");
  const leaf = leafActionFor(duty);

  // `leaf-action` is set even though the run is about to fail red — it is the
  // one thing a consumer reading the log for the corrected line can also read
  // as an output, and an output is never part of the red/green judgement.
  if (leaf.length > 0) core.setOutput("leaf-action", leaf);

  await writeExplain(leaf);

  core.setFailed(refusal(duty));
}

/**
 * The explain page: where a run of the root action is looked at, the page that
 * says what the root is for and what to write instead. Written before the
 * refusal below it — a red failure is the run's verdict, and the page is the
 * reading surface for the person who just got it. Always written under
 * `doctor: false`, never under `doctor: true`, whose own report owns the page.
 *
 * The table is the canonical route from a duty to the leaf action that runs it.
 * The seven duties and their leaves are written here and in
 * `docs/reference/root-action.md`; the leaf pages (`docs/reference/duties/`)
 * are the single source for what each duty does, and a `description:` drift
 * there never reaches this page the way it reaches the marketplace listing.
 */
async function writeExplain(leaf: string): Promise<void> {
  const parts = [
    "## Reeve · the root action",
    "",
    "This action is the marketplace listing — it is not a duty, and it never " +
      "runs one. A duty runs through the leaf action that owns it:",
    "",
    table(
      ["Duty", "Action to write"],
      [
        ["translate", "`ecoma-io/reeve/translate@<ref>`"],
        ["triage", "`ecoma-io/reeve/triage@<ref>`"],
        ["duplicate", "`ecoma-io/reeve/duplicate@<ref>`"],
        ["respond", "`ecoma-io/reeve/respond@<ref>`"],
        ["lifecycle", "`ecoma-io/reeve/lifecycle@<ref>`"],
        ["harmonise", "`ecoma-io/reeve/harmonise@<ref>`"],
        ["dependa", "`ecoma-io/reeve/dependa@<ref>`"],
      ],
    ),
    "",
  ];

  if (leaf.length > 0) {
    parts.push(
      `You named a duty, and the action that runs it is ${leaf} — write that line ` +
        "in your workflow instead of the root.",
    );
  } else {
    parts.push(
      "Name the duty you meant in the `duty` input and rerun to have this page name " +
        "the exact leaf action to write.",
    );
  }

  parts.push(
    "",
    "What a duty may do is decided by the `duties:` block of your warrant " +
      "(`.github/reeve.yml`), never by this action — it grants nothing and " +
      "carries no authority-widening input.",
    "",
    "Run the leaf action with `dry-run: true` to rehearse it before it acts, and " +
      "check a warrant with this action's own `doctor: true` — the one thing " +
      "this listing does besides refuse.",
  );

  await writeSummary(`${parts.join("\n").trimEnd()}\n`);
}

/**
 * A two-column markdown table. The doctor's report renders its own tables in
 * `src/doctor/summary.ts`; the explain page needs exactly one, so the two
 * lines live here rather than joining the shared summary module.
 */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/**
 * Writes the markdown page to the step summary, when a runner gave this run
 * one. Same contract as the doctor's own writer in `src/core/summary.ts`
 * (`writeSummary`): losing the report is never a reason to lose the run.
 */
async function writeSummary(markdown: string): Promise<void> {
  if ((process.env.GITHUB_STEP_SUMMARY ?? "").length === 0) return;
  try {
    await core.summary.addRaw(markdown).write();
  } catch {
    core.warning("The job summary could not be written — the run itself was unaffected.");
  }
}

await run();
