/**
 * Which of a set of candidate languages a text is written in.
 *
 * **The candidate set is handed in.** This module reads no configuration and
 * decides nothing about which languages are worth telling apart — a caller asks
 * about the languages its answer would actually differ between, and the answer
 * is only ever as fine-grained as that question. Whether a German issue is
 * German or Dutch changes nothing for a project configured for English,
 * Vietnamese and Chinese: all three are still owed, so paying a model to
 * separate them would buy nothing.
 *
 * That is what makes this a closed-set question, and what lets the cheap steps
 * come first. **"None of them" is a real answer rather than a failure**, and
 * what it means is the caller's to decide.
 *
 * Four steps, each only reached when the one before it did not decide:
 *
 *   1. **Residue.** Everything written the same in every language is blanked
 *      first — code, URLs, identifiers. An issue body is prose interleaved with
 *      stack traces and package names, nearly all of which argue for English no
 *      matter what the prose around them says.
 *   2. **Script.** Eliminate every candidate whose scripts are absent from the
 *      residue. Free, exact, and derived entirely from the candidates given.
 *   3. **Profile.** Byte-ngram identification over what is left, restricted to
 *      those candidates. Local, so it costs no request and no key — which is
 *      the point: for a repository whose threads are mostly already in the base
 *      language, the common run reaches a decision without contacting a
 *      provider at all. This is the one step with a fixed list of languages:
 *      the bundled dataset is `eld/small`'s `S60`, and a candidate code outside
 *      those 60 sends the whole text to step 4 — see `detectByProfile`.
 *   4. **The model.** Only when the three cheap steps did not decide, and only
 *      ever to choose between candidates the caller already named. Choosing one
 *      of a handful of listed languages is an enum answer, which is the one
 *      thing a weak model does reliably — the same reason judging is shaped
 *      that way. A duty never reaches this: the language stage runs before a
 *      duty is invoked and hands it the answer, `unknown` included.
 */
import { eld } from "eld/small";

import { enclose } from "./enclose.js";
import { findLanguage, type Language } from "./languages.js";
import { segments } from "./markdown.js";
import type { Message, Provider } from "./provider.js";
import { rotateModels } from "./provider.js";
import { containsScript } from "./script.js";

// The library ships a cleanup step of its own, and it is deliberately off:
// `residue` below does the same work in time the text can be trusted with.
eld.enableTextCleanup(false);

/** How a detection was reached. `none` is the outcome, not an error. */
export type DetectedBy = "script" | "profile" | "model" | "none";

export interface Detection {
  readonly language: Language | null;
  readonly by: DetectedBy;
  /**
   * What survived script narrowing — the set a model was, or would have been,
   * asked to choose from. Worth reporting because a run that reached the model
   * with six candidates and a run that reached it with two are not the same
   * kind of uncertain.
   */
  readonly candidates: readonly Language[];
}

/**
 * Asks a model which of `candidates` wrote `text`, returning a language code or
 * `null` when it could not say.
 *
 * A code outside `candidates` is not this function's problem to reject — the
 * caller does that, in one place, so a model that answers with a language
 * nobody listed cannot become the answer.
 */
export type LanguagePicker = (
  text: string,
  candidates: readonly Language[],
) => Promise<string | null>;

export async function detectLanguage(
  text: string,
  languages: readonly Language[],
  pick?: LanguagePicker,
): Promise<Detection> {
  // Every step below reads the residue rather than the body. Narrowing on the
  // raw text makes a Chinese issue a candidate for English because it quoted a
  // stack trace, and that candidate then survives to cost a model request.
  const prose = residue(text);

  const candidates = languages.filter((language) =>
    language.scripts.some((script) => containsScript(prose, script)),
  );

  // No configured script occurs in the text at all. That is not a detector
  // failing; it is a thread with no prose in it — a stack trace, a diff, a
  // screenshot and a version number. There is nothing here to identify.
  if (candidates.length === 0) return { language: null, by: "none", candidates };

  const [only] = candidates;
  if (candidates.length === 1 && only) return { language: only, by: "script", candidates };

  const profiled = detectByProfile(prose, candidates);
  if (profiled) return { language: profiled, by: "profile", candidates };

  if (pick) {
    const picked = await pick(prose, candidates);
    // Resolved against the candidates rather than the full list: a model asked
    // to choose from two languages does sometimes answer with a third, and that
    // answer has to die here rather than travel on as a detection.
    const resolved = picked === null ? undefined : findLanguage(candidates, picked);
    if (resolved) return { language: resolved, by: "model", candidates };
  }

  return { language: null, by: "none", candidates };
}

/**
 * The third step, backed by a model — step 1 and step 2 need nothing but the
 * text, and this needs a provider, which is why it is handed in rather than
 * reached for.
 *
 * The models are a rotation, not a panel: unlike judging, there is a fact of
 * the matter here and a second opinion on it adds nothing a vote could settle.
 * Every model failing is `null`, which is a detection nobody reached — the same
 * answer as a model that would not choose, and the caller treats it the same
 * way.
 *
 * An answer naming two of the candidates is discarded rather than resolved, for
 * the reason a spoiled ballot is: "Vietnamese, not Chinese" and "not
 * Vietnamese, Chinese" carry the same codes in the same order and opposite
 * answers, and guessing costs a wrong source language where discarding costs a
 * step that had two more behind it.
 */
export function createLanguagePicker(
  provider: Provider,
  models: readonly string[],
): LanguagePicker {
  return async (text, candidates) => {
    const rotation = await rotateModels(models, (model) =>
      provider.complete(model, question(text, candidates)),
    );
    if (!rotation.success) return null;
    const { content } = rotation.success;

    const named = candidates.filter((language) => spells(content, language.code));
    const [only] = named;
    return named.length === 1 && only ? only.code : null;
  };
}

/**
 * The question, with the body fenced.
 *
 * The stakes here are lower than at drafting — the worst an answer can do is
 * name the wrong language, and the caller discards anything that names two — but
 * the fence costs a call to `randomBytes` and closes the same door. A body that
 * talked the detector into answering `en` would send an English thread through
 * a translation into English, which is a wasted run rather than a breach; a body
 * that talked it into answering nothing at all is the same as a body it could
 * not identify. Neither is worth leaving open when the boundary is this cheap.
 */
function question(text: string, candidates: readonly Language[]): Message[] {
  const codes = candidates.map((language) => `${language.code} (${language.label})`).join(", ");
  const body = enclose("untrusted-thread", text);

  return [
    {
      role: "system",
      content: [
        "You identify which language the body of a GitHub issue or pull request is written in.",
        `Answer with exactly one of these codes: ${codes}.`,
        "Answer with the code alone: no reasoning, no punctuation, no explanation.",
        "",
        body.rule,
      ].join("\n"),
    },
    { role: "user", content: body.block },
  ];
}

/**
 * Whether an answer names this code, as a token rather than as a substring.
 *
 * `en` occurs inside `then` and `zh` inside `zh-Hans`, so a plain search would
 * read a model's prose as a vote and would read one candidate's code as
 * another's. A configured code is whatever a workflow file wrote, so it is
 * escaped before it becomes a pattern.
 */
function spells(answer: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "i").test(answer);
}

/**
 * Byte-ngram identification, restricted to `candidates`.
 *
 * Returns `null` rather than a guess in the two cases that matter, and they are
 * different failures:
 *
 * - **A candidate the profile data does not cover.** The bundled data knows 60
 *   languages; a workflow may list a code it has never heard of, or a regional
 *   tag like `pt-BR`. Its answer would then be the best of an incomplete set —
 *   confidently naming a language because the real one was not on the ballot.
 *   Handing the whole question to the model is the only honest move, and it
 *   costs a request rather than a wrong translation.
 * - **Its own confidence check failing.** Measured on issue-shaped text, the
 *   check flags every miss caused by a missing language and roughly a third of
 *   the misses caused by text too short to identify — so it is a filter worth
 *   having and not a guarantee. The step after this one exists for the rest.
 */
function detectByProfile(prose: string, candidates: readonly Language[]): Language | null {
  const codes = candidates.map((language) => language.code.toLowerCase());

  // The subset is module-global state inside the library, so it is set and
  // cleared around a single call. The clear on the way in is what makes this
  // call correct whatever ran before it; the clear in `finally` is what stops
  // this call from restricting anything that runs after — including, in a
  // backfill, the next several hundred threads.
  eld.setLanguageSubset(false);
  try {
    // All or nothing, deliberately. `setLanguageSubset` answers with the codes
    // it recognised, and it silently drops the rest — a regional tag like
    // `pt-BR` is not `pt` to it, and a language outside the bundled 60 is not
    // there at all. Restricting to the survivors would answer a question
    // nobody asked: "which of these three is it, assuming it is not the fourth"
    // is a confident wrong answer whenever the fourth is the right one. So one
    // unrecognised candidate declines the step for every candidate, and the
    // model is asked about the full set instead.
    const accepted = new Set(Object.values(eld.setLanguageSubset(codes)));
    if (codes.some((code) => !accepted.has(code))) return null;

    const result = eld.detect(prose);
    if (!result.language || !result.isReliable()) return null;
    return findLanguage(candidates, result.language) ?? null;
  } finally {
    eld.setLanguageSubset(false);
  }
}

/**
 * The prose residue: the text with everything that is written the same in every
 * language blanked out.
 *
 * Issue bodies are not prose. They are prose interleaved with stack traces, log
 * output, file paths, package names, command lines and version numbers, and
 * nearly all of it is Latin-looking noise that argues for English no matter
 * what the prose around it says — and none of it is what the author chose.
 *
 * Code goes first and goes wholesale. A fenced block is code because its author
 * fenced it; the words inside it are not evidence about the language they were
 * typed next to, and a body that is nine tenths log output would otherwise be
 * identified from the log. The segmenter already knows where code begins and
 * ends, so this is a reuse rather than a second opinion.
 *
 * The patterns that follow are the library's own cleanup step, which is
 * deliberately switched off. It is redone here because one of its four patterns
 * cannot be run on text a stranger wrote: bare domains are matched with
 * `([A-Za-z0-9-]+.)+com(…)`, whose inner dot is unescaped, so every character
 * that is not a domain can be divided between the two quantifiers in another
 * way and the engine tries all of them. Measured against the library's own
 * expression, on prose that matches nothing: 20 characters take 0.2 ms, 24 take
 * 1.2 ms, 30 take 22 ms — a factor of 1.65 per character. A single comment
 * outlives the job, and the text comes from whoever opened the issue, which
 * makes it a denial of service rather than a slow path.
 *
 * Every pattern below is linear instead: each is anchored on a literal, and no
 * character can be consumed by two quantifiers, so there is nothing to
 * backtrack over. They run in order, because an e-mail address contains a bare
 * domain and a URL contains both.
 *
 * Blanked to a space rather than deleted. Nothing downstream reads a position
 * in this string, and a space is what keeps the words on either side of a
 * removed URL from becoming one ngram that neither of them is.
 */
const NOISE: readonly RegExp[] = [
  // A URL, with a scheme or with the bare `www.` people write instead.
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi,
  // An e-mail address.
  /[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi,
  // A domain nobody wrote a scheme for.
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi,
  // A version, a hash, an error number, an id: a run of characters that is only
  // a word because a digit is standing in it.
  /[a-z]*[0-9][a-z0-9]*/gi,
];

export function residue(text: string): string {
  let clean = segments(text)
    .map((segment) => (segment.kind === "prose" ? segment.text : " "))
    .join("");
  for (const pattern of NOISE) clean = clean.replace(pattern, " ");
  return clean;
}
