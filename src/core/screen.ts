/**
 * The stage that decides, for nothing, that a thread is not worth a model.
 *
 * A backlog is mostly threads nobody can reach a verdict on: a form nobody
 * filled in, a title and four words, a body that is one screenshot. Sending
 * those to the expensive model produces a confident answer about nothing and
 * charges for it. So this runs first, in code, with no provider constructed and
 * no request made — and on a real tracker it is what makes the rest affordable.
 *
 * **Every rule here is about how much the author wrote, never about what they
 * said.** A screen that judged content would be a filter for the phrasings
 * somebody already thought of, wrong in both directions: it would drop a real
 * report written bluntly, and pass spam written politely. Whether a thread is
 * spam is a judgment, it needs the cheapest model rather than none, and it is
 * the duty's business rather than this module's.
 *
 * **The errors are asymmetric on purpose.** Passing junk to a model costs one
 * cheap request. Screening out a genuine report costs a contributor the answer
 * they came for, silently, on the one run that would have given it to them. So
 * every threshold here is set where it only fires on a thread nothing could
 * have been concluded from, and the length below which that is true is the
 * consumer's to raise or to turn off.
 *
 * **The title is authored text and is read as such.** The contract this
 * implements says "an empty body", and an empty body is not the same thing as
 * an empty thread: `Export produces an empty file for single-row tables` with
 * no body is a report a maintainer labels in a second, and a duty that skipped
 * it would skip a large share of a real tracker. What is actually being asked
 * is whether there is enough authored text anywhere to reach a verdict, so that
 * is what is measured.
 *
 * **What is not here yet: the exact repeat.** The duty's contract also names a
 * code screen for a thread that repeats an existing issue by content hash. That
 * one needs a corpus of the issues already filed, which is a committed store
 * this repository does not build yet — search cannot supply it, because the
 * search API stops at a thousand results and truncates hardest on exactly the
 * backlogs where duplicates matter. It is left out rather than approximated.
 */
import { segments } from "./markdown.js";

/** Why a thread stopped here. Machine-readable, because a workflow branches on it. */
export type Reason = "empty" | "template" | "too-short";

export interface Screened {
  readonly reason: Reason;
  /** The sentence for the log and the report. */
  readonly note: string;
}

export interface ScreenRequest {
  readonly title: string;
  readonly body: string;
  /**
   * How much authored text is enough, in characters. `0` turns the length rule
   * off entirely, which is the right setting for a tracker whose reports are
   * routinely terse.
   */
  readonly minimum: number;
}

/**
 * Whether this thread is worth a model, or null when it is.
 *
 * Null rather than a "passed" object: the caller's question is "should I stop",
 * and a truthy value that means carry on is the shape that gets misread once.
 */
export function screen(request: ScreenRequest): Screened | null {
  const { scaffolded, authored } = strip(request.body);
  const written = `${request.title.trim()}\n${authored}`.trim();

  // Evidence before length. A one-line report carrying a stack trace, a
  // reproduction link or a command is a better report than three paragraphs of
  // apology, and measuring it by character count would have exactly that
  // backwards.
  const short = request.minimum > 0 && written.length < request.minimum && !evidenced(request.body);
  if (written.length > 0 && !short) return null;

  // Which absence this is, most specific first. A blank form and a blank issue
  // are the same missing text with different advice attached, and a maintainer
  // reading `screened-out` deserves the difference — including when a terse
  // title kept the thread out of the empty case entirely.
  if (scaffolded && authored.length === 0) {
    return { reason: "template", note: "the issue template came back with nothing filled in" };
  }
  if (written.length === 0) {
    return { reason: "empty", note: "the thread carries no text to work from" };
  }
  return {
    reason: "too-short",
    note:
      `there are ${String(written.length)} characters of authored text and no code, link or ` +
      `error in it, which is under the ${String(request.minimum)} this run asks for`,
  };
}

/** A heading, at any level. */
const HEADING = /^\s{0,3}#{1,6}\s/;
/** How a Markdown template carries its instructions: an HTML comment. */
const OPENER = "<!--";
const CLOSER = "-->";
/** What a GitHub issue form writes for a field the reporter left alone. */
const NO_RESPONSE = /^\s*_No response_\s*$/i;
/** An unticked box. The label beside it is the template's words, not the author's. */
const UNTICKED = /^\s*[-*]\s*\[ \]\s/;
/** A horizontal rule, which a template uses to separate sections. */
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/**
 * The body with the template's own words removed, and whether there were any.
 *
 * Everything stripped here was written by whoever wrote the template rather
 * than by the reporter, so counting it as authored text would make a longer
 * template a better report. A ticked box survives, because ticking one is the
 * reporter answering a question.
 *
 * `scaffolded` is what separates "they opened a form and submitted it empty"
 * from "they opened a blank issue and submitted it empty" — the same absence,
 * with different advice attached, and a maintainer reading `screened-out`
 * deserves the difference.
 */
function strip(body: string): { scaffolded: boolean; authored: string } {
  const withoutComments = removeComments(body);
  let scaffolded = withoutComments !== body;

  const kept: string[] = [];
  for (const line of withoutComments.split("\n")) {
    if (HEADING.test(line) || NO_RESPONSE.test(line) || UNTICKED.test(line) || RULE.test(line)) {
      scaffolded = true;
      continue;
    }
    kept.push(line);
  }

  return { scaffolded, authored: kept.join("\n").trim() };
}

/**
 * The body with every closed HTML comment replaced by a newline.
 *
 * One pass, left to right, for the reason `sanitize.ts`'s `defangComments`
 * gives at length: this reads whatever a stranger typed into an issue, so the
 * cost of reading it has to be its length. The regex this replaced —
 * `/<!--[\s\S]*?-->/g` — was the same shape that module documents having
 * fixed, and was quadratic on the same input. An unclosed `<!--` made the
 * engine scan to the end of the body looking for a closer, once per opener,
 * and a body of nothing but openers at the 65536 characters GitHub allows took
 * 574ms here. Reached on the raw thread body of every screened item, so a
 * sweep of a hundred such threads spent a minute of runner time before asking
 * a model anything.
 *
 * The bound is the same one that defuses it there: a closer the scan finds is
 * consumed, so its cost is paid out of the text it retires, and only a search
 * that finds nothing scans without consuming. Where the last closer sits is
 * settled once, up front, and an opener past it never searches at all.
 *
 * What is stripped is unchanged: a comment needs a closer to be a comment, so
 * an opener with nothing to close it stays in the body as the literal text
 * GitHub will render, and counts as the author's.
 */
function removeComments(body: string): string {
  const lastCloser = body.lastIndexOf(CLOSER);
  let out = "";
  let read = 0;

  for (;;) {
    const opener = body.indexOf(OPENER, read);
    if (opener === -1) return out + body.slice(read);

    // Past the last closer in the body, so nothing after this opener can close
    // it and nothing after it can be a comment either.
    if (opener + OPENER.length > lastCloser) return out + body.slice(read);

    const closer = body.indexOf(CLOSER, opener + OPENER.length);
    if (closer === -1) return out + body.slice(read);

    out += `${body.slice(read, opener)}\n`;
    read = closer + CLOSER.length;
  }
}

/** A URL, which is a reproduction, a log or a related issue more often than not. */
const LINK = /https?:\/\/\S/;

/**
 * Text that reads like something failing.
 *
 * Deliberately a short list of the shapes that are unambiguous — a Java or
 * Python stack frame, a named exception, a non-zero exit — rather than an
 * attempt at every runtime's format. A miss here costs a cheap model call; a
 * false match costs nothing at all, because all this decides is that a short
 * thread is worth reading properly.
 */
const ERROR =
  /(^|\n)\s*(at\s+\S+\(|Traceback \(most recent call last\)|File "[^"]+", line \d)|\b([A-Za-z][A-Za-z0-9_.]*)?(Error|Exception|Panic|Fatal|Segmentation fault)\b|\bexit(ed with)? (code|status) [1-9]/i;

/**
 * Whether the body carries something worth reading regardless of its length.
 *
 * Code is asked of the Markdown parser rather than of a regular expression,
 * because that parser is already the thing every other stage trusts about where
 * a fence starts and stops.
 */
function evidenced(body: string): boolean {
  if (LINK.test(body) || ERROR.test(body)) return true;
  return segments(body).some((segment) => segment.kind !== "prose");
}
