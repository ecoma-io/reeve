/**
 * How good a translation draft is, decided without asking a model anything.
 *
 * The machinery — what a check is, what admissible means, how a rank is a
 * weighted mean — is the core's. What is measured is this duty's, and it is the
 * part that could not be shared: "the same three code blocks, unchanged" is a
 * fact about a translation and about nothing else.
 *
 * The measurements are of the source against the draft, never of the draft
 * alone. "Has three code blocks" says nothing; "has the same three code blocks,
 * unchanged" is the whole question, because a translation is required to carry
 * code across untouched and required to leave a URL alone.
 *
 * **Refusal and rank are different answers.** A draft is inadmissible only for
 * something provable *and* total — it is empty, it is the source unchanged, it
 * closes a section it does not own, or it is still in the language it was
 * supposed to be translated out of. Everything else lowers the rank instead.
 *
 * **Two rules used to refuse here and now rank instead: the glossary and the
 * script leak.** Both were provable and neither was total, and that gap is
 * what made them expensive. With one draft configured — the setup this project
 * dogfoods and the one a free endpoint forces — a refusal is not "try the other
 * candidate", it is the whole language dropped from the thread for that run.
 * Runs 32461467950 and 32560607218 lost Vietnamese exactly that way: once to a
 * `capability` translated everywhere, once to a handful of Han characters in an
 * otherwise sound draft. A translation that says "khả năng" where the docs say
 * `capability` is a worse translation than one that does not; it is a far better
 * outcome than no Vietnamese at all, and a weighted rank is the structure that
 * can say both. What is genuinely total still refuses — a draft wholly in the
 * wrong script lands at zero on the check below and loses to anything else.
 *
 * The glossary is the one measurement here that is not a fact about the two
 * texts alone: it is a list a maintainer committed to the repository, shared
 * with `harmonise` down to the file it is read from, and both duties measure it
 * through the same shared checks in `core/glossary.ts`.
 */
import { detectLanguage } from "../../core/detect.js";
import { termsPreserved, type GlossaryEntry } from "../../core/glossary.js";
import type { Language } from "../../core/languages.js";
import { segments } from "../../core/markdown.js";
import { measured, overlap, refused, shared, type Check, type Score } from "../../core/score.js";
import { scriptLeak } from "../../core/script.js";

/**
 * How much each measurement moves the rank.
 *
 * Code leads because a mangled code block is the one damage a reader cannot
 * repair from context: a mistranslated sentence is still readable as a
 * mistranslation, while a `docker run` line with a translated flag is a command
 * that silently does something else. A broken URL is the same failure one step
 * down — the reader can see it is broken but cannot recover where it pointed.
 * Length is last because it is the only one that measures a plausible range
 * rather than an equality.
 *
 * Glossary sits with links, at 3, and for the same kind of reason: a term this
 * project wrote down is a literal string a reader maps back to an input name, an
 * identifier, or a page in the reference docs, and a translated one leaves them
 * holding a word that appears nowhere else in the repository. Like code and
 * unlike length, it measures an equality rather than a plausible range — the
 * only thing separating it from the other three is that it measures nothing at
 * all until a repository has written the list down.
 *
 * Script sits at 3 as well, and for the reason the doc comment above gives: a
 * reader who meets a Han phrase in the middle of a Vietnamese paragraph is
 * exactly as stuck as one who meets a translated input name — the sentence is
 * there, and the part they needed is not readable. It is not a 4 because,
 * unlike a mangled `docker run` line, a leak is visible as a leak.
 */
const WEIGHTS = {
  code: 4,
  links: 3,
  structure: 2,
  length: 1,
  glossary: 3,
  script: 3,
} as const;

/**
 * The share of a draft's prose that has to be in a script nobody asked for
 * before the check reads zero.
 *
 * Set where "this draft is in the wrong language" lives rather than where "this
 * draft has a stray character" does. A model that answered the whole request in
 * Chinese produces a draft most of whose letters are Han, far past this; a model
 * that left a proper noun or an error message in its original script produces a
 * handful of characters in a body of thousands, which moves the rank by an
 * amount too small to change any comparison. Between them the value slides,
 * which is the honest shape: a draft with a leaked paragraph is worse than one
 * with a leaked word and better than one that is wholly wrong.
 */
const WHOLLY_FOREIGN = 0.25;

/**
 * What a translation may do to the length of the prose.
 *
 * A language pair decides this far more than a model does — the same paragraph
 * in Chinese and in German differ by more than most bad translations do — so
 * the band is wide enough to hold every pair rather than tuned to any one, and
 * it earns its weight of 1 by catching the failure it is actually for: a draft
 * that stopped after the first paragraph, or one that answered with an essay
 * about the translation.
 */
const PLAUSIBLE_LENGTH = {
  shortest: 0.5,
  longest: 2,
  impossiblyShort: 0.2,
  impossiblyLong: 4,
} as const;

export interface Draft {
  /** The body being translated, as the thread wrote it. */
  readonly source: string;
  /** What the model answered. */
  readonly draft: string;
  /** The detected source language, or null when detection reached no answer. */
  readonly from: Language | null;
  /** The language this draft was asked for. */
  readonly to: Language;
  /**
   * Every language the workflow configured, this one included.
   *
   * Needed because a script that has leaked into a draft can only be named
   * against a script somebody asked for. Reeve derives its rules from the
   * configured languages and nowhere else — there is no list of scripts in
   * this repository, deliberately, and inventing one would be the
   * special-casing the whole design avoids.
   */
  readonly languages: readonly Language[];
  /**
   * The terms this project keeps in one spelling, whatever language is being
   * written — `.reeve/glossary.yml`, read once per run and handed down.
   *
   * Absent is the common case and means the same as empty: most repositories
   * have no protected terms, and nothing here is measured for them.
   *
   * **Matched against this chunk's source, not the whole body.** A body wider
   * than `chunk-chars` is scored one chunk at a time, and a term that appears
   * in chunk three is nothing chunk one could have lost. Per-chunk is also what
   * makes the rule keep terminology steady across a long body: every chunk is
   * held to the same list, so the same term comes back the same way in each.
   */
  readonly glossary?: readonly GlossaryEntry[];
}

/** Measures one draft against its source. */
export async function score(request: Draft): Promise<Score> {
  const before = outline(request.source);
  const after = outline(request.draft);

  const refusal = await refuse(request, after);
  if (refusal) return refused(refusal);

  const checks: Check[] = [
    codeCheck(before, after),
    linkCheck(before, after),
    structureCheck(before, after),
    lengthCheck(before, after),
  ];
  const glossary = glossaryCheck(request);
  if (glossary !== null) checks.push(glossary);
  const script = scriptCheck(request, before, after);
  if (script !== null) checks.push(script);

  return measured(checks);
}

/** Every glossary term, as the checks compare them: the spelling and nothing else. */
function terms({ glossary }: Draft): readonly string[] {
  return (glossary ?? []).map((entry) => entry.term);
}

/**
 * The provable failures, in the order that costs least to establish.
 *
 * Only the last one needs the detector, and it is worth the work: a model that
 * answers in the source language is the single most common way a cheap endpoint
 * fails, and it fails while producing text that every other measurement here
 * scores perfectly — same code, same links, same structure, same length.
 */
async function refuse(request: Draft, after: Outline): Promise<string | null> {
  const { source, draft, from, to } = request;
  if (draft.trim().length === 0) return "the draft is empty";
  if (draft.trim() === source.trim()) return "the draft is the source, unchanged";

  if (closesUnopenedSection(after.prose)) {
    return "the draft closes a `<details>` section it never opened";
  }

  if (!from || from.code.toLowerCase() === to.code.toLowerCase()) return null;

  // No picker, so this cannot reach a model: script narrowing and the local
  // profile decide or nothing does. A detector that says nothing is not
  // evidence against a draft, which is why only a positive identification of
  // the source language refuses one.
  const { language } = await detectLanguage(draft, [from, to]);
  return language?.code === from.code ? `the draft is still in ${from.label}` : null;
}

/**
 * A `<details>` tag, open or closing, with whatever attributes it carries. Only
 * ever run over prose: the same characters inside a fence or a span are a code
 * sample about HTML, and GitHub renders them as text.
 */
const DETAILS = /<(\/)?details\b[^>]*>/gi;

/**
 * Whether the draft ends a section that was not its to end.
 *
 * Raw HTML is deliberately left in a translation — a draft that dropped the
 * `<details>` block its source used is the worse translation, and the sanitiser
 * says so. But this duty publishes each translation *inside* a `<details>`
 * section of its own, so a stray `</details>` does not merely unbalance the
 * draft: it closes the wrapper early and spills every language after it into
 * the visible part of the thread body.
 *
 * The balance is what distinguishes the two cases, and it is why this counts
 * rather than searching. A source that legitimately used a collapsible section
 * hands the model a `</details>` to reproduce, and reproducing it is correct —
 * it has an opener of its own. Only a closer with no opener before it is
 * reaching outside the draft, and once the running depth has gone negative no
 * later opener can put it back.
 */
function closesUnopenedSection(prose: string): boolean {
  let depth = 0;
  for (const [, closing] of prose.matchAll(DETAILS)) {
    depth += closing === undefined ? 1 : -1;
    if (depth < 0) return true;
  }
  return false;
}

/**
 * A body split into the parts each measurement needs.
 *
 * Fences and spans come out as their own text so they can be compared for
 * equality. What is left is line-addressable prose: every fence becomes a bare
 * newline and every span a single character, so a heading is still at the start
 * of its line and a span can no longer split one in half. Counting `#` against
 * the raw segments instead would miss a heading whenever an earlier line held a
 * code span.
 */
interface Outline {
  readonly prose: string;
  readonly code: readonly string[];
  readonly fences: number;
  readonly spans: number;
}

function outline(markdown: string): Outline {
  const code: string[] = [];
  let prose = "";
  let fences = 0;
  let spans = 0;

  for (const segment of segments(markdown)) {
    if (segment.kind === "prose") {
      prose += segment.text;
      continue;
    }
    // Trailing whitespace off, because a fenced block carries its own line
    // terminator and whether it has one depends on where the block sits in the
    // body rather than on what it says. Comparing it would score an identical
    // block at the end of a draft as a translated one.
    code.push(segment.text.trimEnd());
    if (segment.kind === "fence") {
      fences += 1;
      prose += "\n";
    } else {
      spans += 1;
      prose += "x";
    }
  }

  return { prose, code, fences, spans };
}

function codeCheck(before: Outline, after: Outline): Check {
  const kept = shared(before.code, after.code);
  return {
    name: "code",
    weight: WEIGHTS.code,
    value: overlap(before.code, after.code),
    note: `${String(kept)} of ${String(before.code.length)} code blocks and spans carried across unchanged`,
  };
}

function linkCheck(before: Outline, after: Outline): Check {
  const source = links(before.prose);
  const draft = links(after.prose);
  return {
    name: "links",
    weight: WEIGHTS.links,
    value: overlap(source, draft),
    note: `${String(shared(source, draft))} of ${String(source.length)} links unchanged`,
  };
}

function structureCheck(before: Outline, after: Outline): Check {
  const source = structure(before);
  const draft = structure(after);
  let difference = 0;
  let total = 0;
  for (const kind of COUNTED) {
    difference += Math.abs(source[kind] - draft[kind]);
    total += Math.max(source[kind], draft[kind]);
  }

  return {
    name: "structure",
    weight: WEIGHTS.structure,
    value: total === 0 ? 1 : 1 - difference / total,
    note: `${String(difference)} of ${String(total)} headings, list items, table rows and code blocks differ in count`,
  };
}

/**
 * Length is measured on prose alone. Code is required to be identical, so
 * counting it would dilute the one thing this check is looking for — and a
 * body that is mostly a stack trace would sail through however little of its
 * prose survived.
 */
function lengthCheck(before: Outline, after: Outline): Check {
  const source = before.prose.trim().length;
  const draft = after.prose.trim().length;
  const note = `${String(draft)} characters of prose against ${String(source)}`;
  const weight = WEIGHTS.length;

  if (source === 0) return { name: "length", weight, value: draft === 0 ? 1 : 0, note };

  const ratio = draft / source;
  const { shortest, longest, impossiblyShort, impossiblyLong } = PLAUSIBLE_LENGTH;
  if (ratio >= shortest && ratio <= longest) return { name: "length", weight, value: 1, note };
  const value =
    ratio < shortest
      ? (ratio - impossiblyShort) / (shortest - impossiblyShort)
      : (impossiblyLong - ratio) / (impossiblyLong - longest);

  return { name: "length", weight, value: Math.max(0, Math.min(1, value)), note };
}

/**
 * How many of the glossary terms this chunk's source used the draft carried
 * through, or null when it used none.
 *
 * Null rather than a perfect score: a check worth 3 that reads 1 for every draft
 * in every repository without a glossary — which is most of them — would move
 * every number this duty reports while measuring nothing, and `measured` already
 * treats a check nobody added as a check nobody failed.
 *
 * Measured on the raw source and the raw draft rather than on the outline,
 * because half of what a glossary protects is the name of something and lives
 * inside a code span. Those spans are already required to come back unchanged,
 * so a term inside one is measured twice — which is the correct amount for the
 * one rule a maintainer wrote out by hand.
 *
 * **This is the whole of the rule now, not the note beside it.** A draft that
 * lost a term used to be refused before reaching here, so the check only ever
 * reported `2 of 2`. It now reports what actually happened — `1 of 2 glossary
 * terms carried through unchanged` — and the weight of 3 is what that costs.
 * The comparison is the same one `harmonise` makes from the same file, and
 * neither duty may be stricter than the other about it.
 */
function glossaryCheck(request: Draft): Check | null {
  const { relevant, preserved, value } = termsPreserved(
    request.source,
    request.draft,
    terms(request),
  );
  if (relevant === 0) return null;

  return {
    name: "glossary",
    weight: WEIGHTS.glossary,
    value,
    note: `${String(preserved)} of ${String(relevant)} glossary terms carried through unchanged`,
  };
}

/**
 * How much of the draft is written in a script neither the target language nor
 * the source uses, or null when no configured script leaked at all.
 *
 * This is the failure a cheap model produces most visibly: a Vietnamese
 * translation with a Chinese phrase left sitting in it. Every other measurement
 * scores it well — the code is intact, the links are intact, the length is
 * plausible — and the detector clears it too, because the draft *is*
 * predominantly Vietnamese. Only the letters give it away.
 *
 * Null rather than a perfect score, for the reason `glossaryCheck` returns null:
 * a repository configured for one language, or for several sharing one script,
 * can never leak, and a check reading 1 for every draft it will ever see moves
 * every number this duty reports while measuring nothing.
 *
 * **Measured against the draft's own length, which is what makes it fair in
 * both directions.** The finding itself is asymmetric by construction — an
 * English source exempts every Latin character in a Chinese draft, so only the
 * Vietnamese direction can ever report a leak. As a refusal that asymmetry
 * decided whether a language was published. As a proportion it is a few
 * thousandths of a rank, until the leak is large enough to be the story.
 */
function scriptCheck(request: Draft, before: Outline, after: Outline): Check | null {
  const { to, languages } = request;
  const leak = scriptLeak(before.prose, after.prose, to.scripts, languages);
  if (leak === null) return null;

  const prose = after.prose.trim().length;
  const share = prose === 0 ? 1 : leak.chars / prose;

  return {
    name: "script",
    weight: WEIGHTS.script,
    value: Math.max(0, Math.min(1, 1 - share / WHOLLY_FOREIGN)),
    note:
      `${String(leak.chars)} of ${String(prose)} characters of prose are ${leak.script}, ` +
      `a script neither the source nor ${to.label} uses`,
  };
}

/**
 * What a translation has to keep the same number of. Written once, because the
 * comparison below walks it and the shape is derived from it — a field added to
 * one and not the other would be a measurement silently left out.
 */
const COUNTED = ["headings", "listItems", "tableRows", "blocks"] as const;

type Structure = Record<(typeof COUNTED)[number], number>;

const HEADING = /^ {0,3}#{1,6}(?: |$)/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: |$)/;
const TABLE_ROW = /^ {0,3}\|/;

function structure({ prose, fences, spans }: Outline): Structure {
  const counted = { headings: 0, listItems: 0, tableRows: 0, blocks: fences + spans };
  for (const line of prose.split("\n")) {
    if (HEADING.test(line)) counted.headings += 1;
    else if (LIST_ITEM.test(line)) counted.listItems += 1;
    else if (TABLE_ROW.test(line)) counted.tableRows += 1;
  }
  return counted;
}

/**
 * Both spellings a destination can take. A translation is free to move a link
 * inside the sentence and free to reword what it is called, so only where it
 * points is compared.
 */
const LINK = /\]\(([^\s)]+)\)|(?<!\]\()\b(https?:\/\/[^\s)<>]+)/g;

function links(prose: string): string[] {
  return [...prose.matchAll(LINK)].map(([, destination, bare]) => destination ?? bare ?? "");
}
