/**
 * The ballot a judge is handed when the candidates are harmonisation drafts.
 *
 * Everything about *how* a panel works — that every seat is asked rather than
 * rotated through, that the models within one seat are its availability and not
 * more votes, that a plurality decides, that the score breaks every tie, that
 * each seat sees the candidates in its own rotation so position bias is spread
 * rather than pooled — is the core's, and it is written down there. What is
 * left here is the only part that is about harmonisation: the original target
 * content, the numbered drafts, and the criteria to rank them by.
 *
 * The criteria mirror what `scoreDraft` measures, deliberately: a judge that
 * ranked fluency over an untouched code block would be overruling the
 * measurement rather than adding to it. What a judge is really being asked is
 * the last criterion — the first three are there so a draft that broke one
 * cannot win on the last.
 */
import { enclose } from "../../core/enclose.js";
import { judge as runPanel, type JudgeRequest, type Verdict } from "../../core/judge.js";
import type { Language } from "../../core/languages.js";
import type { Message, Provider, Weather } from "../../core/provider.js";

import type { Draft } from "./draft.js";

export type { Vote, Verdict } from "../../core/judge.js";

export interface HarmoniseJudgeRequest {
  readonly provider: Provider;
  /** One entry per seat, as `parseSeats` left them. Empty is the default. */
  readonly judges: readonly (readonly string[])[];
  /** The target locale's current content (what the drafts are updating). */
  readonly targetContent: string;
  /** The target language. */
  readonly to: Language;
  /**
   * The admitted drafts, best score first. Their text is sanitised, which the
   * target content is not — but every draft carries the same markers, and this
   * is a comparison between drafts, so what they share cannot separate them.
   */
  readonly attempts: readonly Draft[];
  /** This run's memory of capacity failures. */
  readonly weather?: Weather;
}

export async function judge(request: HarmoniseJudgeRequest): Promise<Verdict<Draft>> {
  const { provider, judges, targetContent, to, attempts, weather } = request;

  const panel: JudgeRequest<Draft> = {
    provider,
    judges,
    candidates: attempts,
    by: (draft) => draft.model,
    ballot: (shown) => ballot(targetContent, to, shown),
    ...(weather === undefined ? {} : { weather }),
  };

  return runPanel(panel);
}

/**
 * The instructions and the drafts, as one request.
 *
 * Everything the user message carries is fenced, and both halves need it for
 * different reasons. The target content is a stranger's writing (it came from
 * the repository). The drafts are a model's rewriting of a stranger's writing,
 * which is the same text with one more chance to have been reshaped. One fence
 * around the pair rather than one each, because the judge is comparing them
 * and a rule stated twice reads as two rules.
 */
function ballot(targetContent: string, to: Language, shown: readonly Draft[]): Message[] {
  const numbered = shown
    .map((draft, at) => `--- HARMONISATION ${String(at + 1)} ---\n${draft.text}`)
    .join("\n\n");
  const material = enclose(
    "untrusted-target",
    `--- CURRENT TARGET ---\n${targetContent}\n\n${numbered}`,
  );

  return [
    {
      role: "system",
      content: [
        `You are choosing the best harmonisation of a ${to.label} (${to.code}) translation.`,
        `You will be given the current target content and ${String(shown.length)} updated versions of it.`,
        "",
        "Judge in this order, and only reach a later point when the earlier ones tie:",
        "1. Every fenced code block and inline code span is reproduced character for character.",
        "2. Every URL and link destination is unchanged, and the headings, lists, tables and",
        "   blank lines are where the current target has them.",
        "3. The semantic changes from the source are correctly incorporated — nothing added",
        "   that was not in the changes, nothing left out that was.",
        `4. It reads as ${to.label} someone would write, not as word-for-word substitution.`,
        "",
        `Answer with the number of the best harmonisation — a single digit from 1 to ${String(shown.length)}.`,
        "Nothing else: no reasoning, no punctuation, no explanation.",
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}
