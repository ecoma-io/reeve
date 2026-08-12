/**
 * The ballot a judge is handed when the candidates are first replies.
 *
 * Everything about *how* a panel works — that every seat is asked rather than
 * rotated through, that the models within one seat are its availability and
 * not more votes, that a plurality decides, that `confidence` breaks every
 * tie, that each seat sees the candidates in its own rotation so position bias
 * is spread rather than pooled — is the core's, and it is written down there.
 * What is left here is the only part that is about a first reply: the thread,
 * the numbered drafts, and the criteria to rank them by.
 *
 * The criteria are ordered so a draft cannot win by being pleasant to read
 * while promising something this project never promised.
 */
import { enclose } from "../../core/enclose.js";
import { judge as runPanel, type JudgeRequest, type Verdict } from "../../core/judge.js";
import type { Message, Provider, Weather } from "../../core/provider.js";

import type { Attempt } from "./draft.js";

export type { Vote, Verdict } from "../../core/judge.js";

export interface ReplyJudgeRequest {
  readonly provider: Provider;
  /** One entry per seat, as `parseSeats` left them. Empty is the default, not an error. */
  readonly judges: readonly (readonly string[])[];
  readonly title: string;
  /** The body, already truncated to the workflow's limit. */
  readonly body: string;
  /** The admitted drafts, best confidence first. */
  readonly attempts: readonly Attempt[];
  /** This run's memory of capacity failures — see `core/provider.ts`'s `Weather`. */
  readonly weather?: Weather;
  /** Passed to every ballot. Omitted from the request when not set. */
  readonly temperature?: number;
}

export async function judge(request: ReplyJudgeRequest): Promise<Verdict<Attempt>> {
  const { provider, judges, title, body, attempts, weather, temperature } = request;

  const panel: JudgeRequest<Attempt> = {
    provider,
    judges,
    candidates: attempts,
    by: (attempt) => attempt.model,
    ballot: (shown) => ballot(title, body, shown),
    ...(weather === undefined ? {} : { weather }),
    ...(temperature === undefined ? {} : { temperature }),
  };

  return runPanel(panel);
}

/**
 * The thread and the drafts, as one request.
 *
 * One fence around both rather than one each: the judge is comparing the
 * drafts against the thread, and a rule stated twice reads as two rules. The
 * `--- REPLY n ---` separators are inside the fence and forgeable by anybody
 * who writes one into an issue body — survivable rather than fixed, because a
 * seat's answer is a number the core checks against the candidates it shipped,
 * so a forged separator can confuse a vote and cannot invent a winner.
 */
function ballot(title: string, body: string, shown: readonly Attempt[]): Message[] {
  const numbered = shown
    .map((attempt, at) => `--- REPLY ${String(at + 1)} ---\n${attempt.text}`)
    .join("\n\n");
  const material = enclose(
    "untrusted-thread",
    `--- THREAD ---\nTITLE: ${title}\nBODY:\n${body}\n\n${numbered}`,
  );

  return [
    {
      role: "system",
      content: [
        `You are choosing the best of ${String(shown.length)} draft first replies to a GitHub issue.`,
        "You will be given the thread and the drafts.",
        "",
        "Judge in this order, and only reach a later point when the earlier ones tie:",
        "1. It does not fabricate a fix, a timeline, or a promise this project has not made.",
        "2. It is grounded in what this specific thread actually says, not a reply that could",
        "   belong to any issue.",
        "3. It is written in the language the thread was written in.",
        "4. It reads as a maintainer would write it, not as a form letter.",
        "",
        `Answer with the number of the best reply — an integer from 1 to ${String(shown.length)}.`,
        "Nothing else: no reasoning, no punctuation, no explanation.",
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}
