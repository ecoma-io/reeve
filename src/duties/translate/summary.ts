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
}

export function summarize(run: Run): string {
  const parts = [
    `## Reeve · translate`,
    "",
    `Thread #${String(run.thread)}${run.dryRun ? " — **dry run**, nothing was written" : ""}.`,
    "",
    translations(run.looked),
    "",
    cost(run.spent, (spend) =>
      shown(spend.purpose === "judge" ? run.judgeNames : run.modelNames, spend.model),
    ),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
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
    for (const language of text.skipped) {
      // A skipped language is the row worth reading twice: it is the one the
      // next run will try again, and the one a configuration change is for.
      rows.push([
        cell(text.what),
        cell(`${language.label} (${language.code})`),
        "**no draft**",
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
