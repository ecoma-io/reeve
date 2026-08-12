/**
 * How a run recognises its own previous work, and how it decides there is
 * nothing to do.
 *
 * Every duty that writes into a thread writes under a marker, and the marker
 * carries a fingerprint of what that run actually did. The next run recomputes
 * the fingerprint from the author's own text, finds its own answer already
 * there, and stops before spending a request. That is the whole of Reeve's
 * idempotency, and it is deliberately not a database: the record lives in the
 * thing it describes, so it cannot drift from it and it survives a fork, a
 * migration, or a restore from a backup that predates it.
 *
 * **A marker is namespaced by duty**, and that is not cosmetic. A thread can
 * carry a translation and a triage note at once, each with its own fingerprint
 * over its own inputs, and neither may read the other's marker as its own. One
 * global prefix would make the second duty to run either overwrite the first or
 * decide it had already run.
 *
 * **The fingerprint records what a run did, never what it was asked to do.**
 * A digest over the configured set says a language was translated when a
 * provider was out of quota and it was not — and the run that could have fixed
 * it then skips, permanently, because the marker already matches. So a duty
 * computes what it wants before spending anything and compares; and records
 * what came back. Those two are equal exactly when nothing fell short.
 */
import { createHash } from "node:crypto";

/**
 * Duty names allowed into a marker.
 *
 * The name is interpolated into a string that is searched for verbatim in a
 * public thread body, so it may not contain anything that could close the
 * comment or match somewhere it was not written. Duty names are ours rather
 * than a consumer's, which makes this an assertion about this repository — kept
 * anyway, because the day it stops being true is the day a marker becomes
 * forgeable from a workflow file.
 */
const DUTY_NAME = /^[a-z][a-z0-9-]*$/;

/** A body split at the marker. */
export interface Split {
  /**
   * The author's own text, and the only thing a duty is ever given to work
   * from. Reading the whole body instead would feed a run its own previous
   * output, and the run after that would feed on those.
   */
  readonly official: string;
  /**
   * The fingerprint of the block already there, or null for a body this duty
   * has never written into.
   */
  readonly fingerprint: string | null;
}

/** One duty's marker: how it writes one, and how it finds one it wrote. */
export interface Marker {
  /** The duty this marker belongs to. */
  readonly duty: string;
  /** The marker for a fingerprint, which is the only way one is written. */
  render(fingerprint: string): string;
  /** Splits a body into the author's text and this duty's fingerprint. */
  split(body: string): Split;
}

const SUFFIX = " -->";

/**
 * The marker for one duty.
 *
 * An HTML comment because it has to be invisible to a reader and legible to the
 * next run. The fingerprint rides in the same tag rather than in a second one,
 * so there is exactly one thing to find and no way for the two to disagree.
 */
export function markerFor(duty: string): Marker {
  if (!DUTY_NAME.test(duty)) {
    throw new Error(
      `marker: \`${duty}\` is not a duty name (expected lowercase letters, digits and hyphens).`,
    );
  }

  const prefix = `<!-- reeve:${duty} source=`;

  return {
    duty,

    render(fingerprint) {
      return `${prefix}${fingerprint}${SUFFIX}`;
    },

    split(body) {
      // The first marker wins. A body carrying two of them is a thread someone
      // has edited by hand, and taking the first keeps the author's text —
      // which is above both — rather than silently promoting a published block
      // into it.
      const at = body.indexOf(prefix);
      if (at === -1) return { official: authorHalf(body), fingerprint: null };

      const from = at + prefix.length;
      const to = body.indexOf(SUFFIX, from);
      // An opener with no closer is a truncated body rather than a block. The
      // text before it is still the author's, and the fingerprint is
      // unreadable, so the run treats it as never having published — which
      // republishes rather than leaving a half-written marker there forever.
      if (to === -1) return { official: authorHalf(body.slice(0, at)), fingerprint: null };

      return { official: authorHalf(body.slice(0, at)), fingerprint: body.slice(from, to) };
    },
  };
}

/**
 * The author's half, canonical.
 *
 * Trailing whitespace is dropped because the block below it supplies its own
 * separation, so a body ending in a newline and one that does not are the same
 * author text. Applying it in exactly one place is load-bearing rather than
 * tidy: a split and an assembly disagreeing by a single `\n` would give the
 * same text two different fingerprints on consecutive runs, and every edit
 * would then re-spend the whole budget before stopping at the identical-bytes
 * check. What is kept is every byte a reader or a parser sees.
 */
export function authorHalf(text: string): string {
  return text.replace(/\s+$/u, "");
}

/**
 * What identifies a published block as answering a particular text under
 * particular terms.
 *
 * `keys` is whatever changing would oblige the duty to do the work again — the
 * language codes for a translation, the taxonomy for a triage. It is
 * deliberately narrow: model ids are not in it, because rotating past a failed
 * model is not a reason to redo a thread nobody edited, and neither are the
 * quality knobs, because raising one is a choice about the next thread rather
 * than a mandate to re-spend the budget on every old one.
 *
 * Truncated because it is compared, never inverted: it goes into a public body
 * and a reader should see a short opaque tag rather than a wall of hex.
 */
export function fingerprint(text: string, keys: readonly string[]): string {
  const sorted = [...keys].map((key) => key.toLowerCase()).sort();
  // A NUL separator: it cannot occur in any key a duty uses, and GitHub does
  // not keep one in a body either, so no two different inputs share a digest
  // input.
  //
  // Written as an escape rather than as the byte itself. A literal NUL in the
  // source makes git classify this file as binary, so a pull request touching
  // it shows `Bin 12990 -> 16484 bytes` where the diff should be — which takes
  // the module deciding what gets published into a public thread out of review
  // without saying it did. The hashed bytes are identical either way.
  return createHash("sha256")
    .update([text, ...sorted].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The `propose` capability's own marker grammar, one level finer than
 * {@link markerFor}.
 *
 * `markerFor("propose")` identifies the whole change-set a proposal PR
 * carries, by one fingerprint — that is what makes an unchanged world cost
 * nothing. But a closed-unmerged proposal's rejection has to be remembered
 * per *entry*, not per change-set: a change-set is never the same twice once
 * a new package appears, so respecting only the old fingerprint would let a
 * struck entry ride back in, hiding inside a change-set that merely grew.
 * This is the sibling grammar that names one entry — `add:area:billing` or
 * `retire:area:billing` — so a rejection can be remembered by name and
 * survive a change-set that has moved on. Both markers live in the same PR
 * body; neither substitutes for the other.
 */
export function proposeEntryMarker(action: "add" | "retire", name: string): string {
  return `<!-- reeve:propose:entry ${action}:${name} -->`;
}

/**
 * Every entry marker `body` carries, as `"add:area:billing"`-shaped tokens.
 *
 * Read from a *closed, unmerged* proposal PR's body — the permanent memory of
 * what a maintainer rejected by closing rather than merging. Bounded by the
 * marker's own `-->` closer rather than by whitespace, because a label name
 * may contain almost anything except a newline.
 */
export function readProposeEntryMarkers(body: string): ReadonlySet<string> {
  const found = new Set<string>();
  const re = /<!-- reeve:propose:entry ((?:add|retire):[^\n]*?) -->/g;
  for (const match of body.matchAll(re)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return found;
}

const PROPOSE_MARKER = markerFor("propose");

/**
 * The recursion guard: whether a thread is Reeve's own proposal pull
 * request — the one every other duty must never sweep, triage, translate,
 * label, or let `lifecycle` stale or close.
 *
 * The one-open-PR invariant and the struck-entry memory both live only in
 * that PR's body (see `propose.ts`'s `findOwnOpenPr`/`struckEntries`); a
 * duty that edited its body, relabelled it, or closed it out from under
 * `propose` would corrupt state nothing else can reconstruct. `propose.ts`'s
 * `renderBody` always writes the `propose` marker into every proposal PR it
 * creates or updates, so the marker's presence is a complete, zero-cost
 * signal — reading it costs nothing beyond the body every duty's listing
 * already carries, unlike confirming the pull request's head ref by name,
 * which would cost a `pulls.get` per pull request candidate in every sweep.
 */
export function isReeveProposalPr(thread: {
  readonly isPullRequest: boolean;
  readonly body: string;
}): boolean {
  if (!thread.isPullRequest) return false;
  return PROPOSE_MARKER.split(thread.body).fingerprint !== null;
}
