/**
 * Deterministic scoring of a `harmonise` sync draft.
 *
 * Unlike `translate`'s scoring (which compares a draft against its source),
 * `harmonise` scoring compares the draft against the *original target* — the
 * goal is to verify that the draft preserves the target's structure while
 * incorporating the semantic changes.
 *
 * Checks:
 * - Code fidelity: fenced blocks and inline spans carried across unchanged
 * - Link fidelity: URLs unchanged
 * - Structure: heading and list structure preserved
 * - Length: prose length falls within plausible range
 * - Glossary: glossary terms respected
 * - Script: how much of the draft is in a script nobody configured for it
 *
 * **The glossary and the script leak rank rather than refuse**, and they do so
 * on the same reasoning and the same shared helpers as `translate` — see that
 * duty's `score.ts` for the argument in full. The short of it: both were
 * provable and neither was total, and with one draft configured a refusal is
 * not "take the other candidate", it is the locale left un-synced. Ranking them
 * keeps a slightly worse translation instead of keeping none, and a draft that
 * is wholly in the wrong script still scores zero on the check and loses.
 */
import { scriptLeak } from "../../core/script.js";
import { termsPreserved } from "../../core/glossary.js";
import { segments } from "../../core/markdown.js";
import { measured, refused, type Score, type Check } from "../../core/score.js";
import type { Language } from "../../core/languages.js";

/**
 * Scores a draft against the original target content.
 *
 * Returns a `Score` — refused for provably wrong drafts, measured for
 * admissible ones. See `core/score.ts` for what admissibility means.
 *
 * When the original target is empty — the bootstrap case, where the sync
 * creates the first translation — the source becomes the anchor instead:
 * there is no prior translation whose structure could be preserved, but the
 * source's code blocks, links, structure and glossary terms must all carry
 * across. Scoring against an empty string would call a draft that dropped
 * every code block a good one.
 */
export function scoreDraft(
  draft: string,
  original: string,
  glossaryTerms: readonly string[],
  source: string,
  targetLanguage: Language,
  languages: readonly Language[],
): Score {
  const initial = original.trim().length === 0;
  const anchor = initial ? source : original;

  // --- Refusal checks (binary, provably wrong) ---
  if (draft.trim().length === 0) return refused("empty draft");
  if (draft === anchor) {
    return refused(
      initial ? "identical to the source — not a translation" : "unchanged from original",
    );
  }
  // --- Measurements (weighted mean, 0-1) ---
  const checks: Check[] = [
    { name: "code", weight: 4, value: codeCheck(draft, anchor), note: "" },
    { name: "links", weight: 3, value: linkCheck(draft, anchor), note: "" },
    { name: "structure", weight: 2, value: structureCheck(draft, anchor), note: "" },
    { name: "length", weight: 1, value: lengthCheck(draft, anchor), note: "" },
    // On an initial translation the anchor is the source, so a term the source
    // carries is one the first draft is measured on too.
    { name: "glossary", weight: 3, value: glossaryCheck(draft, anchor, glossaryTerms), note: "" },
  ];

  const script = scriptCheck(draft, source, targetLanguage, languages);
  if (script !== null) checks.push(script);

  return measured(checks);
}

/**
 * The share of the draft written in a script neither the target language nor
 * the source uses, as a check — or null when no configured script leaked.
 *
 * Weighted 3, matched to `translate`'s, because the two duties are answering the
 * same question about the same repository and a reader meets the result in the
 * same place. `WHOLLY_FOREIGN` is likewise the same number, and for the same
 * reason: it is where "the model answered in the wrong language" sits, well
 * above where "the model left a proper noun alone" does.
 */
function scriptCheck(
  draft: string,
  source: string,
  targetLanguage: Language,
  languages: readonly Language[],
): Check | null {
  const leak = scriptLeak(source, draft, targetLanguage.scripts, languages);
  if (leak === null) return null;

  const length = draft.trim().length;
  const share = length === 0 ? 1 : leak.chars / length;

  return {
    name: "script",
    weight: 3,
    value: Math.max(0, Math.min(1, 1 - share / WHOLLY_FOREIGN)),
    note:
      `${String(leak.chars)} of ${String(length)} characters are ${leak.script}, ` +
      `a script neither the source nor ${targetLanguage.label} uses`,
  };
}

/** The share of a draft that has to be in an unasked-for script to read zero. */
const WHOLLY_FOREIGN = 0.25;

// --- Individual checks ---

/** Code blocks and inline code spans carried across unchanged. */
function codeCheck(draft: string, original: string): number {
  const originalSegs = segments(original).filter((s) => s.kind === "fence" || s.kind === "code");
  const draftSegs = segments(draft).filter((s) => s.kind === "fence" || s.kind === "code");

  if (originalSegs.length === 0 && draftSegs.length === 0) return 1;
  if (originalSegs.length === 0) return 0.5; // New code blocks added

  const originalTexts = new Set(originalSegs.map((s) => s.text));
  const draftTexts = new Set(draftSegs.map((s) => s.text));

  let preserved = 0;
  for (const text of originalTexts) {
    if (draftTexts.has(text)) preserved++;
  }

  return preserved / originalTexts.size;
}

/** URLs unchanged in the draft. */
function linkCheck(draft: string, original: string): number {
  const URL = /https?:\/\/[^\s)\]>]+/g;
  const originalUrls = new Set((original.match(URL) ?? []) as string[]);
  const draftUrls = new Set((draft.match(URL) ?? []) as string[]);

  if (originalUrls.size === 0 && draftUrls.size === 0) return 1;
  if (originalUrls.size === 0) return 0.5; // New URLs added

  let preserved = 0;
  for (const url of originalUrls) {
    if (draftUrls.has(url)) preserved++;
  }

  return preserved / originalUrls.size;
}

/** Heading and list structure preserved. */
function structureCheck(draft: string, original: string): number {
  const HEADING = /^#{1,6}\s/gm;
  const LIST = /^\s*[-*+]\s/gm;

  const origHeadings = countMatches(HEADING, original);
  const draftHeadings = countMatches(HEADING, draft);
  const origList = countMatches(LIST, original);
  const draftList = countMatches(LIST, draft);

  // Allow some growth (new sections) but not drastic shrinkage
  const headingScore =
    origHeadings === 0 ? 1 : draftHeadings >= origHeadings ? 1 : draftHeadings / origHeadings;

  const listScore = origList === 0 ? 1 : Math.min(draftList / origList, 1);

  return (headingScore + listScore) / 2;
}

/** Count global regex matches without using `String.match()`. */
function countMatches(re: RegExp, text: string): number {
  let count = 0;
  const local = new RegExp(re.source, re.flags);
  while (local.exec(text) !== null) count++;
  return count;
}

/** Prose length falls within plausible range (0.5x–2x original). */
function lengthCheck(draft: string, original: string): number {
  const origProse = proseLength(original);
  const draftProse = proseLength(draft);

  if (origProse === 0) return draftProse > 0 ? 1 : 0;

  const ratio = draftProse / origProse;
  if (ratio >= 0.5 && ratio <= 2) return 1;
  if (ratio < 0.5) return ratio; // Degrades linearly to 0
  return Math.max(0, 2 - ratio); // Degrades linearly from 2x
}

/** Glossary terms preserved in the draft. Only terms present in the original are scored. */
function glossaryCheck(draft: string, original: string, glossaryTerms: readonly string[]): number {
  return termsPreserved(original, draft, glossaryTerms).value;
}

/** Approximate prose character count (excluding code segments). */
function proseLength(markdown: string): number {
  return segments(markdown)
    .filter((s) => s.kind === "prose")
    .reduce((sum, s) => sum + s.text.length, 0);
}
