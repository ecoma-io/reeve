/**
 * The last stage: performing the effects a duty asked for, and writing the
 * marker that says it did.
 *
 * **Appended, never rewritten.** The author's text stays byte-for-byte where
 * they put it and the duty's output goes underneath it, behind a marker. That
 * is what keeps everything GitHub reads out of a body intact — `Fixes #42`, a
 * task list's checkboxes, a `Co-authored-by` trailer, a template's headings —
 * none of which survive a body Reeve reformats or re-emits from its own idea of
 * the text.
 *
 * **A duty hands this module strings, not a request.** It renders its own
 * sections and this module decides where they go, whether they are worth
 * writing, and how the marker above them reads. A duty that assembled a body
 * itself would own the one invariant that is not its to own.
 *
 * **A run that produced nothing writes nothing.** Not an apology, and
 * emphatically not an overwrite: a provider that was out of quota this morning
 * must not cost the thread the good output it already has.
 */
import { authorHalf, type Marker } from "./marker.js";
import type { Thread } from "./forge.js";

/** What a duty decided, as data. The writing is this module's. */
export interface Publication {
  /**
   * What this run achieved, identifying the text and the terms the block below
   * answers. Computed from what came back, never from what was configured.
   */
  readonly fingerprint: string;
  /**
   * The blocks to place under the marker, in order, separated by a blank line.
   * Already sanitised: this module publishes what it is handed.
   *
   * Empty is a run with nothing to say, and it writes nothing at all.
   */
  readonly sections: readonly string[];
}

export type Outcome =
  | { readonly action: "published"; readonly mismatched: boolean }
  | { readonly action: "unchanged" }
  | { readonly action: "none"; readonly reason: string };

/**
 * The whole body: the author's text, then the marker, then the duty's sections.
 *
 * Pure and total — the same author text and the same publication render the
 * same bytes, which is what lets `publish` recognise a run that changed
 * nothing, and what lets `dry-run` show a consumer exactly what would have been
 * written.
 */
export function assemble(official: string, marker: Marker, publication: Publication): string {
  return [
    authorHalf(official),
    marker.render(publication.fingerprint),
    ...publication.sections,
  ].join("\n\n");
}

export async function publish(
  thread: Thread,
  marker: Marker,
  publication: Publication,
): Promise<Outcome> {
  if (publication.sections.length === 0) {
    return { action: "none", reason: "the run produced nothing to publish" };
  }

  const current = await thread.read();
  const { official } = marker.split(current);
  const body = assemble(official, marker, publication);

  // Re-writing identical text would mark the thread edited, fire the event this
  // workflow listens for, and spend a rate limit — in exchange for nothing a
  // reader can see.
  if (current === body) return { action: "unchanged" };

  await thread.write(body);

  // One re-read, after the write and never before it — this is not a lock and
  // it does not retry. Two runs racing the same thread (a `labeled` event and
  // an `edited` event landing together, most often) can both read the same
  // starting body and both write, and whichever write lands second wins
  // silently: GitHub has no compare-and-swap on an issue body the way the
  // Contents API has a `sha` for a file. A single re-read cannot undo that —
  // only a workflow's own `concurrency:` group can, by never letting two runs
  // reach `write` at once (see the installation guide) — so this is reported
  // rather than corrected: `mismatched` says the body this run is about to
  // call "published" was already moved out from under it by the time it
  // checked, and the caller decides what a reader needs to hear about that.
  const after = await thread.read();
  return { action: "published", mismatched: after !== body };
}
