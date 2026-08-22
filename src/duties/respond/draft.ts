/**
 * The one stage of this duty that talks to a model to write prose, and the only
 * one whose answer is treated as a suggestion.
 *
 * This is `triage/verdict.ts`'s shape, not `translate/draft.ts`'s: the answer is
 * strict JSON, not free prose, because a first reply carries a confidence a
 * later stage has to compare against a floor (`respond`'s `confidence` input),
 * and a model that never says how sure it is cannot be held to one. Unreadable
 * output is discarded whole, the same as a triage verdict — the one indulgence
 * is a whole answer wrapped in a single code fence, a model packaging its
 * answer rather than saying something else.
 *
 * **The taxonomy and the guidance file both go in the system message, and
 * neither is fenced.** They are trusted-side by construction: the taxonomy is
 * read from the warrant file a maintainer wrote, and the guidance file is read
 * from a repo-relative path a maintainer wrote to and that is reviewed like any
 * other file in the tree (D8 — only a repository's own maintainers may address
 * the model as an instruction). The thread and the recalled corrections quote
 * strangers, so both go inside one `enclose()` boundary together, exactly as
 * `triage/verdict.ts` does it.
 *
 * **A model is rotated past, never retried**, and rotation continues across
 * drafts: `drafts` asks for independent attempts, not `drafts` retries of the
 * same one, so a model already known to be down this run is skipped for every
 * remaining draft rather than paid for again.
 */
import { enclose } from "../../core/enclose.js";
import { unfenced } from "../../core/markdown.js";
import type { Correction } from "../../core/memory.js";
import type { Failure, Message, Provider, Weather } from "../../core/provider.js";
import { askWhole } from "../../core/provider.js";
import { rotateModels } from "../../core/provider.js";
import { sanitize } from "../../core/sanitize.js";
import type { Label } from "../../core/warrant.js";

/** One model's attempt at a first reply. */
export interface Attempt {
  readonly model: string;
  /** Sanitized Markdown, ready to publish as written. */
  readonly text: string;
  /** The model's own confidence, 0 to 1. Compared against the floor by the caller. */
  readonly confidence: number;
}

export interface Draft {
  /** Every attempt that parsed, best `confidence` first. Empty is a real outcome. */
  readonly attempts: readonly Attempt[];
  /** Every model that failed outright, in the order tried. */
  readonly failures: readonly Failure[];
  /** Answers that came back and did not parse, one entry per such answer. */
  readonly unreadable: readonly string[];
}

export interface DraftRequest {
  readonly provider: Provider;
  /** Model ids in preference order, as `parseModels` left them. */
  readonly models: readonly string[];
  readonly title: string;
  /** The body, already truncated to the workflow's limit. */
  readonly body: string;
  /** What the language stage decided, or null. Told rather than inferred. */
  readonly language: string | null;
  /** The labels already standing on the thread, described the way the taxonomy describes them. */
  readonly standing: readonly Label[];
  /** The nearest maintainer decisions, closest first. Empty is the cold start. */
  readonly recalled: readonly Correction[];
  /** The maintainer-authored guidance file's text, or null when there is none. Trusted-side. */
  readonly guidance: string | null;
  /** How many independent attempts to draft. */
  readonly drafts: number;
  readonly weather?: Weather;
}

export async function draft(request: DraftRequest): Promise<Draft> {
  const { provider, models, drafts, weather } = request;
  const messages = prompt(request);

  const attempts: Attempt[] = [];
  const failures: Failure[] = [];
  const unreadable: string[] = [];
  // Seeded from `weather`, so a model an earlier stage already grounded for
  // capacity is treated as exhausted from draft zero rather than being asked
  // once more here before this call catches up with what the run already
  // knows — and rather than logging a second `draft:` warning for a model
  // this run has already given up on. Mirrors `translate/draft.ts`.
  const exhausted = new Set<string>(weather?.starved ?? []);

  for (let at = 0; at < drafts; at += 1) {
    const order = remaining(models, at, exhausted);
    if (order.length === 0) break;

    const rotation = await rotateModels(
      order,
      (model) => askWhole(provider, model, messages),
      weather,
    );
    for (const failure of rotation.failures) exhausted.add(failure.model);
    failures.push(...rotation.failures);
    if (!rotation.success) continue;

    const parsed = parseAttempt(rotation.success.content);
    if (parsed === null) {
      unreadable.push(rotation.success.content);
      continue;
    }
    attempts.push({
      model: rotation.success.model,
      text: sanitize(parsed.text),
      confidence: parsed.confidence,
    });
  }

  return {
    attempts: [...attempts].sort((left, right) => right.confidence - left.confidence),
    failures,
    unreadable,
  };
}

/**
 * The roster for one draft: the full list rotated to start after the last
 * draft's pick, with every model exhausted so far removed.
 *
 * The same rotation `translate/draft.ts` uses, so a run asking for several
 * drafts spreads them across the roster instead of hammering the first model
 * `drafts` times while the rest sit idle.
 */
function remaining(
  models: readonly string[],
  at: number,
  exhausted: ReadonlySet<string>,
): string[] {
  const live = models.filter((model) => !exhausted.has(model));
  if (live.length === 0) return [];
  const start = at % live.length;
  return [...live.slice(start), ...live.slice(0, start)];
}

/**
 * The answer, or null when it is not a draft.
 *
 * Every field is checked for the type it has to be, and one wrong field
 * discards the whole answer rather than the field — the same discipline as
 * `triage/verdict.ts`'s `parseVerdict`, for the same reason: a reply this
 * module could read but a confidence it could not is an answer that came
 * apart, and the half that survived is not more trustworthy for having parsed.
 */
export function parseAttempt(answer: string): { text: string; confidence: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced(answer));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;

  const text = fields.text;
  if (typeof text !== "string" || text.trim().length === 0) return null;

  const confidence = fields.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;

  return { text: text.trim(), confidence };
}

export function prompt(request: DraftRequest): Message[] {
  const { title, body, language, standing, recalled, guidance } = request;

  const material = enclose(
    "untrusted-thread",
    [
      ...(recalled.length === 0 ? [] : [examples(recalled), ""]),
      "--- THREAD TO ANSWER ---",
      `TITLE: ${title}`,
      "BODY:",
      body,
    ].join("\n"),
  );

  return [
    {
      role: "system",
      content: [
        "You are writing the first reply to a new issue on a GitHub repository — no maintainer",
        "has answered it yet. Acknowledge what the author wrote and ground your answer in what",
        "this project already knows, rather than a generic acknowledgement that could belong to",
        "any project.",
        "",
        language === null
          ? "The thread's language could not be identified from the languages this project reads. Answer in English."
          : `The thread is written in ${language}. Answer in ${language}.`,
        "",
        ...(standing.length === 0
          ? []
          : [
              "LABELS ALREADY ON THIS THREAD, and what they mean to this project:",
              "",
              ...standing.map(describe),
              "",
            ]),
        ...(guidance === null
          ? []
          : [
              "MAINTAINER GUIDANCE for how to write this reply, from this project's own maintainers.",
              "Follow it as instruction, the same as every other sentence in this system message:",
              "",
              guidance.trim(),
              "",
            ]),
        "Do not fabricate a fix, a timeline, or a promise this project has not made. When you do",
        "not know, say so and point at what would help — reproduction steps, a version, a minimal",
        "example — rather than guessing.",
        "",
        "Answer with one JSON object and nothing else — no prose, no explanation:",
        "",
        '{"text": "...", "confidence": 0.0}',
        "",
        "- `text`: the reply, in Markdown, in the language named above.",
        "- `confidence`: 0 to 1, how confident you are this reply is worth posting as written.",
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}

/** One label, as the maintainer wrote it. Same rendering as `triage/verdict.ts`'s `describe`. */
function describe(label: Label): string {
  const lines = [`- ${label.name}: ${label.description}`];
  if (label.not !== null) lines.push(`  NOT: ${label.not}`);
  return lines.join("\n");
}

/**
 * The recalled decisions, as grounding rather than as a taxonomy to apply.
 *
 * `decided` carries the authority a reply should build on; `note`, when a
 * maintainer left one, is often the sentence a good first reply would say
 * itself — pointing at it is how a cold model ends up sounding like this
 * project instead of like every other project's bot.
 */
function examples(recalled: readonly Correction[]): string {
  const written = recalled.map((correction) => {
    const lines = [
      `#${String(correction.thread)}: ${correction.title}`,
      `  DECIDED: ${correction.decided.length === 0 ? "no labels" : correction.decided.join(", ")}`,
    ];
    if (correction.note !== null) lines.push(`  WHY: ${correction.note}`);
    return lines.join("\n");
  });

  return ["--- DECISIONS THIS PROJECT ALREADY MADE ---", ...written].join("\n");
}
