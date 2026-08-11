/**
 * The ballot a judge is handed when the candidates are translations.
 *
 * Everything about *how* a panel works — that every seat is asked rather than
 * rotated through, that the models within one seat are its availability and not
 * more votes, that a plurality decides, that the score breaks every tie, that
 * each seat sees the candidates in its own rotation so position bias is spread
 * rather than pooled — is the core's, and it is written down there. What is left
 * here is the only part that is about translation: the original, the numbered
 * drafts, and the criteria to rank them by.
 *
 * The criteria are the same ones `score` measures, in the same order of
 * importance, deliberately: a judge that ranked fluency over an untouched code
 * block would be overruling the measurement rather than adding to it. What a
 * judge is really being asked is the last criterion — the first three are there
 * so a draft that broke one cannot win on the last.
 */
import { enclose } from "../../core/enclose.js";
import { judge as runPanel, type JudgeRequest, type Verdict } from "../../core/judge.js";
import type { Language } from "../../core/languages.js";
import type { Message, Provider, Weather } from "../../core/provider.js";

import type { Attempt } from "./draft.js";

export type { Vote, Verdict } from "../../core/judge.js";

export interface TranslationJudgeRequest {
  readonly provider: Provider;
  /** One entry per seat, as `parseSeats` left them. Empty is the default, not an error. */
  readonly judges: readonly (readonly string[])[];
  /** The body being translated, as the thread wrote it. */
  readonly source: string;
  readonly to: Language;
  /**
   * The admitted drafts, best score first. Their text is sanitised, which the
   * source is not — but every draft carries the same markers, and this is a
   * comparison between drafts, so what they share cannot separate them.
   */
  readonly attempts: readonly Attempt[];
  /** This run's memory of capacity failures — see `core/provider.ts`'s `Weather`. */
  readonly weather?: Weather;
  /** Passed to every ballot. Omitted from the request when not set. */
  readonly temperature?: number;
}

export async function judge(request: TranslationJudgeRequest): Promise<Verdict<Attempt>> {
  const { provider, judges, source, to, attempts, weather, temperature } = request;

  const panel: JudgeRequest<Attempt> = {
    provider,
    judges,
    candidates: attempts,
    by: (attempt) => attempt.model,
    ballot: (shown) => ballot(source, to, shown),
    ...(weather === undefined ? {} : { weather }),
    ...(temperature === undefined ? {} : { temperature }),
  };

  return runPanel(panel);
}

/**
 * The instructions and the drafts, as one request.
 *
 * Everything the user message carries is fenced, and both halves need it for
 * different reasons. The original is a stranger's writing. The drafts are a
 * model's rewriting of a stranger's writing, which is the same text with one
 * more chance to have been reshaped — a draft is not more trustworthy than what
 * it came from. One fence around the pair rather than one each, because the
 * judge is comparing them and a rule stated twice reads as two rules.
 *
 * The `--- TRANSLATION n ---` separators are inside the fence and are forgeable
 * by anybody who writes one into an issue body. That is survivable rather than
 * fixed: a seat's answer is a number the core checks against the candidates it
 * actually shipped, so a forged separator can confuse a vote and cannot invent a
 * winner.
 */
function ballot(source: string, to: Language, shown: readonly Attempt[]): Message[] {
  const numbered = shown
    .map((attempt, at) => `--- TRANSLATION ${String(at + 1)} ---\n${attempt.text}`)
    .join("\n\n");
  const material = enclose("untrusted-thread", `--- ORIGINAL ---\n${source}\n\n${numbered}`);

  return [
    {
      role: "system",
      content: [
        `You are choosing the best ${to.label} (${to.code}) translation of a GitHub issue or`,
        `pull request body. You will be given the original and ${String(shown.length)} translations of it.`,
        "",
        "Judge in this order, and only reach a later point when the earlier ones tie:",
        "1. Every fenced code block and inline code span is reproduced character for character.",
        "2. Every URL and link destination is unchanged, and the headings, lists, tables and",
        "   blank lines are where the original has them.",
        "3. The prose says what the original says — nothing added, nothing left out, nothing",
        "   corrected, nothing summarised.",
        `4. It reads as ${to.label} someone would write, not as word-for-word substitution.`,
        "",
        `Answer with the number of the best translation — a single digit from 1 to ${String(shown.length)}.`,
        "Nothing else: no reasoning, no punctuation, no explanation.",
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}
