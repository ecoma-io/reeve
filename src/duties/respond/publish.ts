/**
 * What a response run has to say, rendered into the block the core appends.
 *
 * The core owns the mechanics — finding the marker, keeping the author's half
 * intact, recognising a run that changed nothing. This module owns the one
 * part that is about a first reply: an unconditional notice that this is a
 * machine's words and not a maintainer's, the reply itself, and a short
 * provenance line naming what wrote it.
 *
 * **Posted as a brand-new comment, not appended to the body.** `translate`
 * appends because the thing it produces is a rendering of text the reader
 * already has open. A first reply is not that — it is an answer, and an
 * answer belongs where every later answer in the thread will be: the comment
 * stream, in order, with its own author line. Writing it into the issue body
 * would put Reeve's words above the human replies that come after it, forever.
 *
 * **The reply carries this duty's marker (`reeve:respond`) so a rerun can find
 * it.** The marker sits inside the one comment Reeve posted, in the same
 * `<!-- reeve:respond source=… -->` shape every duty uses — but this duty
 * never calls the core's `publish`, which splits, compares and replaces an
 * existing body in place. `main.ts` assembles this module's sections under
 * the marker once, with `core/publish.ts`'s `assemble`, and posts the result
 * as a brand-new comment. There is no address to find on a rerun, because a
 * rerun that finds its own marker among the replies stops before drafting
 * anything — see `main.ts`'s `decide`.
 *
 * **A run with nothing to post renders no sections.** A confidence below the
 * floor, or a draft nobody could produce, is a real outcome and not a reason
 * to post an empty reply — `publication` returns an empty section list for
 * it, and `main.ts` checks that list itself before it will call
 * `effects.comment`, rather than posting a marker with nothing under it.
 */
import { chrome } from "../../core/chrome.js";
import { fingerprint, markerFor, type Marker } from "../../core/marker.js";
import type { Publication } from "../../core/publish.js";

/** This duty's marker: `<!-- reeve:respond source=… -->`. */
export const marker: Marker = markerFor("respond");

/** What a run can say about why this draft was the one posted. */
export interface Decision {
  /** The winning draft's own confidence, 0 to 1. */
  readonly confidence: number;
  /** How many drafts were produced and admitted this run. */
  readonly drafts: number;
  /** Which ranking settled it. */
  readonly decidedBy: "score" | "judges";
  /** Every judge that voted, and what it picked — both already display names. */
  readonly votes: readonly { readonly model: string; readonly pick: string }[];
}

/** Everything this duty has to say about one thread. */
export interface Responded {
  /** The language the thread was written in, or null when detection reached no answer. */
  readonly language: string | null;
  /**
   * The same language, as the code {@link chrome} keys its table by, rather
   * than the display label {@link language} carries. Null under the same
   * condition {@link language} is null — detection reached no answer, so
   * there is nothing here for this reply's own chrome to follow either.
   */
  readonly languageCode: string | null;
  /**
   * The winning draft, already sanitised. Always the real text a model
   * wrote — never blanked for a reason to withhold posting. Whether a
   * confidence floor, a capability the warrant did not grant, or `dry-run`
   * keeps this from reaching the thread is `main.ts`'s decision, made by
   * calling `publication` or not; this field reports what was decided, not
   * what was allowed. That is what lets `respond-text`'s output carry the
   * draft even on a run that posted nothing, for a repo routing drafts to
   * maintainer review instead of the thread.
   */
  readonly text: string;
  /** What to call the model that wrote the winning draft. Already a display name. */
  readonly model: string;
  /**
   * How the winner was chosen. Absent when there was nothing to decide
   * between — one draft and no judges is not a contest, and rendering
   * "decided by score" for it would dress a foregone conclusion up as a
   * verdict.
   */
  readonly decision: Decision | null;
  /** Identifies the thread text this reply answers. See `responseFingerprint`. */
  readonly fingerprint: string;
}

/**
 * A provenance tag identifying what this reply answers — never a comparison
 * key. `main.ts`'s guard against answering a thread twice is the marker's
 * mere presence among the replies: once Reeve has posted, `decide` stops
 * before drafting anything, for any title, body or language the thread goes
 * on to have. No input reaches a second comparison, so this value is never
 * checked against a previous run's fingerprint, and could not re-open the
 * question of whether to answer even if it were.
 *
 * What it is for instead: a record, alongside the reply, of the exact text
 * and detected language this run answered — over the title, the body and the
 * language, and deliberately over nothing else. The model id is not in it,
 * because rotating past a failed model is not a fact about what was
 * answered; `drafts` is not in it, for the same reason.
 */
export function responseFingerprint(title: string, body: string, language: string | null): string {
  return fingerprint(`${title}\n\n${body}`, language === null ? [] : [language]);
}

/**
 * The run turned into a publication: a fingerprint, and the sections the core
 * appends under the marker.
 *
 * Pure and total, which is what lets the core recognise a run that changed
 * nothing — the same input renders the same bytes.
 */
export function publication(responded: Responded): Publication {
  if (responded.text.length === 0) return { fingerprint: responded.fingerprint, sections: [] };

  return {
    fingerprint: responded.fingerprint,
    sections: [
      boundary(responded.languageCode),
      responded.text,
      "",
      provenance(responded),
      footer(responded),
    ],
  };
}

/**
 * The line that says whose words these are.
 *
 * Unconditional — there is no input that renders this reply without it. A
 * first reply is the one duty in this project that speaks as though it were
 * a person answering, and the one place a reader cannot afford to guess
 * whether they are reading a maintainer or a model. Nothing downstream of
 * `main.ts` can produce a `Responded` whose `text` skips this: `publication`
 * is the only path from a decision to a posted body, and it always prepends
 * this line.
 *
 * The reply below it already belongs to one language — the thread's own, or
 * English when detection reached no answer — so this note follows the same
 * language, English fallback and all.
 */
function boundary(languageCode: string | null): string {
  return [
    "> [!NOTE]",
    `> ${chrome("respondBoundaryDrafted", languageCode)}`,
    `> ${chrome("respondBoundaryCaveat", languageCode)}`,
  ].join("\n");
}

/**
 * How the reply was produced, for a maintainer deciding whether to trust it.
 *
 * Always rendered, in `<sub>`, below the reply — a reader came for the
 * answer, and provenance is what they check second, if at all. Unlike
 * `translate/publish.ts`'s `provenance`, there is no attribution setting that
 * hides this: guard 6 of this duty's charter is that the notice a reply is
 * machine-written can never be stripped or disguised, and the model that
 * wrote it is part of that notice.
 */
function provenance(responded: Responded): string {
  const { decision, model } = responded;
  const parts = [`Drafted by \`${model}\`.`];

  if (decision !== null) {
    parts.push(
      `Confidence ${decision.confidence.toFixed(2)} of 1.00` +
        (decision.drafts > 1 ? `, best of ${String(decision.drafts)} drafts` : "") +
        `, decided by ${decision.decidedBy}.`,
    );
    if (decision.votes.length > 0) {
      const votes = decision.votes.map((vote) => `\`${vote.model}\`→\`${vote.pick}\``).join(", ");
      parts.push(`Votes: ${votes}.`);
    }
  }
  // The language the thread was written in belongs to `footer`, not here —
  // saying it twice in the same posted comment is the duplication this
  // function used to carry.

  return `<sub>${escapeHtml(parts.join(" "))}</sub>`;
}

/**
 * What a reader who did not run this should know.
 *
 * Follows the reply's own language, the same as `boundary()` above it, rather
 * than always addressing the reader in English: whoever is deciding whether
 * to trust the comment above is reading the reply itself in that language
 * already.
 */
function footer(responded: Responded): string {
  const notes = [
    responded.language === null
      ? chrome("respondFooterUnknown", responded.languageCode)
      : chrome("respondFooterKnown", responded.languageCode, { label: responded.language }),
    chrome("respondFooterRecord", responded.languageCode),
  ];

  return `<sub>${escapeHtml(notes.join(" "))}</sub>`;
}

/** A model name arrives from a workflow file and lands between tags. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
