/**
 * What a translation run has to say, rendered into the block the core appends.
 *
 * The publishing itself is the core's — reading the thread, splitting at the
 * marker, keeping the author's half byte-for-byte, recognising a run that
 * changed nothing. This module decides only what goes *in* the block, which is
 * the part no other duty could reuse: a boundary line about translation, one
 * collapsible section per language, and a footer naming what this run did not
 * manage.
 *
 * **Appended, never rewritten.** The author's text stays where they put it and
 * the translation goes underneath it, behind the marker. That is what keeps
 * everything GitHub reads out of a body intact — `Fixes #42`, a task list's
 * checkboxes, a `Co-authored-by` trailer, a template's headings — none of which
 * survive a body that gets reformatted or re-emitted from a model's idea of it.
 *
 * The body rather than a comment, because a comment is somewhere else. A reader
 * who cannot read the body scrolls past the diff, the labels and the first three
 * replies to reach the translation, and every later reply pushes it further
 * away. In the body it is where the text it translates is, for every reader,
 * permanently.
 *
 * **A reply is the same thing at a different address.** A comment has an author
 * answerable for their words, a body GitHub reads references out of, and a
 * reader who needs the translation next to the text — so it gets the identical
 * treatment. Only the port differs, and choosing the port is the core's job.
 *
 * **A run that translated nothing writes nothing.** Not an apology, and
 * emphatically not an overwrite: a provider that was out of quota this morning
 * must not cost the thread the good translation it already has. The core
 * enforces that by refusing to publish an empty section list, so it is enough
 * for this module to render no sections.
 */
import { chromeLines } from "../../core/chrome.js";
import type { Language } from "../../core/languages.js";
import { fingerprint, markerFor, type Marker } from "../../core/marker.js";
import type { Publication } from "../../core/publish.js";

/** This duty's marker: `<!-- reeve:translate source=… -->`. */
export const marker: Marker = markerFor("translate");

/**
 * How much of the machinery behind a translation the block names.
 *
 * The reason this is a setting rather than a constant is that the two audiences
 * want opposite things from the same block. A contributor reading a thread in
 * their own language wants the translation and nothing else; the model id is
 * noise in a body they are trying to read, and it is noise that shows up in
 * every notification email the thread sends. A maintainer deciding whether a
 * provider is worth keeping wants to know which model wrote the bad sentence,
 * and wants it in the thread rather than in a workflow log that expires.
 *
 * `none` is the default because a body is read far more often than it is
 * debugged, and because the log already carries all of this for the run that
 * wrote it — the setting decides what is worth making permanent and public, not
 * what gets recorded.
 */
export type Attribution =
  /** Just the language. */
  | "none"
  /** The language and the model that wrote the winning draft. */
  | "model"
  /** Everything above, plus how that draft won: its score, and who voted. */
  | "detail";

/** One language's winning translation, ready to publish. */
export interface Posted {
  readonly to: Language;
  /** The winning draft, already sanitised. */
  readonly text: string;
  /**
   * What to call the model that wrote it, so a bad translation can be traced
   * back. Already the display name the workflow gave it, or the id when it gave
   * it none — this is a rendering, and nothing here looks a model up again.
   */
  readonly model: string;
  /**
   * How the winner was chosen, for `detail`. Absent when the caller had nothing
   * to say — a single draft with no judges is not a contest, and rendering
   * "decided by score" for it would dress a foregone conclusion up as a verdict.
   */
  readonly decision?: Decision;
}

/** What a run can say about why this draft beat the others. */
export interface Decision {
  /** The deterministic score of the winning draft, 0 to 1. */
  readonly score: number;
  /** How many drafts were produced and admitted for this language. */
  readonly drafts: number;
  /** Which ranking settled it. */
  readonly decidedBy: "score" | "judges";
  /** Every judge that voted, and what it picked — both already display names. */
  readonly votes: readonly { readonly model: string; readonly pick: string }[];
}

/** Everything this duty has to say about one thread. */
export interface Translated {
  /** The language the thread was written in, or null when detection reached no answer. */
  readonly from: Language | null;
  /** One entry per language that produced a postable translation, in configured order. */
  readonly posted: readonly Posted[];
  /**
   * Languages this run could not translate into. Named, never explained: the
   * reason is a provider failure that belongs in the workflow log, and a public
   * thread is the wrong place to print somebody's quota.
   */
  readonly skipped: readonly Language[];
  /** True when the source was cut to the configured limit before translating. */
  readonly truncated: boolean;
  /** Identifies the text and the target languages this block answers. */
  readonly fingerprint: string;
  /**
   * How much of the machinery to name in the block.
   *
   * Deliberately not part of the fingerprint: turning it on is a decision about
   * how the next thread reads, not a mandate to re-spend a translation budget on
   * every old one. A thread already carrying a translation keeps the attribution
   * it was published with until its text or its languages change — and the
   * identical-bytes check in the core's `publish` is what stops a run from
   * rewriting a hundred threads for a cosmetic difference.
   */
  readonly attribution: Attribution;
}

/**
 * What identifies a translation as answering a particular text in particular
 * languages.
 *
 * Over the text that was translated and the language codes, and deliberately
 * over nothing else. The model ids are not in it because rotating past a failed
 * model is not a reason to retranslate a thread nobody edited, and `drafts` is
 * not in it because raising the quality knob is a choice about the next thread,
 * not a mandate to re-spend the budget on every old one.
 *
 * **Called twice per run, with different languages, and the difference is the
 * point.** A run computes what it *wants* — every configured language — before
 * spending anything, and compares it against the marker already in the body. It
 * records what it *got*: the languages that came back, plus the source language
 * it had nothing to translate into. Those two sets are equal exactly when
 * nothing was skipped, so a run that fell short writes a marker the next run
 * cannot match, and the next run tries again.
 *
 * That asymmetry is what keeps the marker from claiming work nobody did. A
 * marker over "what was configured" says a language was translated when a
 * provider was out of quota and it was not, and says the whole body was read
 * when only its first four thousand characters were — and in both cases the run
 * that could fix it skips, permanently, because the marker already matches.
 */
export function translationFingerprint(translated: string, languages: readonly Language[]): string {
  return fingerprint(
    translated,
    languages.map((language) => language.code),
  );
}

/**
 * The run turned into a publication: a fingerprint, and the sections the core
 * appends under the marker.
 *
 * Pure and total, which is what lets the core recognise a run that changed
 * nothing — the same input renders the same bytes.
 *
 * Each translation is a `<details>` block, open when it is the only one. A
 * reader with one target language always wants to read it and should not have
 * to click; a reader with four wants theirs and not a wall. A translation whose
 * source contained unbalanced HTML renders unbalanced here too — the damage is
 * confined to how the block looks, and the source it came from was already
 * broken Markdown.
 */
export function publication(translated: Translated): Publication {
  if (translated.posted.length === 0) return { fingerprint: translated.fingerprint, sections: [] };

  const sections = translated.posted.map((entry) =>
    section(entry, translated.posted.length === 1, translated.attribution),
  );

  return {
    fingerprint: translated.fingerprint,
    sections: [boundary(translated.posted), ...sections, footer(translated)],
  };
}

/** Every language a set of postings actually carries, for the shared-boundary chrome case. */
function codesOf(posted: readonly Posted[]): readonly string[] {
  return posted.map((entry) => entry.to.code);
}

/**
 * The line that says which half of the body is which.
 *
 * A reader arriving at a translated thread has to know, before reading a word of
 * it, whether they are reading a person or a model — and which one the project
 * is answerable for. Stated once at the boundary rather than repeated per
 * section: the rule is about the horizontal rule above it, and a reader who
 * scrolled past it is already inside the machine's half.
 *
 * The note itself is chrome that sits above every posted language's section at
 * once, so it renders once per distinct language actually posted this run —
 * English first — rather than picking one of them to address the others in.
 */
function boundary(posted: readonly Posted[]): string {
  return [
    "---",
    "",
    "> [!NOTE]",
    ...chromeLines("translateBoundary", codesOf(posted)).map((line) => `> ${line}`),
  ].join("\n");
}

function section(entry: Posted, alone: boolean, attribution: Attribution): string {
  return [
    `<details${alone ? " open" : ""}>`,
    `<summary>${summary(entry, attribution)}</summary>`,
    // GitHub only renders Markdown inside a block-level HTML element when a
    // blank line separates them, so these are load-bearing rather than tidy:
    // without them a fenced code block in the translation posts as one line of
    // backticks.
    "",
    entry.text,
    "",
    ...(attribution === "detail" ? [provenance(entry), ""] : []),
    "</details>",
  ].join("\n");
}

/**
 * The clickable line of a section.
 *
 * The language is always there — it is what a reader is looking for, and it is
 * the only thing that tells two collapsed sections apart.
 */
function summary(entry: Posted, attribution: Attribution): string {
  const language = `<b>${escapeHtml(entry.to.label)}</b>`;
  if (attribution === "none") return language;
  return `${language} · <code>${escapeHtml(entry.model)}</code>`;
}

/**
 * How the winning draft won, inside the section rather than in its summary.
 *
 * Below the translation and in `<sub>`, because a reader who opened a section
 * came for the text: a provenance line above it would be read first by everyone
 * and wanted by almost nobody. A run with nothing to report renders no line at
 * all rather than an empty one.
 */
function provenance(entry: Posted): string {
  const { decision } = entry;
  const parts = [`Translated by \`${entry.model}\`.`];

  if (decision !== undefined) {
    parts.push(
      `Scored ${decision.score.toFixed(2)} of 1.00` +
        (decision.drafts > 1 ? `, best of ${String(decision.drafts)} drafts` : "") +
        `, decided by ${decision.decidedBy}.`,
    );
    if (decision.votes.length > 0) {
      const votes = decision.votes.map((vote) => `\`${vote.model}\`→\`${vote.pick}\``).join(", ");
      parts.push(`Votes: ${votes}.`);
    }
  }

  return `<sub>${escapeHtml(parts.join(" "))}</sub>`;
}

/**
 * What the run did, for a reader who did not run it.
 *
 * This footer sits below every posted language's section at once, the same as
 * `boundary()` above them, so each fixed note in it renders once per distinct
 * language actually posted this run — English first — rather than picking one
 * of the configured languages as the real audience.
 */
function footer(translated: Translated): string {
  const { from, skipped, truncated, posted } = translated;
  const codes = codesOf(posted);

  const notes: string[] = [];
  if (from !== null) {
    notes.push(...chromeLines("translateFooterFrom", codes, { label: from.label }));
  }
  if (truncated) {
    notes.push(...chromeLines("translateFooterTruncated", codes));
  }
  if (skipped.length > 0) {
    notes.push(
      ...chromeLines("translateFooterSkipped", codes, {
        list: skipped.map((language) => language.label).join(", "),
      }),
    );
  }
  notes.push(...chromeLines("translateFooterEditable", codes));

  return `<sub>${escapeHtml(notes.join(" "))}</sub>`;
}

/** A label and a model name arrive from a workflow file and land between tags. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
