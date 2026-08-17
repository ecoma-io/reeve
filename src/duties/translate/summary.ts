/**
 * What this duty's run did, as one page.
 *
 * The shape of the answer is the same three questions every time: what was
 * translated, what was not and why, and what it cost. A run that translated
 * nothing has to answer all three too — "nothing happened" and "nothing was
 * asked" look identical from the outside and are very different configurations.
 *
 * The rendering lives here rather than in the core because the columns are this
 * duty's: a language, a draft's score, a panel's votes. What the core owns is
 * the page it is written to and the arithmetic on the bill.
 */
import { chromeFallbackNote } from "../../core/chrome.js";
import type { Spend } from "../../core/meter.js";
import type { Language } from "../../core/languages.js";
import { shown, type Names } from "../../core/provider.js";
import { cell, cost, table } from "../../core/summary.js";

import type { Posted } from "./publish.js";

/** One text the run looked at, whatever came of it. */
export interface Looked {
  /** How the log names it — `#42`, or `#42 comment 991`. */
  readonly what: string;
  readonly from: Language | null;
  readonly posted: readonly Posted[];
  readonly skipped: readonly Language[];
  /**
   * The subset of `skipped` left for `max-requests` rather than for no model
   * producing a draft — always a subset, never a separate count: whatever
   * else reads `skipped` (the published footer, the fingerprint) has no use
   * for the distinction and keeps seeing the combined set unchanged. Only
   * this table does, because "no model could do it" and "this run never
   * tried" call for different next steps from whoever reads it.
   */
  readonly budgetSkipped: readonly Language[];
  /**
   * Why nothing was translated, when nothing was. An empty body, a body with no
   * prose in it, a fingerprint that already matched: each is a decision worth
   * reporting, and each is invisible in a table of translations because it
   * produced none.
   */
  readonly note: string | null;
}

export interface Run {
  readonly thread: number;
  readonly dryRun: boolean;
  readonly looked: readonly Looked[];
  readonly spent: readonly Spend[];
  /** What to call a drafting model, and what to call a judge seat. */
  readonly modelNames: Names;
  readonly judgeNames: Names;
  /** Where the warrant was read from, named in the two notes below. */
  readonly warrant: string;
  /** True when no warrant file existed and this ran on its own defaults. */
  readonly implicit: boolean;
  /**
   * Why nothing was translated, when a written `duties:` block simply
   * does not name this duty. `null` on every ordinary run, including one that
   * translated nothing for a reason of its own.
   */
  readonly ungranted: string | null;
}

/**
 * The one sentence an implicit warrant earns here.
 *
 * Deliberately not triage's "narrowest authority... labels only" sentence —
 * that is about a taxonomy built from label descriptions, and translate has
 * no taxonomy to narrow. What is true for translate is smaller: there was no
 * file, so nothing changed from what `edit-body` and the duty's documented
 * `languages` default already gave it. With no input left to override either,
 * the file's silence is the whole answer, and so is this sentence.
 */
function authority(run: Run): string {
  return (
    `No \`${run.warrant}\` — this duty found no warrant file, and ran on its own ` +
    "defaults (`edit-body`, and whatever languages were configured)."
  );
}

export function summarize(run: Run): string {
  if (run.ungranted !== null) {
    const parts = [
      `## Reeve · translate`,
      "",
      `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was written" : ""}.`,
      "",
      run.ungranted,
      "",
      "No model was asked anything. This is a real answer rather than a failure.",
      "",
      // The same three-part report every other run writes — `cost` renders an
      // empty spend as the explicit "every decision was made by code" line,
      // which is this page's whole story, and the sweep's ungranted page
      // already says it this way.
      cost(run.spent, (spend) =>
        shown(spend.purpose === "judge" ? run.judgeNames : run.modelNames, spend.model),
      ),
    ];
    return `${parts.join("\n").trimEnd()}\n`;
  }

  const parts = [
    `## Reeve · translate`,
    "",
    `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was written" : ""}.`,
    "",
    ...(run.implicit ? [authority(run), ""] : []),
    translations(run.looked),
    ...chromeNote(run.looked),
    "",
    cost(run.spent, (spend) =>
      shown(spend.purpose === "judge" ? run.judgeNames : run.modelNames, spend.model),
    ),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * The one sentence a fallback earns, when {@link chromeFallbackNote} finds
 * one — see its own doc comment. Every language this run actually posted
 * chrome for, across every text it looked at, is the input: the boundary and
 * footer render once per posted language, so that is the whole set chrome
 * was keyed by this run.
 */
function chromeNote(looked: readonly Looked[]): readonly string[] {
  const codes = looked.flatMap((text) => text.posted.map((entry) => entry.to.code));
  const note = chromeFallbackNote(codes);
  return note === null ? [] : ["", note];
}

/** Every language of every text, in the order the run reached them. */
function translations(looked: readonly Looked[]): string {
  const rows: string[][] = [];

  for (const text of looked) {
    for (const entry of text.posted) {
      const decision = entry.decision;
      rows.push([
        cell(text.what),
        cell(`${entry.to.label} (${entry.to.code})`),
        "translated",
        cell(entry.model),
        decision === undefined ? "—" : decision.score.toFixed(2),
        decision === undefined ? "1" : String(decision.drafts),
        decision === undefined || decision.votes.length === 0
          ? "—"
          : cell(decision.votes.map((vote) => `${vote.model}→${vote.pick}`).join(", ")),
      ]);
    }
    const budgetSkipped = new Set(text.budgetSkipped.map((language) => language.code));
    for (const language of text.skipped) {
      // A skipped language is the row worth reading twice: it is the one the
      // next run will try again, and the one a configuration change is for —
      // except that "no model could do it" and "this run never tried" call
      // for different changes, so the two are not the same row.
      rows.push([
        cell(text.what),
        cell(`${language.label} (${language.code})`),
        budgetSkipped.has(language.code) ? "**budget**" : "**no draft**",
        "—",
        "—",
        "—",
        "—",
      ]);
    }
    if (text.note !== null) {
      rows.push([cell(text.what), "—", cell(text.note), "—", "—", "—", "—"]);
    }
  }

  const rendered = table(["Text", "Language", "Result", "Model", "Score", "Drafts", "Votes"], rows);
  if (rendered.length === 0) return "### Translations\n\nNothing was translated this run.";

  const languages = looked.flatMap((text) => text.posted.map((entry) => entry.to.code));
  const detected = looked
    .map((text) => (text.from === null ? null : `${text.what}: ${text.from.label}`))
    .filter((line): line is string => line !== null);

  return [
    "### Translations",
    "",
    rendered,
    "",
    `${String(languages.length)} translation${languages.length === 1 ? "" : "s"} this run.` +
      (detected.length === 0
        ? " No source language was one of the configured ones."
        : ` Source language — ${detected.join("; ")}.`),
  ].join("\n");
}

/**
 * One thread a sweep processed, and what came of it.
 *
 * A sweep's page has no room for `translations`' per-language detail — that
 * table is already the size a maintainer will read for one thread, and a
 * sweep touches many. What is kept is a single sentence per thread, enough to
 * spot the one that needs the full report and follow with `number` into
 * single-thread mode for it.
 */
export interface SweptThread {
  readonly number: number;
  readonly outcome: string;
}

export interface SweepRun {
  readonly dryRun: boolean;
  readonly results: readonly SweptThread[];
  /** Threads already carrying this duty's marker — the idempotent skip. */
  readonly skipped: number;
  /** Candidates this run did not reach: the limit, or the roster running dry. */
  readonly remaining: number;
  /** Every model starved on capacity before `limit` was reached. */
  readonly starvedRun: boolean;
  /** This run's own `max-requests` ceiling was reached before `limit` was. */
  readonly budgetExhausted: boolean;
  readonly spent: readonly Spend[];
  readonly modelNames: Names;
  readonly judgeNames: Names;
  /** Where the warrant was read from — named only in the `ungranted` message below. */
  readonly warrant: string;
  /**
   * Why the sweep never looked at the backlog at all, when a written
   * `duties:` block does not name this duty. Checked once, before the
   * listing — see `runSweep`.
   */
  readonly ungranted: string | null;
}

/**
 * A sweep's own page: a table instead of a per-language breakdown, because
 * there is no single thread this report is about.
 *
 * `starvedRun` is reported as weather, in the same words `docs/guides/sweep.md`
 * uses, because it is not a failure of this run — it is next week's sweep
 * being told where to resume.
 */
export function summarizeSweep(run: SweepRun): string {
  if (run.ungranted !== null) {
    const parts = [
      "## Reeve · translate — sweep",
      "",
      run.ungranted,
      "",
      cost(run.spent, () => ""),
    ];
    return `${parts.join("\n").trimEnd()}\n`;
  }

  const rows = run.results.map((result) => [`#${String(result.number)}`, cell(result.outcome)]);
  const rendered = table(["Thread", "Outcome"], rows);

  const parts = [
    "## Reeve · translate — sweep",
    "",
    `${run.dryRun ? "**Dry run** — nothing was published. " : ""}Processed ${String(run.results.length)}, ` +
      `skipped ${String(run.skipped)} (already translated), ${String(run.remaining)} remaining.`,
    "",
    rendered.length === 0 ? "Nothing was processed this run." : rendered,
  ];

  if (run.starvedRun) {
    parts.push(
      "",
      "The roster ran out of capacity partway through — every model in `models` failed on " +
        "capacity this run. What is above was processed; the rest is `remaining`, and the next " +
        "sweep picks up where this one stopped. Weather, not a failure.",
    );
  }

  if (run.budgetExhausted) {
    parts.push(
      "",
      "`max-requests` was reached partway through — this run's own ceiling, not the provider's. " +
        "What is above was processed; the rest is `remaining`, and the next sweep picks up where " +
        "this one stopped.",
    );
  }

  parts.push(
    "",
    cost(run.spent, (spend) =>
      shown(spend.purpose === "judge" ? run.judgeNames : run.modelNames, spend.model),
    ),
  );

  return `${parts.join("\n").trimEnd()}\n`;
}
