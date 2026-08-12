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
import { chromeFallbackNote } from "../../core/chrome.js";
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
  /** The detected author language's display label, or null for `unknown`. */
  readonly language: string | null;
  /**
   * The same language, as the code a proposal's own chrome is keyed by
   * (`Proposal.language` in `publish.ts`) rather than the display label
   * {@link language} carries above. Null whenever there is no `proposal` to
   * carry chrome at all, not only when detection itself found nothing.
   */
  readonly languageCode: string | null;
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
  /**
   * The verdict's own rationale, already sanitised — set whenever a
   * duplicate was named, even one under the floor. Shown only on a
   * report-only branch of `verdict` below: a run that actually posted a
   * comment already carries this sentence on the thread itself, and a job
   * summary repeating it there would be saying the same thing twice.
   */
  readonly rationale: string | null;
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
    ...chromeNote(run),
    "",
    cost(run.spent, (spend) => shown(run.modelNames, spend.model)),
  ];

  return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * The one sentence a fallback earns, when {@link chromeFallbackNote} finds
 * one — see its own doc comment. `run.languageCode` is the only code this
 * duty's chrome is ever keyed by, and it is `null` exactly when there is no
 * `proposal` for chrome to have rendered anything for.
 */
function chromeNote(run: Run): readonly string[] {
  const note = chromeFallbackNote([run.languageCode]);
  return note === null ? [] : ["", note];
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
      lines.push(...why(run));
    } else {
      lines.push("", disposition(run, run.duplicateOf));
      // Shown here unless a real, non-dry write just put the identical
      // sentence on the thread itself — `posted`/`replaced` outside a dry
      // run, the only two dispositions that actually wrote this rationale
      // where a reader can already see it. Every other disposition owes it
      // here instead: `null` (`apply`/the warrant never let this write at
      // all), `withheld` (B1's fail-closed refusal — nothing was written),
      // and `unchanged` (this run reached the same fingerprint as a standing
      // comment, but a fingerprint covers the thread's own text and the
      // shortlist, not the rationale sentence — a rerun can carry a new one
      // the standing comment does not, and the reader still deserves to see
      // what this run itself concluded). A dry run never wrote anything
      // regardless of `posted`, so it always shows.
      const echoedOnThread = !run.dryRun && (run.posted === "posted" || run.posted === "replaced");
      if (!echoedOnThread) lines.push(...why(run));
    }
  }

  const gap = withheld(run);
  if (gap.length > 0) lines.push("", gap);

  return lines.join("\n");
}

/**
 * What became of a proposal that cleared the confidence floor.
 *
 * Only ever called from `verdict` inside its own `run.duplicateOf !== null`
 * branch — `duplicateOf` is passed in already narrowed from there rather than
 * read a second time off `run` inside this function, where TypeScript cannot
 * see that same narrowing across the call.
 */
function disposition(run: Run, duplicateOf: number): string {
  if (run.posted === null) {
    return "Nothing was posted — `apply` does not name `comment`. `duplicate-of` and `score` still carry it.";
  }

  if (run.posted === "withheld") {
    return (
      "Nothing was posted — this thread carries more comments than one run reads, and none of " +
      "the ones read were this duty's own, so whether it already commented could not actually be " +
      `told. Posting on that unknown risked a stacked comment naming #${String(duplicateOf)}, so ` +
      "this run left the thread alone rather than guess."
    );
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

  return `${verb} a comment naming #${String(duplicateOf)}.`;
}

/**
 * The rationale line, when there is one to show — see `Run.rationale`'s own
 * doc comment for when.
 *
 * `sanitize` defangs `@mentions` and `#references` in the rationale, but
 * never touches whitespace — it has no reason to, everywhere else the
 * sanitised text lands is a Markdown document of its own. Here it is spliced
 * after a single leading `> `, which only quotes its first physical line: a
 * rationale carrying a blank line and a `#` a model wrote as a heading rather
 * than an issue reference would open that heading right underneath the quote,
 * live in the job summary, the moment the model's own text contained one.
 * Flattened to one line first, the same one-sentence shape `verdict.ts` asks
 * the model for in the first place, so there is no line break left for a
 * later line to escape the quote on.
 */
function why(run: Run): string[] {
  if (run.rationale === null || run.rationale.length === 0) return [];
  return ["", `> ${run.rationale.replace(/\s+/g, " ").trim()}`];
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
