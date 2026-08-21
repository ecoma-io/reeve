/**
 * Turning one body into one language, as many times as the workflow asked.
 *
 * This is where the `drafts` input is spent. It is the quality lever available
 * to a repository whose menu has no stronger model on it: ask more than once,
 * measure every answer, and keep the ones worth ranking. Everything here is
 * arranged around that being affordable, because the setup it is for is the one
 * paying nothing per request.
 *
 * **A model is exhausted for the whole language, not for one draft.** The
 * provider rotates past a model that fails and never retries it, on the grounds
 * that quota, a decommissioned id and an outage do not clear inside a run. That
 * reasoning does not stop at the edge of a draft: a model that answered with a
 * quota error on the first draft will answer with one on the second. So the
 * failures are remembered across drafts, and the second draft starts from a
 * shorter list than the first.
 *
 * **Diversity comes from the model list before it comes from anywhere else.**
 * Draft `n` prefers the `n`th configured model. Two drafts from two models
 * disagree in ways two drafts from one model at a provider's default sampling
 * may not, and the disagreement is the entire value of asking twice. When only
 * one model is configured, the second draft is the same model asked again —
 * worth knowing, and worth saying in the log rather than in a thread nobody
 * reads.
 *
 * **An answer cut off mid-sentence is a failed model, not a poor draft.** The
 * provider reports `finish_reason` without acting on it, because a truncated
 * one-token choice is fine and a truncated translation is not. Here it is not
 * fine, so it is turned into the failure it is and the next model gets the
 * work.
 */
import { enclose } from "../../core/enclose.js";
import type { GlossaryEntry } from "../../core/glossary.js";
import type { Language } from "../../core/languages.js";
import { segments } from "../../core/markdown.js";
import type { Completion, Failure, Message, Provider, Weather } from "../../core/provider.js";
import { rotateModels } from "../../core/provider.js";
import { sanitize } from "../../core/sanitize.js";
import type { Score } from "../../core/score.js";

import { score } from "./score.js";

/** One answer, measured and made safe to publish. */
export interface Attempt {
  /** The model that produced it. */
  readonly model: string;
  /** The translation, unwrapped and sanitized — ready to be published. */
  readonly text: string;
  readonly score: Score;
}

export interface Translation {
  readonly to: Language;
  /**
   * Every admitted attempt, best score first. Empty when no model produced a
   * draft that could be admitted, which is a language skipped rather than a run
   * failed.
   */
  readonly attempts: readonly Attempt[];
  /**
   * The attempts scoring refused, in the order they were produced. Kept because
   * "three models all answered in the source language" is a configuration
   * problem the log has to be able to state, and it is invisible if a refused
   * draft is simply dropped.
   */
  readonly refused: readonly Attempt[];
  /** Every model that failed, across all drafts, in the order tried. */
  readonly failures: readonly Failure[];
}

export interface TranslateRequest {
  readonly provider: Provider;
  /** Model ids in preference order, as `parseModels` left them. */
  readonly models: readonly string[];
  /** The body to translate, already truncated to the workflow's limit. */
  readonly source: string;
  /** The detected source language, or null when detection reached no answer. */
  readonly from: Language | null;
  readonly to: Language;
  /**
   * Every configured language, which scoring needs in full: a script that has
   * leaked into a draft can only be named against a script somebody asked for.
   */
  readonly languages: readonly Language[];
  /** How many answers to ask for. Fewer are produced when the models run out. */
  readonly drafts: number;
  /**
   * The terms this project keeps in one spelling — `.reeve/glossary.yml`, read
   * once per run and handed down. Absent means the same as empty, which is the
   * common case: most repositories have no protected terms.
   *
   * Named in the prompt and then measured by `score`, exactly as every other
   * rule here is. The list is repository configuration, committed by a
   * maintainer, so it goes into the system message beside the rules rather than
   * into the fenced user message beside the stranger's text.
   */
  readonly glossary?: readonly GlossaryEntry[];
  /**
   * This run's memory of capacity failures, seeded here and updated as drafts
   * are attempted — so a model already grounded by an earlier thread's draft,
   * or by this thread's own first draft, starts every later draft off the
   * list rather than being asked again to fail the same way.
   */
  readonly weather?: Weather;
}

export async function translate(request: TranslateRequest): Promise<Translation> {
  const { provider, models, source, from, to, languages, drafts, weather } = request;
  // Absent and empty mean the same thing here, and the difference is settled
  // once: the prompt and the score are held to the same list, so a draft can
  // never be asked for a term it will not be measured on.
  const glossary = request.glossary ?? [];
  const messages = prompt(source, from, to, glossary);

  const attempts: Attempt[] = [];
  const refused: Attempt[] = [];
  const failures: Failure[] = [];
  // Seeded from `weather`, so a model an earlier thread already grounded for
  // capacity is treated as exhausted from draft zero rather than being asked
  // once more here before this call catches up with what the run already
  // knows.
  const exhausted = new Set<string>(weather?.starved ?? []);

  for (let draft = 0; draft < drafts; draft += 1) {
    const order = remaining(models, draft, exhausted);
    // Every model has failed. Asking for the next draft would be asking nobody.
    if (order.length === 0) break;

    const rotation = await rotateModels(
      order,
      (model) => answer(provider, model, messages),
      weather,
    );
    for (const failure of rotation.failures) {
      exhausted.add(failure.model);
      failures.push(failure);
    }
    if (!rotation.success) break;

    const draftText = unwrapped(rotation.success.content, source);
    // Measured against the source as the thread wrote it, and against the answer
    // as the model wrote it — the honest comparison. Scoring the sanitized text
    // instead would hold a draft carrying Reeve's own defang markers up
    // against a source that has none, and charge the draft for the difference.
    const measured = await score({ source, draft: draftText, from, to, languages, glossary });
    (measured.admissible ? attempts : refused).push({
      model: rotation.success.model,
      text: sanitize(draftText),
      score: measured,
    });
  }

  return {
    to,
    attempts: [...attempts].sort((left, right) => right.score.value - left.score.value),
    refused,
    failures,
  };
}

/**
 * The models still worth asking, in the order this draft prefers them.
 *
 * The rotation starts at the `draft`th model and wraps, so consecutive drafts
 * come from different models wherever the list is long enough to offer one.
 */
function remaining(
  models: readonly string[],
  draft: number,
  exhausted: ReadonlySet<string>,
): string[] {
  const live = models.filter((model) => !exhausted.has(model));
  // No guard for an empty list: `0 % 0` is NaN, `slice(NaN)` is `slice(0)`, and
  // both halves of an empty array are empty. A branch that can only ever return
  // what the line below already returns is a branch nothing can test.
  const start = draft % live.length;
  return [...live.slice(start), ...live.slice(0, start)];
}

/**
 * One completion, with a truncated answer reported as the failure it is.
 *
 * `finish_reason: length` means the model stopped because it ran out of room,
 * so the translation ends mid-sentence. Posting that is worse than posting
 * nothing, and the next model may have more room — which is exactly what
 * rotation is for.
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
      reason: "the answer was cut off before it finished",
    };
  }
  return completion;
}

/**
 * The instructions, which are as much about what not to touch as what to do.
 *
 * Every formatting rule below exists because a cheap model breaks it, and every
 * one of them is also measured afterwards — the prompt asks, and `score`
 * checks. A prompt is the wrong place to be certain about anything.
 *
 * The boundary is the exception, and it is deliberate. The body is whatever a
 * stranger typed into an issue, and it arrives here whole; this is the prompt
 * where that matters most, because the answer to it is what gets published into
 * the thread. It is also the one rule nothing downstream can measure — "was this
 * prose written by the author or by an instruction the author embedded?" is not
 * a fact about the string. The fence is drawn fresh for every call, so it cannot
 * be closed by text somebody wrote before the run started; what holds regardless
 * is structural: whatever comes back is refused unless it is a real translation,
 * defanged before it is kept, and published only inside the block below the
 * marker this duty owns — never over the author's own words.
 *
 * **The prompt is rebuilt for every language, not shared across them.** The
 * nonce is per call by construction, and reusing one built once per run would
 * quietly turn it back into a fixed delimiter for the length of that run.
 *
 * **The glossary is not fenced, and that is not an oversight.** The boundary
 * exists because the body is whatever a stranger typed; the glossary is a file a
 * maintainer committed to the repository, read at the ref that triggered the
 * run, and it is the same tier of trust as these instructions themselves. What
 * it must never be is part of the user message, where a term would sit next to
 * the untrusted body and read as text to translate rather than as a rule.
 */
function prompt(
  source: string,
  from: Language | null,
  to: Language,
  glossary: readonly GlossaryEntry[],
): Message[] {
  const origin = from === null ? "" : ` from ${from.label}`;
  const body = enclose("untrusted-thread", source);

  return [
    {
      role: "system",
      content: [
        `You translate GitHub issue and pull request content${origin} into ${to.label} (${to.code}).`,
        "",
        "Answer with the translation and nothing else. No preamble, no notes, no",
        "explanation of what you did, no code fence wrapped around the whole answer, and",
        "no boundary tags — those are the envelope, not part of what you translate.",
        "",
        "Keep the Markdown exactly as it is:",
        "- Reproduce every fenced block and inline code span character for character.",
        "  The words inside them are code, not prose, even when they read like prose.",
        "- Leave every URL and link destination alone. Translate the link text only.",
        "- Keep headings, lists, tables and blank lines where they are.",
        "- Leave @mentions, #123 references, commit hashes, file paths, command names,",
        "  version numbers and product names as they are written.",
        ...glossarySection(glossary),
        "",
        "Translate the prose faithfully. Do not summarise it, do not expand on it, and",
        "do not correct the author.",
        "",
        body.rule,
      ].join("\n"),
    },
    { role: "user", content: body.block },
  ];
}

/**
 * The terms this project keeps in one spelling, as lines of the system message —
 * or nothing at all, which is what most repositories get.
 *
 * The instruction says every language rather than this one, because a body being
 * translated into three languages is three separate calls and the term has to
 * come back the same way in all of them. The note beside a term is the
 * maintainer's own sentence about why it is on the list: a model told that
 * `weather` names provider capacity here, and not the sky, has what it needs to
 * leave it alone in a sentence where translating it would otherwise read as
 * obviously right.
 */
function glossarySection(glossary: readonly GlossaryEntry[]): string[] {
  if (glossary.length === 0) return [];

  return [
    "",
    "This project keeps these terms in one spelling. Reproduce each of them exactly as",
    "written, in every language — never translated, transliterated or inflected:",
    ...glossary.map(({ term, note }) =>
      note === undefined || note.length === 0 ? `- ${term}` : `- ${term} — ${note}`,
    ),
  ];
}

/**
 * A whole answer wrapped in one fence, unwrapped.
 *
 * A model asked for Markdown routinely hands back ```` ```markdown ```` around
 * everything, which posts as a page of source instead of a translation.
 * `sanitize` deliberately leaves this alone, because from the answer by itself
 * the model's packaging and the source's own code block are the same text. Here
 * the source is in hand, so the question is answerable: it is packaging only if
 * the source was not itself a single fenced block.
 */
function unwrapped(answer: string, source: string): string {
  const trimmed = answer.trim();
  const wrapper = onlyFence(trimmed);
  if (wrapper === null || onlyFence(source.trim()) !== null) return answer;

  // The fence's own first and last lines: the opener carrying the info string,
  // and the closer.
  const lines = wrapper.split("\n");
  return lines.slice(1, -1).join("\n");
}

/** The text when it is one fenced block and nothing else, or null. */
function onlyFence(markdown: string): string | null {
  const parts = [...segments(markdown)];
  const [only] = parts;
  return parts.length === 1 && only?.kind === "fence" ? only.text : null;
}
