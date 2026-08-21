/**
 * What a translation run has to say, rendered into the block the core appends.
 *
 * The publishing itself is the core's — reading the thread, splitting at the
 * marker, keeping the author's half byte-for-byte, recognising a run that
 * changed nothing. This module decides only what goes *in* the block, which is
 * the part no other duty could reuse: a horizontal rule marking where the
 * machine's half begins, one small line naming what put the block there, then
 * one collapsible section per language — each carrying its own boundary note,
 * the translation, and a footer naming what this run did not manage, all in
 * that section's language.
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
import { chrome } from "../../core/chrome.js";
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
  /**
   * Whether this block carries the line naming what wrote it.
   *
   * True for a thread's body and false for every reply, decided by the caller
   * rather than here — see `translateText`'s own parameter for why that is the
   * seam. A body is the one place a reader lands once; a reply is somewhere
   * they scroll past twenty of, and twenty copies of the same logo is not
   * attribution, it is decoration nobody asked for.
   *
   * Deliberately not part of the fingerprint, for the same reason `attribution`
   * above is not: turning it off is a decision about how the next thread reads,
   * not a mandate to re-spend a translation budget on every old one. A thread
   * already carrying a translation keeps the block it was published with until
   * its text or its languages change, and the identical-bytes check in the
   * core's `publish` is what stops a run from rewriting a hundred threads over
   * one line of chrome.
   */
  readonly branding: boolean;
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
 *
 * Everything Reeve has to say about a translation lives *inside* the section it
 * is about. A section is single-language throughout, so its boundary note and
 * its footer render in that one language — and what sits outside the sections
 * never grows with the language count: the rule, the branding line, and one
 * `<summary>` line per language. Ten configured languages are ten collapsed
 * lines, not ten copies of the same two sentences stacked above and below them.
 *
 * The branding line is the one thing here that is about Reeve rather than about
 * a translation, and it is the only reason anything sits between the rule and
 * the first section — see `BRANDING` below for why it is outside the sections
 * rather than in them, and why it costs one line no matter how many languages
 * follow it.
 */
export function publication(translated: Translated): Publication {
  if (translated.posted.length === 0) return { fingerprint: translated.fingerprint, sections: [] };

  return {
    fingerprint: translated.fingerprint,
    sections: [
      "---",
      ...(translated.branding ? [BRANDING] : []),
      ...translated.posted.map((entry) =>
        section(entry, translated, translated.posted.length === 1),
      ),
    ],
  };
}

/**
 * Where the logo is fetched from — `main`, not a release tag, on purpose.
 *
 * This block outlives the run that wrote it, in somebody else's issue body,
 * and a `main` URL means every one of those bodies shows whatever the mark is
 * *now* — a rebrand reaches the whole backlog the day it merges, with no run
 * spent republishing anything. A tag-pinned URL is the other defensible
 * answer (the bytes never change under an old thread), and it was rejected
 * here because a thousand threads wearing last year's logo is the worse
 * outcome for a line whose only job is to say what Reeve looks like today.
 *
 * The price of that choice is that this path is now a commitment:
 * `.github/assets/logo.png` moving or disappearing from `main` breaks the
 * image in every body ever published. Renaming that file is a breaking change
 * to threads this repository does not own — leave a copy at this path
 * forever, whatever the assets directory does next.
 *
 * The PNG rather than the SVG sitting beside it, even though this host serves
 * both with the right content type. A body is not only read in the web UI: it
 * goes out in every notification email the thread sends, and mail clients are
 * where SVG support stops being universal. The raster copy is the one every
 * renderer agrees on, and at 14 pixels there is nothing the vector was going to
 * win.
 */
const LOGO = "https://raw.githubusercontent.com/ecoma-io/reeve/main/.github/assets/logo.png";

/** Where clicking either half of the branding line goes. */
const HOME = "https://github.com/ecoma-io/reeve";

/**
 * The one line in the block that is about Reeve rather than about a translation.
 *
 * Reeve already names itself inside every section's boundary note, which is the
 * right place for the sentence a reader needs before they trust a translation —
 * and the wrong place for the mark, because a collapsed `<details>` shows
 * neither. So the name gets one always-visible line, immediately under the rule
 * and above the sections: a reader who never unfolds anything still knows what
 * put the block there and where to go to find out what it is.
 *
 * **One fixed line, whatever the language count.** It sits outside the
 * sections, which is the rule the whole layout is built on — ten configured
 * languages are ten collapsed lines plus this one, not eleven copies of it.
 *
 * **Trusted scaffolding, so it never goes through `escapeHtml` or `chrome`.**
 * Every other string in this module is either a workflow's value or a
 * translated sentence; this one is a literal written here, holding an `<img>`
 * tag that escaping would turn into visible source. It is also deliberately not
 * localised: it is a name and a tagline, and a name translated is a different
 * name.
 *
 * `height="14"` inline rather than in a stylesheet GitHub would strip, and no
 * `vertical-align` at all — an `<img>` sits on the text baseline by default,
 * which is exactly where a 14px mark next to `<sub>` text belongs. The mark's
 * own colours are indigo, teal and violet on a transparent ground with the
 * knocked-out lines white and fully enclosed by the bubbles, so it reads on
 * GitHub's light and dark themes alike — there is no white plate to glow on
 * dark and no dark ink to vanish on it. One asset therefore serves both themes,
 * which is why this is a bare `<img>` rather than the `<picture>` element
 * GitHub does support: a theme-switching pair would be two files to keep
 * pinned, for a mark that never needed switching.
 *
 * The `alt` is empty on purpose: the word "Reeve" follows immediately, and a
 * mark that announced itself would have a screen reader say the name twice.
 * Logo and name are inside one link so either half is clickable, which is what
 * a reader tries first.
 */
const BRANDING =
  `<sub>[<img src="${LOGO}" height="14" alt=""> **Reeve**]` +
  `(${HOME}) — autonomous repository operations</sub>`;

/**
 * The line that says which half of the body is which.
 *
 * A reader has to know, before reading a word of a translation, whether they
 * are reading a person or a model — and which one the project is answerable
 * for. Stated at the top of each section, in that section's own language,
 * because that is the one place a reader cannot reach the translation without
 * passing it: a collapsed section shows nothing, and an unfolded one shows this
 * first.
 */
function boundary(entry: Posted): string {
  return `> ${chrome("translateBoundary", entry.to.code)}`;
}

function section(entry: Posted, translated: Translated, alone: boolean): string {
  return [
    `<details${alone ? " open" : ""}>`,
    `<summary>${summary(entry, translated.attribution)}</summary>`,
    // GitHub only renders Markdown inside a block-level HTML element when a
    // blank line separates them, so these are load-bearing rather than tidy:
    // without them a fenced code block in the translation posts as one line of
    // backticks.
    "",
    boundary(entry),
    "",
    entry.text,
    "",
    ...(translated.attribution === "detail" ? [provenance(entry), ""] : []),
    footer(entry, translated),
    "",
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
 * One footer per section, below that section's translation and in its
 * language — the same notes in every section, because "what this run skipped"
 * is true of the run, not of one language's part in it. Repeating them costs
 * nothing a reader sees: each copy is inside its section's `<details>`, read
 * only by the reader who unfolded that language.
 */
function footer(entry: Posted, translated: Translated): string {
  const { from, skipped, truncated } = translated;
  const code = entry.to.code;

  const notes: string[] = [];
  if (from !== null) {
    notes.push(chrome("translateFooterFrom", code, { label: from.label }));
  }
  if (truncated) {
    notes.push(chrome("translateFooterTruncated", code));
  }
  if (skipped.length > 0) {
    notes.push(
      chrome("translateFooterSkipped", code, {
        list: skipped.map((language) => language.label).join(", "),
      }),
    );
  }
  notes.push(chrome("translateFooterEditable", code));

  return `<sub>${escapeHtml(notes.join(" "))}</sub>`;
}

/** A label and a model name arrive from a workflow file and land between tags. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
