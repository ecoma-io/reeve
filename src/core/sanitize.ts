/**
 * Containment of model prose before it is published.
 *
 * A published block is a **repost**: every reference the source body carries gets
 * published a second time, under a different author, and GitHub acts on each
 * one again. `@alice` notifies Alice for a thread she has already read. `#42`
 * writes another cross-reference into issue 42. Multiply by a backfill over a
 * year of threads and Reeve's first impression is a few hundred unwanted
 * notifications — which is how a bot gets uninstalled before anyone
 * reads a word of what it wrote.
 *
 * Only the machine's copy is defanged. The author's own half of the body is
 * never rewritten, so their `#42` still links and their `@alice` still notifies
 * — see the publish stage. This module is handed the model's answer and nothing else.
 *
 * So references are defanged: an empty HTML comment after the first character.
 * GitHub's own renderer strips it before the autolinker runs, so `@<!---->alice`
 * reaches the reader as the plain text `@alice` — the same words, no link, no
 * notification. This is not a guess about the renderer; it was checked against
 * `POST /markdown` for each form below.
 *
 * Nothing inside code is touched. GitHub does not autolink there either, so
 * rewriting `@types/node` inside a code span would corrupt a code sample to
 * prevent a notification that was never going to happen.
 *
 * **What this deliberately does not do**, each for a reason worth disagreeing
 * with in review:
 *
 * - *Raw HTML tags stay.* GitHub's own sanitizer is the boundary for those, and
 *   a block that loses the `<details>` its source used is worse than one
 *   carrying a tag GitHub already refuses to render. The one tag with teeth — a
 *   `</details>` that closes the section a duty publishes its own text inside —
 *   is disarmed by the duty that owns that section, at the point where it
 *   assembles it: `translate/publish.ts` escapes any `<details>` tag left
 *   without a partner, so a reproduced section survives intact and a stray one
 *   is text before it can reach anything. It used to be a refusal in the duty's
 *   scorer, which cost the whole language for one loose tag.
 * - *Commit SHAs stay.* GitHub abbreviates a linked SHA to seven characters, so
 *   defanging one is the single reference form that is *visible* — it would
 *   replace `fca3701` with forty characters of hex to prevent a reference event
 *   that notifies nobody.
 * - *Length is not enforced.* A body's budget is spent across every language it
 *   carries plus the author's own text, so only the caller assembling those can
 *   divide it.
 * - *A fence wrapping the whole answer is not unwrapped.* Whether ```` ```md ````
 *   around everything is the model's packaging or the source's own code block is
 *   answerable only against the source, which this module does not have.
 */
import { mapProse } from "./markdown.js";

const OPENER = "<!--";
const CLOSER = "-->";

/**
 * What GitHub strips before autolinking, which is what makes the defang work —
 * and, emptied of its payload, what an HTML comment is left as.
 *
 * Emptied and not deleted, because deleting bytes from prose moves whatever sat
 * on either side of them together, and this module hands its result back to the
 * same segmenter on the next run. A single backtick in front of a comment and a
 * fenced ``` behind it are a stray backtick and a code span until the comment
 * between them goes, at which point they are one run of four backticks that
 * closes nowhere — so the code the first run protected reads as prose on the
 * second and gets defanged. Keeping the delimiters holds the two apart, and
 * keeps a comment at the start of a line from promoting the ``` behind it to a
 * fence opener.
 */
const INERT = "<!---->";

/**
 * The first alternative is passed through untouched: a URL, or a link
 * destination. Both routinely end in `#123`, and splicing anything into one
 * breaks a link the reader needs — a visible regression, traded for a
 * cross-reference that the source thread already made.
 *
 * The rest are the shorthand forms GitHub resolves, all checked against its
 * renderer:
 *   `@alice`, `@org/team` — a mention notifies
 *   `#42`, `owner/repo#42` — a reference writes into the other thread
 *   `GH-42`               — the same reference, spelled the other way
 *
 * Each guard is the one `POST /markdown` demonstrates rather than the one that
 * looks symmetrical:
 *
 * - A mention is not recognised after a letter, digit, underscore or hyphen, so
 *   `john@example.com` is left alone.
 * - `GH-42` is not recognised after a letter, digit or underscore — `xGH-2` and
 *   `_GH-2` render as text — but **is** after a hyphen: `x-GH-2` comes back
 *   with `GH-2` linked. So the hyphen is deliberately not in that guard, and a
 *   `\b` would have been wrong in the other direction.
 * - `#42` needs no guard at all, because `owner/repo#42` puts a letter
 *   immediately before the `#` and is exactly the form worth catching.
 *
 * **Every form also matches with the marker already spliced into it**, and that
 * optional `INERT` is what makes a second run over the same text a no-op rather
 * than a second defang. `@u-GH-2` is one whole mention, so the mention
 * alternative consumes it and nothing else fires; mark it and the mention no
 * longer matches, `GH-2` is suddenly at the front of a hyphen, and the next run
 * marks that too. A duty edits its own block in place, so the next run is
 * not hypothetical. Matching the marked form keeps the same text one reference
 * for as long as it exists, and `defangReferences` hands it back untouched.
 */
const REFERENCE = new RegExp(
  [
    String.raw`(https?://\S+|\]\([^\s)]*\))`,
    String.raw`(?<![A-Za-z0-9_-])@(?:${INERT})?[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,38})?`,
    String.raw`#(?:${INERT})?\d+`,
    String.raw`(?<![A-Za-z0-9_])G(?:${INERT})?H-\d+`,
  ].join("|"),
  "gi",
);

/** Makes model prose safe to post, leaving every byte of code alone. */
export function sanitize(markdown: string): string {
  return mapProse(markdown, (prose) => defangReferences(defangComments(prose)));
}

/**
 * Comments first: a comment emptied afterwards could swallow a defang marker,
 * and a marker written before the openers are settled is a marker the next
 * comment closes over.
 *
 * One pass, left to right, because the prose is whatever a stranger typed into
 * an issue and the cost of reading it has to be its length. Both jobs below
 * used to be a regex, and both were quadratic on the same input: `<!--` with
 * nothing to close it made each of them scan to the end of the body, once per
 * opener. At the 65536 characters GitHub allows, a body of nothing else took
 * 1.5 seconds.
 *
 * The scan for a closer is the same trap and is bounded by the same fact that
 * defuses it: whatever it finds is consumed, so its cost is paid out of the
 * text it retires. Only a search that finds nothing scans without consuming —
 * so where the last closer sits is settled once, up front, and an opener past
 * it never searches at all.
 */
function defangComments(prose: string): string {
  const lastCloser = prose.lastIndexOf(CLOSER);
  let defanged = "";
  let read = 0;

  for (;;) {
    const opener = prose.indexOf(OPENER, read);
    if (opener === -1) return defanged + prose.slice(read);

    defanged += prose.slice(read, opener);
    const closer =
      opener + OPENER.length > lastCloser ? -1 : prose.indexOf(CLOSER, opener + OPENER.length);
    if (closer === -1) {
      // An opener with nothing left to close it, which is a live hazard rather
      // than an oddity. Checked against `POST /markdown`: at the start of a
      // line GitHub reads it as an HTML block that runs to the end of the
      // document, so everything after it disappears; and wherever it sits, the
      // next `-->` in the body closes it — including one this module is about
      // to write. A body carrying `<!--cc @a` comes back as `<!--cc @<!---->a`,
      // where the renderer pairs the source's opener with the marker's own
      // `-->` and the reader is shown the marker instead of being spared the
      // mention. So the opener is defanged the same way a reference is, and for
      // the same reason: `<` `<!---->` `!--` renders as the literal `<!--` the
      // source wrote, byte for byte, and can no longer pair with anything.
      defanged += `<${INERT}!--`;
      read = opener + OPENER.length;
      continue;
    }

    // Emptied rather than kept: a translation has no use for an HTML comment,
    // and one that survived would be invisible cruft at best and a forged copy
    // of a duty's own marker at worst. Emptied rather than
    // deleted, because the delimiters are what hold whatever sat on either side
    // of the comment apart — see `INERT`.
    defanged += emptied(prose.slice(opener + OPENER.length, closer));
    read = closer + CLOSER.length;
  }
}

/**
 * Everything the segmenter does not read, blanked to a character that carries
 * no meaning to anything.
 *
 * **Overwritten in place rather than removed**, and that is the whole of why
 * this works. This module is the second thing to look at a body: the segmenter
 * has already decided where code begins and ends, and the next run — a duty
 * edits its own block — will ask it again, on this run's output. Deleting a
 * byte moves every byte after it, so the two runs can disagree about where code
 * is, and the second then defangs prose the first had protected or protects
 * prose the first had defanged. Deleting is what makes an emptied comment
 * unsafe; emptying is not.
 *
 * So the payload keeps its length, its line breaks, and every character the
 * segmenter consults — a backtick and a tilde (fence and span runs), a
 * backslash (the escape that stops the next character opening a span), a space
 * (the three-space indent a fence is still allowed) and the line terminators
 * themselves. The rest becomes `-`, which is an ordinary character to the
 * segmenter exactly as the letter it replaced was. The segmenter therefore sees
 * a document identical in every respect it reads, and its answer cannot change.
 *
 * `-` is also the one filler that keeps this scan's own boundaries put: the
 * payload can no longer contain a `<` or a `>`, so it can hold neither a nested
 * opener nor a closer, and the next run finds the same comment ending in the
 * same place. Re-emptying then rewrites `-` to `-` and changes nothing.
 *
 * Both ways this has been got wrong deleted:
 *
 * - Dropping the payload except its backticks. `<!--\`<!---->` empties to
 *   ``<!--`-->``, where the backtick — its escape gone — pairs with one after
 *   the comment and makes a code span out of the comment's own `-->`. The next
 *   run finds an opener with nothing to close it.
 * - Dropping the payload entirely. ``` a````<!--`--> ``` is not a fence opener
 *   twice over: it does not start the line, and a backtick fence may not carry
 *   a backtick in its info string. Empty it to ```` ````<!----> ```` and it is
 *   one, so the next run reads the rest of the body as code.
 *
 * Nothing readable is lost either way — a comment renders as nothing whatever
 * is between its delimiters.
 */
const OPAQUE = /[^`~\\\n\r ]/g;

function emptied(payload: string): string {
  return `${OPENER}${payload.replace(OPAQUE, "-")}${CLOSER}`;
}

function defangReferences(prose: string): string {
  return prose.replace(REFERENCE, (match: string, passthrough: string | undefined) => {
    // A URL or a link destination, and one already carrying its marker: both
    // are matched only so that nothing else can match inside them.
    if (passthrough !== undefined || match.slice(1).startsWith(INERT)) return match;
    return `${match.slice(0, 1)}${INERT}${match.slice(1)}`;
  });
}
