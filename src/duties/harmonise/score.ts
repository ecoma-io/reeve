/**
 * Deterministic scoring of a `harmonise` sync draft.
 *
 * Unlike `translate`'s scoring (which compares a draft against its source),
 * `harmonise` scoring compares the draft against the *original target* — the
 * goal is to verify that the draft preserves the target's structure while
 * incorporating the semantic changes.
 *
 * Checks:
 * - Language: draft is in the target language (script check)
 * - Code fidelity: fenced blocks and inline spans carried across unchanged
 * - Link fidelity: URLs unchanged
 * - Structure: heading and list structure preserved
 * - Length: prose length falls within plausible range
 * - Glossary: glossary terms respected
 */
import { containsScript } from "../../core/script.js";
import { segments } from "../../core/markdown.js";
import { measured, refused, type Score, type Check } from "../../core/score.js";
import type { Language } from "../../core/languages.js";

/**
 * Scores a draft against the original target content.
 *
 * Returns a `Score` — refused for provably wrong drafts, measured for
 * admissible ones. See `core/score.ts` for what admissibility means.
 */
export function scoreDraft(
  draft: string,
  original: string,
  glossaryTerms: readonly string[],
  source: string,
  targetLanguage: Language,
  languages: readonly Language[],
): Score {
  // --- Refusal checks (binary, provably wrong) ---
  if (draft.trim().length === 0) return refused("empty draft");
  if (draft === original) return refused("unchanged from original");
  for (const term of glossaryTerms) {
    if (original.includes(term) && !draft.includes(term)) {
      return refused(`glossary term \`${term}\` was translated`);
    }
  }

  // Language verification: a draft in the wrong script is refused.
  const script = foreignScript(source, draft, targetLanguage, languages);
  if (script !== null) {
    return refused(`draft contains \`${script}\` script not in source or target language`);
  }

  // --- Measurements (weighted mean, 0-1) ---
  const checks: Check[] = [
    { name: "code", weight: 4, value: codeCheck(draft, original), note: "" },
    { name: "links", weight: 3, value: linkCheck(draft, original), note: "" },
    { name: "structure", weight: 2, value: structureCheck(draft, original), note: "" },
    { name: "length", weight: 1, value: lengthCheck(draft, original), note: "" },
    { name: "glossary", weight: 3, value: glossaryCheck(draft, original, glossaryTerms), note: "" },
  ];

  return measured(checks);
}

/**
 * Whether the draft has leaked into a script neither the target language nor
 * the source uses — a script from some other language in this workflow's
 * configuration.
 *
 * The same logic as `translate/score.ts`'s `foreignScript`: a script the
 * source already used is not a leak (the target is supposed to carry it). A
 * script the target's own language uses is not a leak (it is the expected
 * outcome). Anything else is a draft that wrote in the wrong language.
 */
function foreignScript(
  source: string,
  draft: string,
  to: Language,
  languages: readonly Language[],
): string | null {
  for (const language of languages) {
    for (const script of language.scripts) {
      // The target's own scripts are exempted per character rather than skipped
      // by name, so a workflow that spelled the same script `Latn` here and
      // `Latin` there still gets one answer. `containsScript` explains why that
      // works.
      if (!containsScript(draft, script, to.scripts)) continue;
      if (containsScript(source, script, to.scripts)) continue;
      return script;
    }
  }
  return null;
}

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

/** Glossary terms preserved in the draft. */
function glossaryCheck(draft: string, _original: string, glossaryTerms: readonly string[]): number {
  if (glossaryTerms.length === 0) return 1;

  let preserved = 0;
  for (const term of glossaryTerms) {
    if (draft.includes(term)) preserved++;
  }

  return preserved / glossaryTerms.length;
}

/** Approximate prose character count (excluding code segments). */
function proseLength(markdown: string): number {
  return segments(markdown)
    .filter((s) => s.kind === "prose")
    .reduce((sum, s) => sum + s.text.length, 0);
}
