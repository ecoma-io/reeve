/**
 * The one stage of this duty that talks to a model: whether a candidate BM25
 * turned up is genuinely the same problem as the thread in front of it, or
 * merely a thread that shares some words with it.
 *
 * BM25 answers "which candidates share vocabulary with this thread", which is
 * a different question from "which of them describe the same bug" — a
 * candidate about a crash on export and a candidate about a crash on import
 * share most of their nouns and are not duplicates of each other. This stage
 * is what tells the two apart, and it is asked about a shortlist rather than
 * the whole corpus for the reason judging elsewhere in Reeve is asked about a
 * shortlist rather than every label: it is the expensive step, so only what
 * ranking already thought plausible reaches it.
 *
 * **Unreadable output is no verdict**, the same rule `triage/verdict.ts`
 * follows and for the same reason: the shapes that fail to parse are the
 * shapes an injection produced, and a best-effort parse of the parts that
 * looked fine is most lenient exactly when it should be strictest. A
 * `duplicate_of` naming a candidate that was never on the shortlist is
 * treated the same way — not clamped, not resolved against the corpus,
 * discarded — because a model that answers with a number nobody offered it
 * has answered a different question than the one asked.
 *
 * **A model is rotated past, never retried**, for the same reason
 * `triage/verdict.ts` does not retry: quota, a decommissioned id and an
 * outage do not clear inside one run.
 */
import { enclose } from "../../core/enclose.js";
import { unfenced } from "../../core/markdown.js";
import type { Failure, Message, Provider, Weather } from "../../core/provider.js";
import { askWhole } from "../../core/provider.js";
import { rotateModels } from "../../core/provider.js";
import type { Candidate } from "./rank.js";

/** What the model decided, before the confidence floor has been checked. */
export interface Verdict {
  /** The candidate it thinks this repeats, or null. Always one of the candidates offered. */
  readonly duplicateOf: number | null;
  /** Its own confidence, 0 to 1. Compared against the floor by the caller. */
  readonly confidence: number;
  /** One sentence, for the log and for the comment when the run may leave one. */
  readonly rationale: string;
}

/**
 * The answer when no model reached one — every model failed, what came back
 * did not parse, or there was nothing to judge in the first place.
 */
export const NOTHING: Verdict = { duplicateOf: null, confidence: 0, rationale: "" };

export interface JudgeRequest {
  readonly provider: Provider;
  /** Model ids in preference order. */
  readonly models: readonly string[];
  readonly title: string;
  /** The body, already truncated to the run's own limit. */
  readonly body: string;
  /** What the language stage decided, or null. Told rather than inferred. */
  readonly language: string | null;
  /** The shortlist a rank produced, closest first. Never the whole corpus. */
  readonly candidates: readonly Candidate[];
  /** This run's memory of capacity failures — see `core/provider.ts`'s `Weather`. */
  readonly weather?: Weather;
}

export interface Judged {
  readonly verdict: Verdict;
  /** Every model that failed, in the order tried. */
  readonly failures: readonly Failure[];
  /**
   * The answer that could not be read, when one came back and did not parse.
   * Null when every model failed, when there was nothing to judge, or when
   * the verdict parsed.
   */
  readonly unreadable: string | null;
  /**
   * The model that actually answered, whether or not its answer parsed —
   * `null` only when every model failed or there was nothing to judge. The
   * comment's attribution footer names this, not the roster's first entry,
   * because rotation means the model that answered is not always the one
   * `models` lists first.
   */
  readonly model: string | null;
}

/** How much of each candidate's body reaches the prompt. Enough to judge, not a second copy of it. */
const EXCERPT = 1000;

export async function judge(request: JudgeRequest): Promise<Judged> {
  const { provider, models, weather, candidates } = request;
  // Nothing to ask about is not a failure — it is the ordinary answer for a
  // thread whose corpus (after `corpus-limit`/`corpus-since`) or whose rank
  // (after `candidates`) came back empty, and asking a model to choose among
  // zero options would spend a request to learn what was already known.
  if (candidates.length === 0) {
    return { verdict: NOTHING, failures: [], unreadable: null, model: null };
  }

  const messages = prompt(request);
  const rotation = await rotateModels(
    models,
    (model) => askWhole(provider, model, messages),
    weather,
  );
  if (!rotation.success) {
    return { verdict: NOTHING, failures: rotation.failures, unreadable: null, model: null };
  }

  const verdict = parseVerdict(rotation.success.content, candidates);
  return {
    verdict: verdict ?? NOTHING,
    failures: rotation.failures,
    unreadable: verdict === null ? rotation.success.content : null,
    model: rotation.success.model,
  };
}

/**
 * The answer, or null when it is not a verdict.
 *
 * `candidates` is what makes this stricter than `triage/verdict.ts`'s own
 * `duplicate_of` check: there, any positive integer is a plausible issue
 * number because the whole repository is in scope. Here, the model was shown
 * a specific shortlist and asked to pick from it, so an answer naming
 * anything else — a number it invented, a number from outside the shortlist
 * it was shown — is exactly as unreadable as a malformed field, not a claim
 * worth resolving against the corpus after the fact.
 */
export function parseVerdict(answer: string, candidates: readonly Candidate[]): Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced(answer));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;

  const duplicate = fields.duplicate_of ?? null;
  if (duplicate !== null) {
    if (!Number.isInteger(duplicate)) return null;
    if (!candidates.some((candidate) => candidate.number === duplicate)) return null;
  }

  const confidence = fields.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;

  const rationale = fields.rationale ?? "";
  if (typeof rationale !== "string") return null;

  return {
    duplicateOf: duplicate as number | null,
    confidence,
    rationale: rationale.trim(),
  };
}

/**
 * The instructions, the shortlist, and the thread behind a fence.
 *
 * The shortlist is untrusted the same way the thread is — every title and
 * excerpt on it was written by whoever opened that issue — so both go inside
 * the one boundary rather than the shortlist being treated as this duty's own
 * text because BM25, not a stranger, chose to include it.
 */
function prompt(request: JudgeRequest): Message[] {
  const { title, body, language, candidates } = request;

  const material = enclose(
    "untrusted-thread",
    [
      "--- THREAD TO CHECK ---",
      `TITLE: ${title}`,
      "BODY:",
      body,
      "",
      "--- CANDIDATES ALREADY OPEN, RANKED BY SHARED WORDS ---",
      ...candidates.map(
        (candidate) =>
          `#${String(candidate.number)}: ${candidate.title}\n${excerpt(candidate.body)}`,
      ),
    ].join("\n"),
  );

  return [
    {
      role: "system",
      content: [
        "You are checking whether a new GitHub issue repeats one already open on the same",
        "repository. The candidates below were found by shared vocabulary, which is not the same",
        "thing as being the same problem — judge whether they actually describe the same bug or",
        "request, not merely similar words.",
        "",
        language === null
          ? "The thread's language could not be identified from the languages this project reads."
          : `The thread is written in ${language}. Judge it as well as you would judge the same report in any other language.`,
        "",
        "Answer with one JSON object and nothing else — no prose, no explanation:",
        "",
        '{"duplicate_of": null, "confidence": 0.0, "rationale": ""}',
        "",
        "- `duplicate_of`: the number of the one candidate above that is genuinely the same",
        "  problem, chosen only from the numbers listed, or `null` when none of them are.",
        "  Sharing words is not enough — the two have to describe the same bug or request.",
        "- `confidence`: 0 to 1, how sure you are of that answer.",
        "- `rationale`: one sentence, in the language of the thread.",
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}

function excerpt(body: string): string {
  return body.length <= EXCERPT ? body : `${body.slice(0, EXCERPT)}…`;
}
