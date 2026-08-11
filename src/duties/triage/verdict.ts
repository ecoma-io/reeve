/**
 * The one stage of this duty that talks to a model, and the only one whose
 * answer is treated as a suggestion.
 *
 * What comes back from here is a proposal. Nothing in this module checks
 * whether a proposed label exists, whether the run may apply it, or whether a
 * maintainer already decided otherwise — that is `enforce`'s work, and it is
 * deliberately somewhere else. Validation performed inside the function that
 * built the prompt drifts toward trusting the prompt: it has the request in
 * scope, it knows what it asked for, and one refactor later it is checking the
 * model's claim about its own permissions.
 *
 * **Unreadable output is an empty verdict.** Not a best-effort parse of the
 * parts that looked fine — the shapes that fail to parse are the shapes an
 * injection produced, so an optimistic parser is most lenient at exactly the
 * moment it should be strictest. The one indulgence is a whole answer wrapped
 * in a code fence, which is a model packaging its answer rather than a model
 * saying something else.
 *
 * **The taxonomy goes in the system message and is never translated.** The
 * `description` and `not` a maintainer wrote are the authority in whatever
 * language they wrote them in; putting a machine paraphrase between a decision
 * and its enforcement would make the taxonomy mean something nobody chose.
 *
 * **A model is rotated past, never retried.** Quota, a decommissioned id and an
 * outage do not clear inside one run, and retrying spends the budget of the
 * model that would have worked.
 */
import { enclose } from "../../core/enclose.js";
import type { Correction } from "../../core/memory.js";
import { segments } from "../../core/markdown.js";
import type { Failure, Message, Provider, Weather } from "../../core/provider.js";
import { rotateModels } from "../../core/provider.js";
import type { Label } from "../../core/warrant.js";

/** What the model proposed, before anything has been checked against the file. */
export interface Verdict {
  /** Labels it named. Whether they exist is not this module's question. */
  readonly labels: readonly string[];
  /** Its own confidence, 0 to 1. Compared against the floor by the caller. */
  readonly confidence: number;
  /** A thread this one appears to repeat, or null. Reported; acted on only under `close`. */
  readonly duplicateOf: number | null;
  /** One sentence, for the log and for a comment when the run may leave one. */
  readonly rationale: string;
}

/**
 * The answer when no model reached one — every model failed, or what came back
 * did not parse.
 *
 * A real value rather than `null` at the call site, because every stage below
 * behaves identically in the two cases: propose nothing, apply nothing, and say
 * why in the report. The distinction between them is a warning, not a branch.
 */
export const NOTHING: Verdict = { labels: [], confidence: 0, duplicateOf: null, rationale: "" };

export interface TriageRequest {
  readonly provider: Provider;
  /** Model ids in preference order, as `parseModels` left them. */
  readonly models: readonly string[];
  readonly title: string;
  /** The body, already truncated to the workflow's limit. */
  readonly body: string;
  /** The taxonomy, in the order the warrant wrote it. That order reaches the prompt. */
  readonly taxonomy: readonly Label[];
  /** What the language stage decided, or null. Told rather than inferred. */
  readonly language: string | null;
  /** The nearest maintainer decisions, closest first. Empty is the cold start. */
  readonly recalled: readonly Correction[];
  /** This run's memory of capacity failures — see `core/provider.ts`'s `Weather`. */
  readonly weather?: Weather;
}

export interface Triaged {
  readonly verdict: Verdict;
  /** Every model that failed, in the order tried. */
  readonly failures: readonly Failure[];
  /**
   * The answer that could not be read, when one came back and did not parse.
   * Null when every model failed or when the verdict parsed. The caller warns
   * with it, because a model answering in prose every run is a configuration
   * problem invisible in a green run.
   */
  readonly unreadable: string | null;
}

export async function triage(request: TriageRequest): Promise<Triaged> {
  const { provider, models, weather } = request;
  const messages = prompt(request);

  const rotation = await rotateModels(
    models,
    (model) => provider.complete(model, messages),
    weather,
  );
  if (!rotation.success) {
    return { verdict: NOTHING, failures: rotation.failures, unreadable: null };
  }

  const verdict = parseVerdict(rotation.success.content);
  return {
    verdict: verdict ?? NOTHING,
    failures: rotation.failures,
    unreadable: verdict === null ? rotation.success.content : null,
  };
}

/**
 * The answer, or null when it is not a verdict.
 *
 * Every field is checked for the type it has to be, and one wrong field
 * discards the whole answer rather than the field. A verdict with labels this
 * module could read and a confidence it could not is an answer that came apart
 * somewhere, and the half that survived is not more trustworthy for having
 * parsed.
 */
export function parseVerdict(answer: string): Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped(answer));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;

  const labels = fields.labels;
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) return null;

  const confidence = fields.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;

  const duplicate = fields.duplicate_of ?? null;
  // `0` is not an issue number and neither is `12.5`. A model that answered
  // with one has answered with something other than a reference to a thread.
  if (duplicate !== null && (!Number.isInteger(duplicate) || (duplicate as number) < 1)) {
    return null;
  }

  const rationale = fields.rationale ?? "";
  if (typeof rationale !== "string") return null;

  return {
    // Trimmed, because a model that answered `" bug"` means `bug` and GitHub
    // does not. Empty entries are dropped rather than refused: they are the
    // model padding a list, not the answer coming apart.
    labels: labels.map((label) => (label as string).trim()).filter((label) => label.length > 0),
    confidence,
    duplicateOf: duplicate as number | null,
    rationale: rationale.trim(),
  };
}

/**
 * A whole answer wrapped in one fence, unwrapped.
 *
 * A model asked for JSON hands back ```` ```json ```` around it often enough
 * that refusing the answer would be refusing the model rather than the content.
 * This is the only reshaping done before parsing, and it is safe in a way a
 * "find the first `{`" scan is not: it accepts an answer that is one fenced
 * block and nothing else, so an answer carrying prose beside the JSON is still
 * unreadable — which is what an answer carrying prose beside the JSON is.
 */
function unwrapped(answer: string): string {
  const parts = segments(answer.trim());
  const [only] = parts;
  if (parts.length !== 1 || only?.kind !== "fence") return answer;

  const lines = only.text.split("\n");
  return lines.slice(1, -1).join("\n");
}

/**
 * The instructions, the taxonomy, the examples, and the thread behind a fence.
 *
 * Three kinds of text with three different authorities, and the prompt is
 * arranged around telling them apart:
 *
 * - **The taxonomy** is the maintainer's, read from a file in their repository.
 *   It is instruction, and it is in the system message.
 * - **The recalled corrections** are decisions maintainers made, but they quote
 *   the threads those decisions were made on, and those were written by
 *   strangers. So they go inside the fence with the thread.
 * - **The thread** is whatever anybody typed. Fenced, under a boundary drawn
 *   for this call from randomness, because this repository is public and a
 *   fixed delimiter is one anybody can read and close.
 *
 * The `--- ... ---` separators inside the fence are forgeable by anyone who
 * writes one into an issue body. That is survivable rather than fixed: a
 * forged example can bias a verdict and cannot invent an outcome, because
 * every label the verdict names is checked against the warrant file afterwards
 * and a name that is not in the file is dropped.
 */
export function prompt(request: TriageRequest): Message[] {
  const { title, body, taxonomy, language, recalled } = request;

  const material = enclose(
    "untrusted-thread",
    [
      ...(recalled.length === 0 ? [] : [examples(recalled), ""]),
      "--- THREAD TO TRIAGE ---",
      `TITLE: ${title}`,
      "BODY:",
      body,
    ].join("\n"),
  );

  const names = taxonomy.map((label) => label.name);

  return [
    {
      role: "system",
      content: [
        "You are triaging an issue on a GitHub repository. Decide which of this project's",
        "labels apply to it.",
        "",
        language === null
          ? "The thread's language could not be identified from the languages this project reads."
          : `The thread is written in ${language}. Judge it as well as you would judge the same report in any other language.`,
        "",
        "THE LABELS, which are this project's own and are the only ones that exist:",
        "",
        ...taxonomy.map(describe),
        "",
        "Answer with one JSON object and nothing else — no prose, no explanation:",
        "",
        '{"labels": [], "confidence": 0.0, "duplicate_of": null, "rationale": ""}',
        "",
        `- \`labels\`: the ones that apply, chosen from exactly these names: ${names.join(", ")}.`,
        "  An empty list is a real answer. Propose nothing rather than the closest thing.",
        "- `confidence`: 0 to 1, how sure you are of the labels as a set.",
        "- `duplicate_of`: the number of an issue this repeats, or null. Only when an example",
        "  above says so; do not guess a number.",
        "- `rationale`: one sentence, in the language of the thread.",
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}

/** One label, as the maintainer wrote it. */
function describe(label: Label): string {
  const lines = [`- ${label.name}: ${label.description}`];
  if (label.not !== null) lines.push(`  NOT: ${label.not}`);
  if (label.examples.length > 0) {
    lines.push(...label.examples.map((example) => `  e.g. ${example}`));
  }
  return lines.join("\n");
}

/**
 * The recalled decisions, as the examples they are.
 *
 * `decided` and not `proposed` carries the authority: what a maintainer settled
 * on is the answer, and what was proposed at the time is shown beside it only
 * when the two differ, because a correction where they differ is teaching
 * something a correction where they agree is not.
 */
function examples(recalled: readonly Correction[]): string {
  const written = recalled.map((correction) => {
    const lines = [
      `#${String(correction.thread)}: ${correction.title}`,
      `  DECIDED: ${correction.decided.length === 0 ? "no labels" : correction.decided.join(", ")}`,
    ];
    if (differs(correction)) {
      lines.push(
        `  (proposed at the time: ${correction.proposed.length === 0 ? "no labels" : correction.proposed.join(", ")})`,
      );
    }
    if (correction.note !== null) lines.push(`  WHY: ${correction.note}`);
    return lines.join("\n");
  });

  return ["--- DECISIONS THIS PROJECT ALREADY MADE ---", ...written].join("\n");
}

function differs(correction: Correction): boolean {
  const decided = [...correction.decided].sort();
  const proposed = [...correction.proposed].sort();
  return decided.length !== proposed.length || decided.some((name, at) => name !== proposed[at]);
}
