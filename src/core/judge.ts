/**
 * Choosing between candidates the deterministic score already admitted.
 *
 * A judge is the second opinion, never the first. Scoring has thrown out
 * everything provably wrong and ranked what is left on measurements a model
 * cannot argue with. What it cannot measure is whether an answer reads like
 * something a person would have written, and that is the only question left
 * here.
 *
 * The panel mechanics are the core's; the ballot is the duty's. This module
 * never knows what is being judged — only that there are candidates, that they
 * arrived in rank order, and that a judge answers with a number.
 *
 * **A judge is a voter, not a fallback.** `models` is a list to rotate through
 * until one answers; `judge-models` is a panel, and every member is asked. A
 * judge that fails or answers unusably loses its vote and the rest still
 * decide. Rotating instead would make the second judge a stand-in for the
 * first, and a panel of stand-ins is one judge with extra names.
 *
 * **The score breaks every tie.** With no judges configured, no vote cast, or
 * the panel split evenly, the ranking that came in decides. So a judge can only
 * ever move the winner when a plurality of the panel agrees to move it — which
 * is the safe direction for the setup Reeve is built for, where the judges are
 * the same free models that produced the drafts.
 *
 * **Position bias is real, so the panel does not all read the same order.**
 * Given a list of options a model favours the first one, and the list arrives
 * here in score order — so a panel that all saw it that way would mostly
 * re-elect the score and look like agreement. Judge `n` is handed the
 * candidates rotated to start at the `n`th, so across the panel each candidate
 * leads at least once and the bias is spread rather than pooled. The numbers a
 * judge answers with are positions in what it was shown, not the candidates'
 * own rank.
 *
 * **Nothing a candidate says is an instruction.** A candidate is model output
 * built from a stranger's thread, and it is pasted into a judge's prompt. The
 * duty's ballot says so, which is worth doing and is not a guarantee. The bound
 * that matters is structural: a judge answers with one number, and every number
 * it can answer with is a candidate the deterministic score already admitted.
 * The worst a successful injection achieves is a worse-ranked admitted answer,
 * never unadmitted text and never an action outside this choice.
 */
import type { Completion, Failure, Message, Provider } from "./provider.js";

/** One judge's usable answer. */
export interface Vote {
  /** The judge that cast it. */
  readonly model: string;
  /** The model whose candidate it picked. */
  readonly pick: string;
}

export interface Verdict<T> {
  /** The candidate to publish, or null when there was nothing to choose between. */
  readonly winner: T | null;
  /**
   * Which ranking settled it. `"score"` covers every way the panel did not:
   * none configured, none answered, or a tie.
   */
  readonly decidedBy: "score" | "judges";
  /** Every usable vote, in the order the panel was asked. */
  readonly votes: readonly Vote[];
  /** Every judge that failed or spoiled its ballot, with the reason. */
  readonly failures: readonly Failure[];
}

export interface JudgeRequest<T> {
  readonly provider: Provider;
  /** Judge model ids, as `parseModels` left them. Empty is the default, not an error. */
  readonly judges: readonly string[];
  /** The admitted candidates, best score first. */
  readonly candidates: readonly T[];
  /**
   * The model that produced a candidate, which is what a vote names. Two
   * candidates from the same model are indistinguishable to a tally, which is
   * why drafting prefers a different model per draft.
   */
  readonly by: (candidate: T) => string;
  /** The duty's ballot, given the candidates in the order this judge sees them. */
  readonly ballot: (shown: readonly T[]) => readonly Message[];
}

export async function judge<T>(request: JudgeRequest<T>): Promise<Verdict<T>> {
  const { provider, judges, candidates, by, ballot } = request;

  // One candidate is already the answer, and none means the work was skipped
  // before this. Asking which of one is best spends a request on a foregone
  // conclusion — the same request that mattered, on a free tier.
  const [leader] = candidates;
  if (leader === undefined || candidates.length < 2 || judges.length === 0) {
    return { winner: leader ?? null, decidedBy: "score", votes: [], failures: [] };
  }

  const votes: Vote[] = [];
  const failures: Failure[] = [];
  const tally = new Map<string, number>();

  for (const [seat, model] of judges.entries()) {
    // Rotated per seat, so the candidate the score put first does not lead
    // every ballot. The order is this judge's alone, and the number it answers
    // with is read back through the same order.
    const shown = rotated(candidates, seat);
    const answer = await provider.complete(model, ballot(shown));
    const counted = read(answer, shown, by);
    if (!counted.ok) {
      failures.push(counted);
      continue;
    }

    votes.push({ model, pick: counted.pick });
    tally.set(counted.pick, (tally.get(counted.pick) ?? 0) + 1);
  }

  // Walked in score order and taken on strictly more, so an even split leaves
  // the better-scoring candidate in front and needs no tie-break of its own.
  // With no votes at all every count is zero and the leader is never displaced,
  // which is the same rule rather than a special case.
  // Annotated rather than inferred: narrowing `leader` past the `undefined` the
  // destructuring gave it leaves `T & {}`, which a plain `T` cannot be assigned
  // back to.
  let elected: T = leader;
  for (const candidate of candidates) {
    if ((tally.get(by(candidate)) ?? 0) > (tally.get(by(elected)) ?? 0)) elected = candidate;
  }

  return { winner: elected, decidedBy: votes.length > 0 ? "judges" : "score", votes, failures };
}

/** The list starting at `start` and wrapping, leaving every entry present once. */
function rotated<T>(candidates: readonly T[], start: number): T[] {
  const at = start % candidates.length;
  return [...candidates.slice(at), ...candidates.slice(0, at)];
}

/** A standalone number, so `12` cannot be read as a vote for `1`. */
const NUMBER = /\d+/g;

/**
 * One completion turned into a vote, or into the reason it is not one.
 *
 * A truncated answer is not a failure here, unlike in drafting: the whole
 * answer is one digit, and a `length` finish means the model kept going after
 * it rather than that it stopped short. What it wrote is judged the same way
 * everything else is.
 *
 * **A ballot naming two different candidates is spoiled, not resolved.**
 * Reading the first number would pick right in "1 is better than 2" and wrong
 * in "not 1, so 2"; reading the last inverts both. The panel is a quorum, so
 * losing an unclear vote costs a vote, while guessing at one costs the answer —
 * and there is no reading of "the model named two candidates" that is evidence
 * for either.
 */
function read<T>(
  answer: Completion,
  shown: readonly T[],
  by: (candidate: T) => string,
): Failure | { ok: true; pick: string } {
  if (!answer.ok) return answer;

  // Resolved to the candidate as it is read, so a number outside the range is
  // not a vote at all rather than a vote for nothing. The number is a position
  // in what *this* judge was shown — the list rotated to its seat — and the
  // model id is what it means everywhere else.
  const named: T[] = [];
  for (const [digits] of answer.content.matchAll(NUMBER)) {
    const picked = shown[Number(digits) - 1];
    if (picked !== undefined && !named.includes(picked)) named.push(picked);
  }

  const [only] = named;
  if (only === undefined) {
    return {
      ok: false,
      model: answer.model,
      reason: `answered with no candidate number — ${excerpt(answer.content)}`,
    };
  }
  if (named.length > 1) {
    return {
      ok: false,
      model: answer.model,
      reason: `named more than one candidate — ${excerpt(answer.content)}`,
    };
  }

  return { ok: true, pick: by(only) };
}

/** How much of an unusable answer reaches the log. */
const EXCERPT_CHARS = 120;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
}
