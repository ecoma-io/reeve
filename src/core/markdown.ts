/**
 * Splitting Markdown into the parts that are code and the parts that are prose.
 *
 * Two things in Reeve need the same distinction and would otherwise each
 * invent it. `sanitize` must not rewrite anything inside code — an issue body
 * mentioning `@types/node` or `#define` is ordinary, and defanging those would
 * corrupt a code sample to prevent a notification that was never going to
 * happen, because GitHub does not linkify inside code either. `score` compares
 * a draft's structure against the source, and fences and code spans are most of
 * that structure.
 *
 * The split follows CommonMark on the two points that decide real issue bodies:
 * a fence is closed by a run of the same character at least as long as the one
 * that opened it, and an inline code span is closed by a backtick run of
 * exactly the same length. An unterminated opener is not a code span at all —
 * it is literal backticks, which is what makes a stray one in prose harmless.
 *
 * The invariant every consumer relies on: concatenating the segments in order
 * reproduces the input byte for byte. Nothing here normalises, trims or repairs
 * anything.
 */

export type SegmentKind = "prose" | "fence" | "code";

export interface Segment {
  readonly kind: SegmentKind;
  /** The verbatim source, delimiters included. */
  readonly text: string;
}

/** Splits Markdown into prose, fenced blocks, and inline code spans. */
export function segments(markdown: string): Segment[] {
  const out: Segment[] = [];
  for (const block of splitFences(markdown)) {
    if (block.kind === "fence") {
      out.push(block);
      continue;
    }
    out.push(...splitCodeSpans(block.text));
  }
  return out;
}

/**
 * Rewrites the prose and leaves every byte of code alone.
 *
 * The one operation both consumers of this module actually perform, kept here
 * so neither has to reassemble the segments itself.
 */
export function mapProse(markdown: string, rewrite: (prose: string) => string): string {
  return segments(markdown)
    .map((segment) => (segment.kind === "prose" ? rewrite(segment.text) : segment.text))
    .join("");
}

/**
 * Splits into lines that still carry their terminator, so joining any run of
 * them is exact. A `split("\n")` alone loses the boundary the join has to
 * guess at, and guessing is how a trailing newline appears or disappears.
 */
function terminatedLines(markdown: string): string[] {
  const raw = markdown.split("\n");
  return raw.map((line, index) => (index < raw.length - 1 ? `${line}\n` : line));
}

/**
 * The line without its terminator.
 *
 * Every test below is anchored with `$`, which in JavaScript does not match
 * before a trailing newline the way it does in some other languages. Leaving
 * the terminator on is how a fence stops being recognised at all.
 */
function withoutTerminator(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/** The marker of a fence this line opens, or null when it opens none. */
function fenceOpener(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(withoutTerminator(line));
  if (!match) return null;
  const [, marker = "", info = ""] = match;
  // A backtick fence's info string may not contain a backtick, which is what
  // keeps ``` `a` ``` in a paragraph from being read as a block opener.
  if (marker.startsWith("`") && info.includes("`")) return null;
  return marker;
}

function closesFence(line: string, marker: string): boolean {
  const fenceChar = marker[0];
  const body = withoutTerminator(line).replace(/^ {0,3}/, "");
  let run = 0;
  while (run < body.length && body[run] === fenceChar) run++;
  if (run < marker.length) return false;
  return body.slice(run).trim().length === 0;
}

function splitFences(markdown: string): Segment[] {
  const out: Segment[] = [];
  let buffer: string[] = [];
  let marker: string | null = null;

  const flush = (kind: SegmentKind): void => {
    if (buffer.length > 0) out.push({ kind, text: buffer.join("") });
    buffer = [];
  };

  for (const line of terminatedLines(markdown)) {
    if (marker === null) {
      const opener = fenceOpener(line);
      if (opener === null) {
        buffer.push(line);
        continue;
      }
      flush("prose");
      marker = opener;
      buffer.push(line);
      continue;
    }

    buffer.push(line);
    if (closesFence(line, marker)) {
      flush("fence");
      marker = null;
    }
  }

  // An opener with no closer runs to the end of the document — GitHub renders
  // the rest as code, so this module has to agree with it.
  flush(marker === null ? "prose" : "fence");
  return out;
}

function splitCodeSpans(text: string): Segment[] {
  const out: Segment[] = [];
  let prose = "";
  let index = 0;

  const flushProse = (): void => {
    if (prose.length > 0) out.push({ kind: "prose", text: prose });
    prose = "";
  };

  while (index < text.length) {
    // `charAt` rather than an index, so the loop bound is the only thing that
    // has to be right — an index yields `string | undefined` here and would
    // buy a narrowing branch that can never be taken.
    const char = text.charAt(index);

    // A backslash escape makes the next character literal, so `\`` does not
    // open a span. Escapes have no meaning inside a span, so only the search
    // for an opener honours them.
    if (char === "\\" && index + 1 < text.length) {
      prose += text.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (char !== "`") {
      prose += char;
      index += 1;
      continue;
    }

    const openStart = index;
    while (index < text.length && text[index] === "`") index += 1;
    const runLength = index - openStart;

    const closeStart = findClosingRun(text, index, runLength);
    if (closeStart === -1) {
      // No run of the same length follows, so these backticks are text.
      prose += text.slice(openStart, index);
      continue;
    }

    flushProse();
    const end = closeStart + runLength;
    out.push({ kind: "code", text: text.slice(openStart, end) });
    index = end;
  }

  flushProse();
  return out;
}

/** Index of the next backtick run of exactly `runLength`, or -1. */
function findClosingRun(text: string, from: number, runLength: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && text[index] === "`") index += 1;
    if (index - start === runLength) return start;
  }
  return -1;
}
