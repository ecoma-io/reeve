/**
 * Drafting for the `harmonise` duty: producing an updated locale translation
 * that incorporates shared semantic changes while preserving existing good
 * translations and locale-specific content.
 *
 * Unlike `translate`'s drafting, which translates a source text from scratch,
 * `harmonise`'s drafting starts from the target locale's existing content and
 * applies only the semantic changes that need propagation.
 */
import { type Provider } from "../../core/provider.js";
import type { Language } from "../../core/languages.js";
import type { ClassifiedHunk } from "./classify.js";

/** The purpose name for meter tracking. */
export const DRAFT_PURPOSE = "draft" as const;

/** One draft attempt for a stale locale. */
export interface Draft {
  readonly text: string;
  readonly model: string;
  readonly score: number;
}

/**
 * Produces an updated target translation that incorporates the semantic
 * changes from the source.
 *
 * The prompt includes:
 * - The source file's current content (the authoritative version)
 * - The target file's current content (what needs updating)
 * - The classified semantic hunks (what specifically changed)
 * - The glossary (project-specific terms that must not be translated)
 */
export async function draftSync(
  sourceContent: string,
  targetContent: string,
  semanticHunks: readonly ClassifiedHunk[],
  sourceLanguage: Language,
  targetLanguage: Language,
  glossary: readonly GlossaryEntry[],
  drafter: Provider,
  model: string,
): Promise<Draft | null> {
  const glossarySection = formatGlossary(glossary);

  const prompt = buildDraftPrompt(
    sourceContent,
    targetContent,
    semanticHunks,
    sourceLanguage,
    targetLanguage,
    glossarySection,
  );

  const result = await drafter.complete(model, [
    { role: "system", content: DRAFT_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);

  if (!result.ok || !result.content || result.content.trim().length === 0) {
    return null;
  }

  return {
    text: result.content,
    model: result.model,
    score: 0, // Scored later by score.ts
  };
}

/** A glossary entry read from `.reeve/glossary.yml`. */
export interface GlossaryEntry {
  readonly term: string;
  readonly note?: string;
}

function formatGlossary(entries: readonly GlossaryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.term}${e.note ? `: ${e.note}` : ""}`);
  return `## Glossary (do NOT translate these terms)\n\n${lines.join("\n")}`;
}

const DRAFT_SYSTEM_PROMPT = `You update a locale translation to incorporate semantic changes from the source document.

Rules:
1. Preserve the target locale's existing structure and good translations.
2. Only apply the semantic changes listed — do NOT re-translate everything.
3. Preserve locale-specific sections, links, and examples that exist only in the target.
4. Preserve code blocks, inline code, and URLs byte-for-byte.
5. Respect the glossary — glossary terms must NOT be translated.
6. Output the COMPLETE updated target file, not just the changed sections.
7. Do NOT add content that exists only in the source as locale-specific.
8. If a semantic change replaces a heading, update the corresponding heading in the target.`;

function buildDraftPrompt(
  sourceContent: string,
  targetContent: string,
  semanticHunks: readonly ClassifiedHunk[],
  sourceLanguage: Language,
  targetLanguage: Language,
  glossarySection: string,
): string {
  const changes = semanticHunks.map((h) => `- ${h.description}`).join("\n");

  return `Source language: ${sourceLanguage.label}
Target language: ${targetLanguage.label}

Semantic changes to propagate:
${changes}
${glossarySection ? `\n${glossarySection}\n` : ""}
Source document (authoritative):
${sourceContent}

Target locale's current translation:
${targetContent}

Produce the complete updated target translation incorporating only the semantic changes listed above.`;
}
