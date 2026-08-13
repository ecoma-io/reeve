/**
 * What happened to Reeve's own past actions on a thread — the S1 and S3 signals
 * `recall.ts`'s doc comment argues a model needs shown differently, and the one
 * refusal recall alone cannot provide.
 *
 * Three things live here, and they are grouped because they are one argument:
 *
 * - **Attribution** (`attributedClose`, `removedByAutomation`): whether a close
 *   or a label actually was Reeve's own doing, not a stranger's forged comment
 *   or a maintainer's own prior decision. Every signal below is only as honest
 *   as this check, because a reversal recorded against something Reeve never
 *   did would teach a model to distrust its own correct verdicts.
 * - **Standing** (`isTrustedReopener`, `checkReversal`): whether the human doing
 *   the reversing has the standing to make it count — see `checkReversal`'s own
 *   doc comment for why an author's own reopen is treated differently from a
 *   maintainer's.
 * - **The hard gate** (`gateClose`): the refusal a model's own verdict cannot
 *   talk its way past. Recall is an example in a prompt, and a prompt is
 *   advice — the gate is checked in code, after the model has already
 *   answered, on the one action (`close`) a mistake here cannot cheaply undo.
 *
 * All three are read-only with respect to the tracker: nothing in this module
 * calls an `Effects` method or writes a correction. `triage/main.ts` is the
 * only place that turns what this module finds into a written record or a
 * refused close — this module only ever answers "what does the evidence say".
 */
import {
  listCorrectionFiles,
  listLabelEvents,
  listReplies,
  readContentsFile,
  UnreadableContentsFile,
  type ContentsApi,
  type GitHubApi,
  type Location,
  type Standing,
  type TrackerApi,
} from "../../core/forge.js";
import { closeMarkerFor } from "../../core/marker.js";
import { parseCorrection } from "../../core/memory.js";

/**
 * This duty's close-attribution marker, shared between the write side
 * (`triage/main.ts`'s `comment` appends it to every close it makes) and the
 * read side (`attributedClose` below looks for it). One instantiation so the
 * two can never drift onto different grammars — see `closeMarkerFor`'s own
 * doc comment for why the grammar itself has to exist before either side can.
 */
export const closeMarker = closeMarkerFor("triage");

/**
 * S1's attribution half: whether the taxonomy label a human just removed was
 * itself applied by automation, read from this thread's own event timeline.
 *
 * Oldest first is `listLabelEvents`'s own order, which is what lets a single
 * pass keep only the *last* `labeled` event for `label` — the one whose actor
 * decides whether removing it just now is "a human corrected automation" or
 * "a human corrected a human". Every earlier `labeled` event for the same
 * label is superseded by construction: a label cannot be reapplied without
 * first being removed, so the most recent application is the only one still
 * standing at the moment this event happened.
 *
 * **An incomplete or unreadable history answers `false`, not "unknown".**
 * `record` already writes an ordinary (non-`overruled`) correction for every
 * human relabel — this function only decides whether to *enrich* that write
 * with `outcome: "overruled"`, and a history this run could not fully read is
 * not evidence either way. Forgoing the enrichment costs nothing an ordinary
 * S2 record would not already have; guessing at it from a partial read could
 * teach a false reversal.
 */
export async function removedByAutomation(
  api: TrackerApi,
  at: Location,
  label: string,
): Promise<boolean> {
  let history: {
    readonly events: readonly { action: string; label: string; isBot: boolean }[];
    readonly complete: boolean;
  };
  try {
    history = await listLabelEvents(api, at);
  } catch {
    return false;
  }
  if (!history.complete) return false;

  let byBot = false;
  for (const event of history.events) {
    if (event.action === "labeled" && event.label === label) byBot = event.isBot;
  }
  return byBot;
}

/** What a reopened thread's most recent close attributes to Reeve, or nothing. */
export interface CloseAttribution {
  /** The target Reeve's own close comment named — read straight from the marker, see `closeMarker`. */
  readonly duplicateOf: number;
}

/**
 * S3's attribution half: whether this thread's replies carry Reeve's own
 * close-attribution marker inside a bot-authored comment — the two-part check
 * `closeMarkerFor`'s doc comment describes as "attribution is the two
 * together". Neither is sufficient alone: the marker text is forgeable by
 * any stranger who copies it into a comment, and `isBot` alone does not say
 * *which* bot or *what it claimed* — a project running a second bot that
 * also closes threads would otherwise be misattributed to this duty.
 *
 * Scanned newest-first among the replies `listReplies({order: "newest"})`
 * keeps, because a thread can carry more than one close-and-reopen cycle in
 * its history and the marker that matters is the one for the close this
 * reopen just reversed — the most recent one, not the first one found.
 *
 * **Fails closed on any error, including a network failure reading replies.**
 * An unreadable comment section is not evidence that the close was Reeve's
 * own — returning `null` lets the reopen fall through to an ordinary verdict,
 * which is the safe direction: no reversal is recorded, and the thread is
 * still triaged.
 */
export async function attributedClose(
  api: GitHubApi,
  at: Location,
): Promise<CloseAttribution | null> {
  let replies: readonly { isBot: boolean; body: string }[];
  try {
    ({ replies } = await listReplies(api, at, { order: "newest" }));
  } catch {
    return null;
  }

  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const reply = replies[index];
    if (!reply?.isBot) continue;
    const duplicateOf = closeMarker.find(reply.body);
    if (duplicateOf !== null) return { duplicateOf };
  }
  return null;
}

/**
 * Whether `username` has standing to make a reversal count — GitHub's own
 * `write`/`admin` permission levels, the closest available proxy for
 * `author_association`'s OWNER/MEMBER/COLLABORATOR band now that the field
 * itself is unavailable on a webhook's `sender` (see `TrackerApi.repos`'s doc
 * comment). Narrower than the band it stands in for — a collaborator granted
 * only `read` or `triage` access would count as COLLABORATOR but not here —
 * which is the direction this project already accepts false negatives in:
 * see `checkReversal`'s doc comment.
 *
 * **Fails closed on any error, including a 404 for an account with no
 * relationship to the repository at all.** A stranger reopening a thread is
 * exactly the case this exists to refuse, not one that gets the benefit of
 * the doubt because the lookup happened to fail rather than to answer "no".
 */
export async function isTrustedReopener(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  username: string,
): Promise<boolean> {
  if (username.length === 0) return false;
  try {
    const { data } = await api.rest.repos.getCollaboratorPermissionLevel({
      owner: at.owner,
      repo: at.repo,
      username,
    });
    return data.permission === "admin" || data.permission === "write";
  } catch {
    return false;
  }
}

/** What a `reopened` event's evidence adds up to. */
export interface ReversalCheck {
  /** Set only when this reopen both reverses a Reeve close and comes from a trusted account. */
  readonly reversal: CloseAttribution | null;
  /**
   * Set when the close was Reeve's own but the reopener was the thread's own
   * author — surfaced to a maintainer rather than recorded, see this
   * function's own doc comment.
   */
  readonly authorReopen: boolean;
}

/**
 * The full S3 check a `reopened` event runs before anything is recorded:
 * was the close Reeve's own, and does the reopener have the standing to
 * reverse it.
 *
 * **An author's own reopen is never recorded, even when the close was
 * Reeve's own duplicate-close and even though the thread's author is, almost
 * definitionally, a trusted account with respect to their own thread.** The
 * design this implements draws that line on purpose: a thread's author
 * reopening their own thread is evidence they disagree, not evidence a
 * *maintainer* disagrees — and a maintainer's agreement is what a memory
 * entry claims here, the same way an ordinary label correction is never
 * recorded from a bot's own label change. `authorReopen` surfaces the case in
 * the run's own summary instead (`triage/main.ts`'s call site), so a
 * maintainer who agrees can still act on it — by relabelling, which *is*
 * recorded — rather than have Reeve infer agreement it was never given.
 */
export async function checkReversal(
  api: GitHubApi & TrackerApi,
  at: Location,
  standing: Standing,
  reopener: string,
): Promise<ReversalCheck> {
  const attribution = await attributedClose(api, at);
  if (attribution === null) return { reversal: null, authorReopen: false };

  if (reopener !== "" && reopener.toLowerCase() === standing.author.login.toLowerCase()) {
    return { reversal: null, authorReopen: true };
  }

  const trusted = await isTrustedReopener(api, at, reopener);
  if (!trusted) return { reversal: null, authorReopen: false };

  return { reversal: attribution, authorReopen: false };
}

/** Whether the hard gate refuses a close, and what it could not fully check. */
export interface Gate {
  /**
   * `true` refuses the close. Set either by a matching reversal record or by
   * an unreadable shard — see this function's own doc comment for why the
   * two are treated alike.
   */
  readonly refuse: boolean;
  /**
   * `true` when the refusal is because a matching reversal record was
   * actually found, as opposed to an unreadable shard the run could not rule
   * out. The caller needs this to pick the right explanation: a scan can
   * find the record on one shard after already failing to read an earlier
   * one, in which case `unreadable` is non-empty *and* the record was
   * found — `refuse` alone cannot tell those two stories apart, only this
   * can. `false` whenever `refuse` is `false` too.
   */
  readonly found: boolean;
  /** Shards this run could not read while checking — logged by the caller, never by this module. */
  readonly unreadable: readonly string[];
}

/**
 * The hard, code-level refusal a model's own verdict cannot override: does
 * (`repo`, `thread`) already carry a correction recording that a human
 * reversed a Reeve duplicate-close.
 *
 * Read through the Contents API, the same mechanism `attemptWrite` in
 * `triage/main.ts` already searches the store with before a write — so this
 * needs no checkout, and, just as importantly, needs no `readStore`: the
 * gate has to hold on a run whose `memory.recall` is configured to `0` and
 * which therefore never touches the filesystem-backed store at all. Recall's
 * "the store is not touched" promise and the gate's own read are two
 * completely separate guarantees, and conflating them would make lowering
 * `recall` to `0` a way to silence the gate.
 *
 * **Fails closed on an unreadable shard, and only on that — never on an
 * unparseable line inside a shard this run did successfully read.** A shard
 * this run could not decode at all (`UnreadableContentsFile`) might hold the
 * one line that matters, the same ambiguity `attemptWrite` itself refuses to
 * guess through before a write; refusing the close is the same caution
 * applied before one. A single garbled line inside an otherwise-readable
 * shard carries no such ambiguity about *other* threads' records — that is
 * the ordinary "a bad line is skipped, not fatal" handling `readStore` already
 * gives a hand-edited file, and holding every close in the repository hostage
 * to one malformed line anywhere in the store would be a availability cost
 * this doctrine never asks for.
 */
export async function gateClose(
  contentsApi: ContentsApi,
  at: Pick<Location, "owner" | "repo">,
  path: string,
  repo: string,
  thread: number,
): Promise<Gate> {
  const files = await listCorrectionFiles(contentsApi, at, path);
  const unreadable: string[] = [];

  for (const file of files) {
    let read: { readonly text: string; readonly sha: string } | null;
    try {
      read = await readContentsFile(contentsApi, at, file.path);
    } catch (error) {
      if (!(error instanceof UnreadableContentsFile)) throw error;
      unreadable.push(file.path);
      continue;
    }
    if (read === null) continue;

    for (const line of read.text.split("\n")) {
      if (line.trim().length === 0) continue;
      const correction = parseCorrection(line);
      if (correction === null) continue;
      if (
        correction.repo === repo &&
        correction.thread === thread &&
        correction.outcome === "overruled" &&
        correction.duplicateOf !== null
      ) {
        return { refuse: true, found: true, unreadable };
      }
    }
  }

  return { refuse: unreadable.length > 0, found: false, unreadable };
}
