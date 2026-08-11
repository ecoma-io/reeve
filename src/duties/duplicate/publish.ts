/**
 * What a duplicate check has to say, and how it reaches the thread.
 *
 * **A comment, not the body.** `translate` and `record` edit the thread body
 * because their output is something every future reader needs beside the text
 * it is about. A duplicate proposal is different in kind: it is a claim about
 * *this run*, addressed to whoever triages next, and a maintainer who
 * disagrees with it wants to be able to say so underneath it the way they
 * would to any other comment — which a rewritten body does not let them do.
 * `close` names the human motion this duty stops short of; the comment is
 * where that human decision happens.
 *
 * **No `TrackerApi` method finds or edits an existing comment.** `core/forge.ts`
 * deliberately keeps `TrackerApi` — the port every other duty's `Effects` is
 * built against — four methods long, and every one of them only adds. Marker
 * idempotency for a comment needs to read the thread's comments back and
 * overwrite one of them, which is a different port than "add", so this module
 * declares its own `CommentApi` rather than widening the one every other
 * duty's hand-built test double would then have to grow methods it never
 * uses. A real Octokit client satisfies both simultaneously — the same
 * relationship `GitHubApi` and `TrackerApi` already have.
 *
 * **The marker guards the write, not the decision.** A run that reaches the
 * same fingerprint as the comment already there changes nothing on the
 * thread; a run that reaches a different one — because the corpus grew, or
 * the confidence floor moved — replaces it. Reruns never stack a second
 * opinion under the first.
 *
 * **The target rides in the tag, not only in the prose beneath it.** Whatever
 * eventually closes a thread on this verdict's say-so — a workflow reading
 * `duplicate-of`, or a later duty — is going to want to attribute that close
 * back to this comment without parsing a rationale sentence that is
 * translated, reworded by `show-attribution`, or simply absent. See
 * `payloadFor`.
 */
import type { Location } from "../../core/forge.js";
import { fingerprint, markerFor, type Marker } from "../../core/marker.js";

/** This duty's marker: `<!-- reeve:duplicate source=<fingerprint> duplicate-of=<N> -->`. */
export const marker: Marker = markerFor("duplicate");

/**
 * How much of the machinery behind a proposal the comment names.
 *
 * The same three-value axis `translate` reads `show-attribution` into, reused
 * rather than reinvented — a consumer who already knows what `none`, `model`
 * and `detail` mean on one duty should not have to learn a second spelling of
 * the same idea on this one. `none` is the default for the reason it is
 * there: which model wrote a suggestion is noise in a body a contributor is
 * reading to find out whether their report already exists, and it is already
 * in the job summary for whoever configured the run.
 *
 * **Distinct from the machine-attribution floor.** Even at `none`, the
 * comment always says this was proposed by a model rather than decided by a
 * maintainer — that sentence is not part of this axis and cannot be turned
 * off by it. What `none` withholds is the *name* of the model, not the fact
 * that one was involved.
 */
export type Attribution = "none" | "model" | "detail";

/** What one run decided to say about a thread, ready to render. */
export interface Proposal {
  /** The candidate this run believes the thread repeats. */
  readonly duplicateOf: number;
  /** The judge's own confidence, 0 to 1. */
  readonly confidence: number;
  /** The BM25 score that put this candidate in front of the judge, for `detail`. */
  readonly lexicalScore: number;
  /** One sentence from the verdict, already sanitised — this module publishes what it is handed. */
  readonly rationale: string;
  /** The model's display name, already resolved by the caller. */
  readonly model: string;
  readonly attribution: Attribution;
}

/**
 * What identifies a proposal as answering a particular thread against a
 * particular shortlist.
 *
 * Over the thread's own text and the candidate numbers the judge was actually
 * shown — not the static `corpus-limit`/`corpus-since`/`candidates` knobs
 * that produced that shortlist. That is what makes "a grown corpus re-asks
 * and an identical rerun stops" literally true: two runs that rank the same
 * shortlist out of a corpus reach the same fingerprint whatever the corpus
 * around it did, and a corpus that grew a new top candidate changes the
 * shortlist and therefore the fingerprint, whether or not any config changed.
 */
export function proposalFingerprint(source: string, candidates: readonly number[]): string {
  return fingerprint(
    source,
    candidates.map((number) => String(number)),
  );
}

/**
 * The marker's payload: `proposalFingerprint`'s own hash, plus the target
 * this run named, machine-readable in the tag itself.
 *
 * This duty never closes a thread — a maintainer does, and `duplicate-of` is
 * the output a workflow reads to do it under its own authority. But whatever
 * closes on this verdict's say-so, today or in a later duty, is going to want
 * to attribute that close back to "Reeve said #N was a duplicate of #M"
 * without parsing the rationale sentence to find `M` — that sentence is
 * translated, reworded, or simply absent depending on `show-attribution` and
 * the thread's own language, none of which a parser should have to follow.
 * `duplicate-of=` rides in the same tag as the fingerprint that already
 * guards idempotency, so there is exactly one thing to find and — as with the
 * fingerprint itself — no way for a displayed target and a recorded one to
 * disagree.
 */
function payloadFor(fp: string, duplicateOf: number): string {
  return `${fp} duplicate-of=${String(duplicateOf)}`;
}

/** Enough of a comment's author to tell whether it was Reeve's own bot that wrote it. */
export interface Author {
  readonly login?: string | null;
  readonly type?: string | null;
}

/**
 * Whether a comment's author is a bot — the same convention
 * `triage/main.ts`'s `recordTrigger` reads a webhook sender by, mirrored here
 * for a comment author: GitHub's own `type: "Bot"` when the API reports it,
 * or a `[bot]`-suffixed login for the cases it does not.
 */
function isBot(author: Author | null | undefined): boolean {
  return author?.type === "Bot" || (author?.login ?? "").endsWith("[bot]");
}

/**
 * The part of an Octokit client this module needs to find and replace its own
 * comment — the comment pair `GitHubApi` already declares for editing a
 * thread body's own replies, plus the one write `TrackerApi`'s `Effects`
 * already makes. Declared structurally, the same way both of those are, so a
 * real client and a hand-built test double satisfy it identically.
 */
export interface CommentApi {
  readonly rest: {
    readonly issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: { id: number; body?: string | null; user?: Author | null }[] }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

/**
 * How many comments one run will look at when searching for its own marker.
 *
 * Mirrors `core/forge.ts`'s `REPLY_PAGE` — a single page, newest ceiling
 * GitHub allows per request — for the same reason and the same accepted
 * tradeoff: a marker on a thread with more than a hundred replies might sit
 * past this page and go unfound, which costs a stacked comment on a thread
 * active enough that one more comment is the smaller problem.
 */
const COMMENT_PAGE = 100;

/** This duty's own comment, as a listing found it. */
export interface Marked {
  readonly id: number;
  /** Null when the comment predates this fingerprint scheme — treated as certainly stale. */
  readonly fingerprint: string | null;
}

/**
 * This duty's own comment on the thread, if a previous run left one.
 *
 * `marker.split` is generic over any text carrying the marker, not
 * specifically a thread body — see its own doc comment — which is what makes
 * it reusable here on a standalone comment without a second implementation.
 *
 * **Two guards, not one, before a comment counts as this duty's own.** A
 * comment's author has to be a bot, and the marker has to open the comment —
 * `marker.split(body).official === ""`, nothing but whitespace in front of
 * it. Without both, a human quoting this duty's own marker text back (to
 * disagree with it, to report it, anything) or simply forging the tag inside
 * their own comment would be read as a rerun target, and the next run would
 * overwrite a stranger's comment believing it was replacing its own. Neither
 * guard alone is enough: a bot's *other* comment could still carry the marker
 * merely quoted, and a human's comment opening with the exact tag text is a
 * forgery worth refusing regardless of who is credited with typing it.
 */
export async function findMarked(api: CommentApi, at: Location): Promise<Marked | null> {
  const { data } = await api.rest.issues.listComments({
    owner: at.owner,
    repo: at.repo,
    issue_number: at.number,
    per_page: COMMENT_PAGE,
  });

  for (const comment of data) {
    if (!isBot(comment.user)) continue;
    const { official, fingerprint: found } = marker.split(comment.body ?? "");
    if (found !== null && official === "") return { id: comment.id, fingerprint: found };
    // No marker at all, a marker embedded mid-body, or a non-bot author is
    // never this duty's to touch, so the search keeps going rather than
    // stopping here.
  }
  return null;
}

/** What the write step did, for the summary and for the `commented` output. */
export type Posted = "posted" | "replaced" | "unchanged";

/** What a write would do, decided without writing anything — the read half `postOrReplace` and `rehearse` share. */
interface Classification {
  readonly disposition: Posted;
  readonly body: string;
  readonly existing: Marked | null;
}

/**
 * Reads whatever `postOrReplace` would need to decide `posted`/`replaced`/
 * `unchanged`, without writing anything — the same lookup either way, so a
 * rehearsal under `dry-run` and a real run can never disagree about which of
 * the three a given proposal would produce.
 */
async function classify(
  api: CommentApi,
  at: Location,
  proposal: Proposal,
  fp: string,
): Promise<Classification> {
  const payload = payloadFor(fp, proposal.duplicateOf);
  const body = [marker.render(payload), render(proposal)].join("\n\n");
  const existing = await findMarked(api, at);
  const disposition: Posted =
    existing === null ? "posted" : existing.fingerprint === payload ? "unchanged" : "replaced";
  return { disposition, body, existing };
}

/**
 * Posts `proposal` under the marker, replacing this duty's own previous
 * comment when the fingerprint moved and leaving it alone when it did not.
 *
 * Never touches a comment without this duty's marker on it — a maintainer's
 * own comment, or anybody else's, is never a candidate for replacement.
 */
export async function postOrReplace(
  api: CommentApi,
  at: Location,
  proposal: Proposal,
  fp: string,
): Promise<Posted> {
  const { disposition, body, existing } = await classify(api, at, proposal, fp);

  if (existing === null) {
    await api.rest.issues.createComment({
      owner: at.owner,
      repo: at.repo,
      issue_number: at.number,
      body,
    });
    return disposition;
  }

  if (disposition === "unchanged") return disposition;

  await api.rest.issues.updateComment({
    owner: at.owner,
    repo: at.repo,
    comment_id: existing.id,
    body,
  });
  return disposition;
}

/**
 * What `postOrReplace` would do to the thread, without doing it — `dry-run`'s
 * rehearsal for this duty's one write. Shares `classify` with `postOrReplace`
 * itself rather than reimplementing the lookup, so the disposition a dry run
 * reports and the disposition a real run would reach can never drift apart.
 */
export async function rehearse(
  api: CommentApi,
  at: Location,
  proposal: Proposal,
  fp: string,
): Promise<Posted> {
  return (await classify(api, at, proposal, fp)).disposition;
}

/**
 * The comment's own text, under the marker.
 *
 * Pure and total — the same proposal renders the same bytes, which is what
 * lets `postOrReplace` and the fingerprint above it recognise a rerun that
 * changed nothing without asking GitHub to diff two comments for it.
 */
function render(proposal: Proposal): string {
  const lines = [
    `Possible duplicate of #${String(proposal.duplicateOf)}.`,
    ...(proposal.rationale.length > 0
      ? ["", defang(proposal.rationale, proposal.duplicateOf)]
      : []),
    "",
    footer(proposal),
  ];
  return lines.join("\n");
}

/**
 * Fences every `#N` in `text` that is not `allowed` inside a code span,
 * leaving only the headline's own target — `render`'s first line, above —
 * live.
 *
 * The rationale is model prose, read from the judge's own free-text answer,
 * not a value this run checked the way it checked `duplicateOf` against the
 * shortlist. A number it mentions in passing ("similar to what #55 turned
 * out to be") would otherwise autolink on GitHub the moment this comment
 * posts, silently cross-referencing and notifying a thread this run never
 * looked at. A code span is enough to stop that without hiding the text
 * itself — GitHub does not autolink an issue reference inside one.
 */
function defang(text: string, allowed: number): string {
  return text.replace(/#(\d+)/g, (match, digits: string) =>
    Number(digits) === allowed ? match : `\`${match}\``,
  );
}

/**
 * What the run did, for a reader who did not run it.
 *
 * The first sentence is the machine-attribution floor and is not gated by
 * `attribution` at all — a reader deciding whether to trust this comment has
 * to be told a model wrote it before anything else on the axis, which is
 * exactly why it is not on the axis.
 */
function footer(proposal: Proposal): string {
  const parts = ["Proposed by a model, not decided by a maintainer — read it as a lead to check."];

  if (proposal.attribution !== "none") {
    parts.push(`Suggested by \`${proposal.model}\`.`);
  }
  if (proposal.attribution === "detail") {
    parts.push(
      `Confidence ${proposal.confidence.toFixed(2)} of 1.00, ` +
        `lexical match ${proposal.lexicalScore.toFixed(2)}.`,
    );
  }
  parts.push("Editing this thread and re-running replaces this comment; it is never posted twice.");

  return `<sub>${escapeHtml(parts.join(" "))}</sub>`;
}

/** A model name arrives from a workflow file and lands inside a backtick span. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
