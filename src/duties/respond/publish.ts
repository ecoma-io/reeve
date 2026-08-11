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
 * `<!-- reeve:respond source=… -->` shape every duty uses, so `publish` can
 * split, compare and replace it exactly the way it does a translated body —
 * only the address differs, and choosing the address is `main.ts`'s job, not
 * this module's.
 *
 * **A run with nothing to post writes nothing.** A confidence below the
 * floor, or a draft nobody could produce, is a real outcome and not a reason
 * to post an empty reply — the core's `publish` already refuses an empty
 * section list, so it is enough for this module to render none.
 */
import { fingerprint, markerFor, type Marker } from "../../core/marker.js";
import type { Publication } from "../../core/publish.js";

/** This duty's marker: `<!-- reeve:respond source=… -->`. */
export const marker: Marker = markerFor("respond");

const HOME = "https://github.com/ecoma-io/reeve";

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
 * What identifies a reply as answering a particular thread.
 *
 * Over the title, the body and the language the reply was written in, and
 * deliberately over nothing else — the model id is not in it because rotating
 * past a failed model is not a reason to answer a thread twice, and `drafts`
 * is not in it because raising the quality knob is a choice about the next
 * thread, not a mandate to re-answer this one.
 *
 * The language is part of the key rather than assumed constant: an issue
 * whose language this run could not place the first time and can the second
 * — because a maintainer widened `languages` in between — is a thread worth
 * answering again, in the language now available, and a fingerprint blind to
 * the language would call that thread already answered.
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
    sections: [boundary(), responded.text, "", provenance(responded), footer(responded)],
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
 */
function boundary(): string {
  return [
    "> [!NOTE]",
    `> This reply was drafted by [Reeve](${HOME}), not by a maintainer.`,
    "> A maintainer has not reviewed it. Treat it as a starting point, not an answer.",
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
  const { decision, model, language } = responded;
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
  if (language !== null) parts.push(`Written in ${language}.`);

  return `<sub>${escapeHtml(parts.join(" "))}</sub>`;
}

/**
 * What a reader who did not run this should know.
 *
 * Written in English rather than in the reply's own language: it addresses
 * whoever is deciding whether to trust the comment above, and that is not
 * always the thread's author.
 */
function footer(responded: Responded): string {
  const notes = [
    responded.language === null
      ? "This project could not identify the thread's language, so the reply above is in English."
      : `The thread was written in ${responded.language}.`,
    "Reeve answers a thread once — deleting this comment does not make it answer again.",
  ];

  return `<sub>${escapeHtml(notes.join(" "))}</sub>`;
}

/** A model name arrives from a workflow file and lands between tags. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
