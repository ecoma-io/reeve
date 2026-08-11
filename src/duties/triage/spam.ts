/**
 * The half of the screen that needs judgment, asked of the cheapest model
 * available.
 *
 * Code decides the screens that are about how much was written — an empty body,
 * a blank form, four words and no evidence. Whether a thread is spam or is
 * about something else entirely is not a measurement, and a regular expression
 * for it is a filter against the phrasings somebody already thought of: wrong
 * in both directions, dropping a blunt report and passing polite spam. So it is
 * a model, and it is deliberately the small one — the decision is binary and the
 * input is short, which is the shape a weak model is reliable on.
 *
 * **This stage fails open, and that asymmetry is the whole design.** Passing
 * junk through costs one expensive request. Dropping a real report costs a
 * contributor the answer they came for, silently, on the run that would have
 * given it to them. So every model failing, an answer nobody can read, and an
 * answer that hedges all mean the same thing: carry on.
 *
 * **Nothing here is authoritative about content.** A `spam` answer stops this
 * run and applies no label, closes nothing and says nothing on the thread. The
 * worst a manipulated answer can achieve is a run that did nothing, which is
 * this duty's designed failure mode anyway.
 */
import { enclose } from "../../core/enclose.js";
import type { Failure, Message, Provider } from "../../core/provider.js";
import { rotateModels } from "../../core/provider.js";

/** What the cheap pass can conclude. Anything else is `keep`, which is not a value. */
export type Judgement = "spam" | "off-topic";

export interface SiftRequest {
  readonly provider: Provider;
  /** The cheap roster. Empty means this stage is off, which is the default. */
  readonly models: readonly string[];
  readonly title: string;
  readonly body: string;
  /**
   * What this repository is about, in the maintainer's own words. Empty is
   * allowed and turns the off-topic half into a question the model answers
   * from the title alone — which is why it is worth writing.
   */
  readonly about: string;
}

export interface Sifted {
  /** Why the run stops here, or null to carry on. */
  readonly dropped: { readonly reason: Judgement; readonly note: string } | null;
  readonly failures: readonly Failure[];
}

export async function sift(request: SiftRequest): Promise<Sifted> {
  const { provider, models } = request;
  if (models.length === 0) return { dropped: null, failures: [] };

  const rotation = await rotateModels(models, (model) => provider.complete(model, prompt(request)));
  // Every cheap model failing is not a reason to skip the thread. It is a
  // reason to spend the expensive one, which is what the run was going to do
  // before this stage existed.
  if (!rotation.success) return { dropped: null, failures: rotation.failures };

  return { dropped: read(rotation.success.content), failures: rotation.failures };
}

/**
 * The answer, as a token rather than as a substring.
 *
 * A model that wrote a sentence has not answered this question, and `keep` is
 * what a sentence gets. Matched with a boundary so `off-topic` in a rationale
 * the model was not asked for does not become a verdict, and so `spam` inside
 * `spammer` does not either.
 */
function read(answer: string): Sifted["dropped"] {
  const said = (word: string): boolean =>
    new RegExp(`(?<![a-z-])${word}(?![a-z-])`, "i").test(answer);

  // Both at once is an answer that did not decide, and the fail-open reading of
  // "it is one of these two" is to let the expensive model say which.
  if (said("spam") === said("off-topic")) return null;
  if (said("spam")) {
    return { reason: "spam", note: "the cheap pass read it as spam" };
  }
  return { reason: "off-topic", note: "the cheap pass read it as being about something else" };
}

function prompt(request: SiftRequest): Message[] {
  const { title, body, about } = request;
  const material = enclose("untrusted-thread", `TITLE: ${title}\nBODY:\n${body}`);

  return [
    {
      role: "system",
      content: [
        "You decide whether an issue filed on a GitHub repository is worth a maintainer's",
        "attention at all. This is not a judgment about quality — a short, blunt or badly",
        "written report is worth attention.",
        "",
        ...(about.length === 0 ? [] : [`This repository is: ${about}`, ""]),
        "Answer with exactly one of these words and nothing else:",
        "",
        "- spam: advertising, a scam, a link farm, or text with no relation to software.",
        "- off-topic: a real request about something other than this repository.",
        "- keep: anything else, including a report you cannot make sense of.",
        "",
        "When you are not sure, answer keep.",
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}
