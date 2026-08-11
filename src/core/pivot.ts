/**
 * Translating a thread's title and text into the memory's pivot language.
 *
 * The store is lexical: it matches on shared words, so a correction recorded
 * on an English thread cannot be found by a Vietnamese one describing the
 * same problem, and no amount of prompt engineering at recall time fixes
 * that — there is nothing shared to rank on. A pivot language is the bridge.
 * Recording a correction also renders its title and excerpt into the pivot
 * language, and recalling for a thread in a different language does the same
 * to the query; both sides then share a common tongue for BM25 to match on,
 * without either language ever being taught the other's taxonomy.
 *
 * **One draft, no judging.** This is not `translate`'s deliverable — a
 * maintainer never reads this text — it is an accuracy booster sitting behind
 * cross-language recall, and its failure mode is "recall runs on the
 * thread's own language alone", which costs nothing but a little precision.
 * That is the same shape as language detection, and this module follows
 * `createLanguagePicker`'s contract rather than `draft.ts`'s: a single
 * rotation across `models`, and `null` on any failure — every model rotated
 * past, or an answer that did not come back shaped the way it was asked for.
 * It never throws over an ordinary translation failure.
 */
import { enclose } from "./enclose.js";
import type { Language } from "./languages.js";
import {
  rotateModels,
  type Completion,
  type Message,
  type Provider,
  type Weather,
} from "./provider.js";
import { sanitize } from "./sanitize.js";

/** A title and body, translated. */
export interface PivotDraft {
  readonly title: string;
  readonly body: string;
}

export interface PivotRequest {
  readonly provider: Provider;
  readonly models: readonly string[];
  readonly title: string;
  readonly body: string;
  /** The language to translate into — the run's pivot language. */
  readonly to: Language;
  readonly weather?: Weather;
}

/**
 * Translates `title` and `body` into `to`, or answers `null`.
 *
 * The output passes through `sanitize` before it is returned, the same as
 * every other piece of model-generated prose this codebase stores or
 * publishes — a pivot rendering is written straight into a committed file,
 * and a translated `@mention` or `#123` in it is exactly as live as one
 * `draft.ts` produces.
 */
export async function translateToPivot(request: PivotRequest): Promise<PivotDraft | null> {
  const { provider, models, title, body, to, weather } = request;

  const messages = prompt(title, body, to);
  const rotation = await rotateModels(
    models,
    (model) => answer(provider, model, messages),
    weather,
  );
  if (!rotation.success) return null;

  const draft = readAnswer(unwrapped(rotation.success.content));
  if (draft === null) return null;

  return { title: sanitize(draft.title), body: sanitize(draft.body) };
}

/**
 * One completion, with a truncated rendering reported as the failure it is —
 * the same rule `draft.ts` follows for the same reason. `finish_reason:
 * length` means the model ran out of room before the JSON closed, which
 * reads as unparseable rather than merely short, and rotation's next model
 * may have more room to give it. Left unchecked, that failure would look
 * identical to an ordinary unreadable answer — this is what tells the two
 * apart in the one place that can still do something about it.
 */
async function answer(
  provider: Provider,
  model: string,
  messages: readonly Message[],
): Promise<Completion> {
  const completion = await provider.complete(model, messages);
  if (completion.ok && completion.finishReason === "length") {
    return {
      ok: false,
      model,
      kind: "protocol",
      reason: "the rendering was cut off before it finished",
    };
  }
  return completion;
}

/**
 * The request, with the thread's text fenced the same way every other prompt
 * that carries one does — a translation call is still a call that puts a
 * stranger's words in front of a model, and the boundary costs nothing extra
 * to keep here.
 */
function prompt(title: string, body: string, to: Language): Message[] {
  const enclosed = enclose("untrusted-thread", `${title}\n\n${body}`);

  return [
    {
      role: "system",
      content: [
        `Translate the title and body of a GitHub thread into ${to.label} (${to.code}).`,
        "Preserve Markdown formatting, code blocks and links exactly; translate prose only.",
        "Answer with exactly one JSON object and nothing else, shaped like this:",
        '{"title": "...", "body": "..."}',
        "No preamble, no code fence around the JSON, no explanation before or after it.",
        "",
        enclosed.rule,
      ].join("\n"),
    },
    { role: "user", content: enclosed.block },
  ];
}

/** Strips a code fence around the answer, when a model added one despite being asked not to. */
function unwrapped(answer: string): string {
  const trimmed = answer.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fence?.[1] ?? trimmed;
}

/**
 * The answer, parsed — or `null` for anything that is not the two strings
 * asked for. Unreadable output is discarded rather than best-effort-parsed,
 * the same rule the triage verdict itself follows and for the same reason:
 * the shapes that fail to parse are the shapes an injection produced.
 */
function readAnswer(text: string): PivotDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  if (typeof record.title !== "string" || typeof record.body !== "string") return null;
  if (record.title.trim().length === 0) return null;

  return { title: record.title, body: record.body };
}
