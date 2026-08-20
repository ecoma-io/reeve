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
 * **A seat is a voter; the models inside it are that voter's availability.**
 * `judge-models` is a panel — `a | b | c` is three votes and every one of them
 * is asked, where `models` would have stopped at the first answer. Rotating the
 * panel instead would make the second judge a stand-in for the first, and a
 * panel of stand-ins is one judge with extra names.
 *
 * A seat may still name more than one model, written `a, b` — the same `,`
 * that means fallback in `models` means fallback here. That is not a second
 * vote and never becomes one: `b` is asked only when `a` could not deliver the
 * seat's vote at all, and the seat casts one ballot either way. The
 * distinction is worth the syntax because the two things fail differently — a
 * panel is about disagreement, and a chain is about a free tier being out of
 * quota at nine in the morning.
 *
 * **A seat rotates past a model that answered as readily as one that did not.**
 * A judge asked for a single digit that replies "both are good" has spent a
 * request and produced nothing, which is what the next model in the seat is
 * for. The alternative — spend the request, lose the vote, leave the fallback
 * untouched — treats "the provider was down" and "the model would not answer
 * the question" as different kinds of silence, and to the panel they are the
 * same kind.
 *
 * **One model casts one vote, whatever the seats say.** A model that has
 * already voted, and a model that has already failed, are both skipped by every
 * later seat. Without that, `a, b | b, c` is two seats that both resolve to
 * `b` on the morning `a` is rate-limited, and a plurality counted over one
 * model answering twice is not a plurality. A seat whose every model is spoken
 * for casts nothing and says so.
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
import type { Completion, Failure, Message, Provider, Weather } from "./provider.js";
import { reckon, weatherFailure } from "./provider.js";

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
  /**
   * One entry per seat, each the models that seat may be filled by in
   * preference order, as `parseSeats` left them. Empty is the default, not an
   * error.
   */
  readonly judges: readonly (readonly string[])[];
  /** The admitted candidates, best score first. */
  readonly candidates: readonly T[];
  /**
   * The model that produced a candidate, named for a vote's own attribution —
   * `Vote.pick`, and nothing the tally below uses. Two candidates from the
   * same model are the ordinary case once `drafts` can ask for more attempts
   * than there are models to spread across, so the tally keys on each
   * candidate's own identity rather than on this: a vote for the second of
   * two same-model drafts is never folded into a vote for the first.
   */
  readonly by: (candidate: T) => string;
  /** The duty's ballot, given the candidates in the order this judge sees them. */
  readonly ballot: (shown: readonly T[]) => readonly Message[];
  /**
   * This run's memory of capacity failures. A seat's chain is filtered through
   * it the same way `rotateModels` filters a rotation, so a model that ran out
   * of room drafting is not asked to judge either.
   */
  readonly weather?: Weather;
}

export async function judge<T>(request: JudgeRequest<T>): Promise<Verdict<T>> {
  const { provider, judges, candidates, by, ballot, weather } = request;

  // One candidate is already the answer, and none means the work was skipped
  // before this. Asking which of one is best spends a request on a foregone
  // conclusion — the same request that mattered, on a free tier.
  const [leader] = candidates;
  if (leader === undefined || candidates.length < 2 || judges.length === 0) {
    return { winner: leader ?? null, decidedBy: "score", votes: [], failures: [] };
  }

  const votes: Vote[] = [];
  const failures: Failure[] = [];
  // Keyed on each candidate's own identity — the object `draft` built for it,
  // never a string derived from it — so two candidates from the same model
  // are two entries here, not one. Keying on `by(candidate)` instead would
  // fold a vote for the second of two same-model drafts into a vote for the
  // first, silently losing it the moment `drafts` exceeds the roster.
  const tally = new Map<T, number>();
  // Every model an earlier seat has finished with, whichever way it finished.
  // One set rather than two: "already voted" and "already failed" are different
  // reasons and the same instruction — do not ask this model again.
  const spent = new Set<string>();

  for (const [seat, chain] of judges.entries()) {
    const order = chain.filter((model) => !spent.has(model));
    if (order.length === 0) {
      const collapsed = exhausted(chain);
      if (collapsed !== null) failures.push(collapsed);
      continue;
    }

    // Rotated per seat, so the candidate the score put first does not lead
    // every ballot. The order is this seat's alone, and the number its judge
    // answers with is read back through the same order.
    const shown = rotated(candidates, seat);
    const cast = await fill(provider, order, shown, ballot, weather);

    for (const failure of cast.failures) {
      spent.add(failure.model);
      failures.push(failure);
    }
    if (cast.vote === null) continue;

    spent.add(cast.vote.model);
    votes.push({ model: cast.vote.model, pick: by(cast.vote.candidate) });
    tally.set(cast.vote.candidate, (tally.get(cast.vote.candidate) ?? 0) + 1);
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
    if ((tally.get(candidate) ?? 0) > (tally.get(elected) ?? 0)) elected = candidate;
  }

  return { winner: elected, decidedBy: votes.length > 0 ? "judges" : "score", votes, failures };
}

/**
 * What one seat produced: at most one vote, and everything it rotated past.
 *
 * `candidate` rather than a string here — the tally in `judge` keys on this
 * object's own identity, and a `pick` string is only ever derived from it at
 * the point a public `Vote` is built, for attribution.
 */
interface Cast<T> {
  readonly vote: { readonly model: string; readonly candidate: T } | null;
  readonly failures: readonly Failure[];
}

/**
 * One seat filled: the first of its models that delivers a vote.
 *
 * The same shape as `rotateModels` and deliberately not a call to it, because
 * the two stop on different things. Rotation stops at a usable *completion*; a
 * seat stops at a usable *vote*, and the gap between them is a model that
 * answered the question it was not asked. Passing that stricter predicate into
 * the shared helper would mean returning the completion and reading it a second
 * time to recover the choice, which is a worse trade than four lines.
 */
async function fill<T>(
  provider: Provider,
  order: readonly string[],
  shown: readonly T[],
  ballot: (shown: readonly T[]) => readonly Message[],
  weather?: Weather,
): Promise<Cast<T>> {
  const failures: Failure[] = [];

  for (const model of order) {
    if (weather?.grounded(model) === true) {
      failures.push(weatherFailure(model));
      continue;
    }

    const counted = read(await provider.complete(model, ballot(shown)), shown);
    if (counted.ok) return { vote: { model, candidate: counted.candidate }, failures };
    reckon(counted, weather);
    failures.push(counted);
  }

  return { vote: null, failures };
}

/**
 * A seat every one of whose models an earlier seat already spoke for.
 *
 * Reported rather than skipped quietly: a panel that was configured as three
 * votes and cast two is a thing the maintainer who wrote the configuration
 * needs to see, and the run it happens on is the one where a model was rate
 * limited — which is exactly when nobody is watching for it.
 */
function exhausted(chain: readonly string[]): Failure | null {
  const [primary] = chain;
  if (primary === undefined) return null;

  return {
    ok: false,
    model: primary,
    kind: "protocol",
    reason:
      "seat cast nothing — every model it names had already been asked by an earlier seat, " +
      "so counting it again would be one model voting twice",
  };
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
function read<T>(answer: Completion, shown: readonly T[]): Failure | { ok: true; candidate: T } {
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
      kind: "protocol",
      reason: `answered with no candidate number — ${excerpt(answer.content)}`,
    };
  }
  if (named.length > 1) {
    return {
      ok: false,
      model: answer.model,
      kind: "protocol",
      reason: `named more than one candidate — ${excerpt(answer.content)}`,
    };
  }

  return { ok: true, candidate: only };
}

/** How much of an unusable answer reaches the log. */
const EXCERPT_CHARS = 120;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
}
