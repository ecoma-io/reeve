/**
 * Reading maintainer dispositions off the owned thread's replies.
 *
 * The review duty owns exactly one comment, and that comment is a thread a
 * maintainer can reply to. A disposition is an attributed triage a maintainer
 * makes in one of those replies: `verified`, `accepted-risk`, `wont-fix` or
 * `rejected`, written against a finding's line or path. This module reads those
 * replies and turns them into `Disposition` values — the human axis, kept
 * deliberately orthogonal to the evidence ladder `reconcile` computes.
 *
 * **The thread is the durable home; the envelope is a mirror.** Every run
 * re-derives dispositions from the eligible replies it reads, and the envelope
 * only *mirrors* them for the case a reply falls off the read window or the
 * comment is replaced. The merge order below — fresh wins, mirror fills gaps —
 * keeps the thread authoritative and the mirror lossless.
 *
 * **Eligibility is strict.** A disposition is attributed: the reply must come
 * from an OWNER, COLLABORATOR or MEMBER account (`author_association`), not a
 * bot, and not the pull request's own author. A stranger's or a bot's reply
 * carries no weight even when its text matches the grammar exactly.
 *
 * **The grammar is strict and anchored.** A reply that does not fully match is
 * ignored entirely — no substring extraction, no guessing. A line a maintainer
 * writes as prose ("I think this is fine, please check line 12") does not
 * become a disposition by accident.
 */
import type { Disposition, DispositionValue, PreviousFinding } from "./findings.js";

/** One reply on the owned thread, as the API listing read it. */
export interface ThreadReply {
  readonly id: number;
  readonly login: string;
  readonly isBot: boolean;
  readonly association: string;
  readonly createdAt: string;
  readonly body: string;
}

/** The strict line grammar: `12: wont-fix`, optionally @-mentioned and optionally `line`-prefixed. */
const LINE_FORM =
  /^\s*(?:@[a-z0-9-]+\s+)?(?:line\s+)?(\d+)\s*:\s*(verified|accepted-risk|wont-fix|rejected)\s*(?:[,;:.].*)?$/i;
/** The strict path grammar: `src/app.ts:3: rejected`. */
const PATH_FORM =
  /^\s*(?:@[a-z0-9-]+\s+)?([^\s:]+(?:\.[A-Za-z0-9]+)+):(\d+)\s*:(verified|accepted-risk|wont-fix|rejected)\s*(?:[,;:.].*)?$/i;

/** A parsed disposition claim, before it is matched to a finding. */
interface Parsed {
  readonly path: string | null;
  readonly line: number;
  readonly value: DispositionValue;
}

/**
 * Parses one strict disposition line.
 *
 * Returns `null` for anything that is not exactly one of the two grammars —
 * prose, a bare mention, a value outside the union, a non-anchored match. A
 * trailing comma/semicolon/colon/punctuation tail is allowed (`12: wont-fix.`),
 * and the value keyword is case-insensitive.
 */
export function parseDispositionLine(line: string): Parsed | null {
  const pathMatch = PATH_FORM.exec(line);
  if (pathMatch?.[2] !== undefined && pathMatch[3] !== undefined) {
    return {
      path: pathMatch[1] ?? null,
      line: Number(pathMatch[2]),
      value: pathMatch[3] as DispositionValue,
    };
  }
  const lineMatch = LINE_FORM.exec(line);
  if (lineMatch?.[1] !== undefined && lineMatch[2] !== undefined) {
    return { path: null, line: Number(lineMatch[1]), value: lineMatch[2] as DispositionValue };
  }
  return null;
}

const ELIGIBLE_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "COLLABORATOR", "MEMBER"]);

/**
 * Whether a reply is an eligible disposition carrier.
 *
 * All of these must hold: not a bot, `author_association` ∈ {OWNER,
 * COLLABORATOR, MEMBER}, the login is not the pull request author's, the
 * comment id is a positive integer and `created_at` is a string. Everything
 * else — CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, bots, the PR author, an
 * empty login — is ineligible.
 */
export function isEligibleReply(reply: ThreadReply, prAuthorLogin: string): boolean {
  return (
    !reply.isBot &&
    reply.login.length > 0 &&
    reply.login !== prAuthorLogin &&
    ELIGIBLE_ASSOCIATIONS.has(reply.association) &&
    Number.isInteger(reply.id) &&
    reply.id > 0 &&
    typeof reply.createdAt === "string" &&
    reply.createdAt.length > 0
  );
}

/** The identity a disposition is keyed to — the intention, never the fingerprint. */
export function dispositionKey(finding: {
  readonly ruleId: string;
  readonly path: string;
}): string {
  return `${finding.ruleId}\u0000${finding.path}`;
}

/**
 * Matches a parsed disposition against the previous run's findings.
 *
 * The path form matches the finding with the same path AND line. The line form
 * matches the findings with that line, but only when EXACTLY ONE finding has
 * it — two findings on the same line are ambiguous and must say which one they
 * mean, so the match is refused.
 */
function match(
  parsed: Parsed,
  previousFindings: readonly PreviousFinding[],
): readonly PreviousFinding[] {
  if (parsed.path !== null) {
    return previousFindings.filter((old) => old.path === parsed.path && old.line === parsed.line);
  }
  const onLine = previousFindings.filter((old) => old.line === parsed.line);
  return onLine.length === 1 ? onLine : [];
}

/** Builds the reply URL for one reply id, the same shape GitHub uses for an issue comment. */
function replyUrl(owner: string, repo: string, number: number, replyId: number): string {
  return `https://github.com/${owner}/${repo}/pull/${String(number)}#issuecomment-${String(replyId)}`;
}

/**
 * Derives fresh dispositions from the eligible replies on the owned thread.
 *
 * Every eligible reply is parsed strictly; every parsed disposition is matched
 * against the previous run's findings (the ones a human could have replied to);
 * every matched finding gets the disposition its line (or path+line) earned.
 * Multiple matching lines in one reply each produce a disposition for their own
 * finding's identity.
 */
export function readDispositions(
  replies: readonly ThreadReply[],
  previousFindings: readonly PreviousFinding[],
  at: { readonly owner: string; readonly repo: string; readonly number: number },
  prAuthorLogin: string,
): Map<string, Disposition> {
  const out = new Map<string, Disposition>();
  for (const reply of replies) {
    if (!isEligibleReply(reply, prAuthorLogin)) continue;
    const parsed = parseDispositionLine(reply.body);
    if (parsed === null) continue;
    for (const old of match(parsed, previousFindings)) {
      out.set(dispositionKey(old), {
        value: parsed.value,
        by: reply.login,
        at: reply.createdAt,
        replyId: reply.id,
        replyUrl: replyUrl(at.owner, at.repo, at.number, reply.id),
      });
    }
  }
  return out;
}

/**
 * Which envelope-stored dispositions are still substantiated by the thread.
 *
 * A disposition in the envelope is only a mirror of the reply that made it. On
 * a fresh read, a mirrored disposition survives only when its reply is still
 * among the eligible replies AND that reply still belongs to the same login —
 * the forged-envelope defence (a hostile bot or stranger copying the marker
 * cannot inject dispositions: their reply is not eligible, and a mirrored
 * disposition whose reply is gone or whose login changed is dropped).
 */
export function substantiatedDispositions(
  previousFindings: readonly PreviousFinding[],
  replies: readonly ThreadReply[],
  prAuthorLogin: string,
): Map<string, Disposition> {
  const byId = new Map<number, ThreadReply>();
  for (const reply of replies) {
    if (isEligibleReply(reply, prAuthorLogin)) byId.set(reply.id, reply);
  }
  const out = new Map<string, Disposition>();
  for (const old of previousFindings) {
    const disposition = old.disposition;
    if (disposition === null) continue;
    const reply = byId.get(disposition.replyId);
    if (reply?.login === disposition.by) {
      out.set(dispositionKey(old), disposition);
    }
  }
  return out;
}

/**
 * The merged disposition map for this run: fresh dispositions override, the
 * substantiated envelope mirror fills the gaps.
 */
export function mergeDispositions(
  fresh: Map<string, Disposition>,
  substantiated: Map<string, Disposition>,
): Map<string, Disposition> {
  const merged = new Map<string, Disposition>();
  for (const [key, disposition] of substantiated) merged.set(key, disposition);
  for (const [key, disposition] of fresh) merged.set(key, disposition);
  return merged;
}
