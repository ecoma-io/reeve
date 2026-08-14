/**
 * Drafting for the `harmonise` duty: producing an updated locale translation
 * that incorporates shared semantic changes while preserving existing good
 * translations and locale-specific content.
 *
 * Unlike `translate`'s drafting, which translates a source text from scratch,
 * `harmonise`'s drafting starts from the target locale's existing content and
 * applies only the semantic changes that need propagation.
 *
 * This is where the `drafts` input is spent. Each draft is scored
 * deterministically, and the admitted ones are handed to the judge panel (or
 * the best score wins when no panel is configured). The loop follows the same
 * pattern `translate` uses: rotation through models, exhaustion memory, and
 * scoring inside the loop so the judge only sees admissible candidates.
 */
import * as core from "@actions/core";

import type { Language } from "../../core/languages.js";
import { chunks, isCodeOnly } from "../../core/markdown.js";
import type { Completion, Failure, Provider, Weather } from "../../core/provider.js";
import { rotateModels } from "../../core/provider.js";
import { sanitize } from "../../core/sanitize.js";
import type { Score } from "../../core/score.js";

import type { ClassifiedHunk } from "./classify.js";
import { extract, reinsert, type IgnoreSpan } from "./ignore.js";
import { scoreDraft } from "./score.js";

/** The purpose name for meter tracking. */
export const DRAFT_PURPOSE = "draft" as const;

/** One draft attempt for a stale locale, measured and made safe to publish. */
export interface Draft {
  /** The model that produced it. */
  readonly model: string;
  /** The draft text, sanitized — ready to be published. */
  readonly text: string;
  readonly score: Score;
}

/** The outcome of the draft loop for one stale locale. */
export interface DraftResult {
  /**
   * Every admitted draft, best score first. Empty when no model produced a
   * draft that could be admitted.
   */
  readonly attempts: readonly Draft[];
  /**
   * The attempts scoring refused. Kept because "every model answered in the
   * wrong language" is a configuration problem the log has to be able to state.
   */
  readonly refused: readonly Draft[];
  /** Every model that failed, across all drafts, in the order tried. */
  readonly failures: readonly Failure[];
}

export interface DraftSyncRequest {
  readonly provider: Provider;
  /** Model ids in preference order. */
  readonly models: readonly string[];
  /** The source file's current content (the authoritative version). */
  readonly sourceContent: string;
  /** The target locale's current content (what needs updating). */
  readonly targetContent: string;
  /** The classified semantic hunks (what specifically changed). */
  readonly semanticHunks: readonly ClassifiedHunk[];
  readonly sourceLanguage: Language;
  readonly targetLanguage: Language;
  /**
   * Every configured language, which scoring needs in full: a script that has
   * leaked into a draft can only be named against a script somebody asked for.
   */
  readonly languages: readonly Language[];
  readonly glossary: readonly GlossaryEntry[];
  /** How many drafts to ask for. Fewer are produced when the models run out. */
  readonly drafts: number;
  /** This run's memory of capacity failures. */
  readonly weather?: Weather;
  /**
   * Maximum character budget per drafting request. Zero sends the whole
   * document; a positive value splits source and target into aligned chunks
   * at Markdown boundaries and drafts each chunk independently.
   */
  readonly chunkChars: number;
  /** Whether to honour `<!-- reeve:ignore-* -->` markers. */
  readonly ignore: boolean;
}

/**
 * Produces multiple draft harmonisations for a stale locale, scores each, and
 * returns the admitted and refused attempts.
 *
 * The loop rotates through `models` so consecutive drafts prefer different
 * models. A model that fails is exhausted for the whole locale, not for one
 * draft. The scoring runs inside the loop so the judge panel only ever sees
 * admissible candidates.
 */
export async function draftSyncs(request: DraftSyncRequest): Promise<DraftResult> {
  const {
    provider,
    models,
    sourceContent,
    targetContent,
    semanticHunks,
    sourceLanguage,
    targetLanguage,
    languages,
    glossary,
    drafts,
    weather,
    chunkChars,
    ignore,
  } = request;

  // Extract ignore markers from source and target. The model sees
  // placeholder comments where ignored blocks were, and the original
  // target content is reinserted after sanitize runs.
  const sourceResult = ignore ? extract(sourceContent) : undefined;
  const targetResult = ignore ? extract(targetContent) : undefined;
  const maskedSource = sourceResult?.content ?? sourceContent;
  const maskedTarget = targetResult?.content ?? targetContent;
  const targetSpans = targetResult?.spans ?? [];

  if (chunkChars > 0 && (maskedSource.length > chunkChars || maskedTarget.length > chunkChars)) {
    return draftChunked({
      ...request,
      sourceContent: maskedSource,
      targetContent: maskedTarget,
      targetSpans,
    });
  }

  return draftWhole({
    provider,
    models,
    sourceContent: maskedSource,
    targetContent: maskedTarget,
    semanticHunks,
    sourceLanguage,
    targetLanguage,
    languages,
    glossary,
    drafts,
    targetSpans,
    ...(weather !== undefined ? { weather } : {}),
  });
}

/**
 * Drafts the whole document in one request — the original behaviour and the
 * default when `chunkChars` is zero or the document fits the budget.
 */
async function draftWhole(params: DraftWholeParams): Promise<DraftResult> {
  const {
    provider,
    models,
    sourceContent,
    targetContent,
    semanticHunks,
    sourceLanguage,
    targetLanguage,
    languages,
    glossary,
    drafts,
    weather,
    targetSpans,
  } = params;

  const messages = buildMessages(
    sourceContent,
    targetContent,
    semanticHunks,
    sourceLanguage,
    targetLanguage,
    glossary,
  );

  return draftLoop({
    provider,
    models,
    messages,
    targetContent,
    sourceContent,
    targetLanguage,
    languages,
    glossaryTerms: glossary.map((g) => g.term),
    drafts,
    targetSpans,
    ...(weather !== undefined ? { weather } : {}),
  });
}

/** Parameters for `draftWhole` — a subset of `DraftSyncRequest`. */
interface DraftWholeParams {
  readonly provider: Provider;
  readonly models: readonly string[];
  readonly sourceContent: string;
  readonly targetContent: string;
  readonly semanticHunks: readonly ClassifiedHunk[];
  readonly sourceLanguage: Language;
  readonly targetLanguage: Language;
  readonly languages: readonly Language[];
  readonly glossary: readonly GlossaryEntry[];
  readonly drafts: number;
  readonly targetSpans: readonly IgnoreSpan[];
  readonly weather?: Weather;
}

/**
 * Splits source and target into aligned chunks at Markdown boundaries and
 * drafts each chunk independently, then reassembles the results.
 *
 * Code-only chunks are passed through verbatim — no model request is spent on
 * text that cannot change. Each prose chunk is drafted with its own prompt
 * that provides the chunk's source and target, the full list of semantic
 * hunks, and the glossary. Scoring applies to the full reassembled draft.
 */
async function draftChunked(
  request: DraftSyncRequest & { targetSpans: readonly IgnoreSpan[] },
): Promise<DraftResult> {
  const {
    provider,
    models,
    sourceContent,
    targetContent,
    semanticHunks,
    sourceLanguage,
    targetLanguage,
    languages,
    glossary,
    drafts,
    weather,
    chunkChars,
    targetSpans,
  } = request;

  const sourceChunks = chunks(sourceContent, chunkChars);
  const targetChunks = chunks(targetContent, chunkChars);

  // Aligned drafting: pair source and target chunks by index. When one document
  // has more chunks than the other (structural divergence), the extra chunks
  // are drafted alone with source or target empty respectively.
  const count = Math.max(sourceChunks.length, targetChunks.length);

  // Seeded from `weather`, so a model an earlier chunk already grounded for
  // capacity is treated as exhausted from chunk zero.
  const exhausted = new Set<string>(weather?.starved ?? []);
  const chunkDrafts: string[] = [];
  const failures: Failure[] = [];

  for (let i = 0; i < count; i += 1) {
    const sourceChunk = sourceChunks[i] ?? "";
    const targetChunk = targetChunks[i] ?? "";

    // Code-only chunks are passed through verbatim — no model request needed.
    if (isCodeOnly(sourceChunk) && isCodeOnly(targetChunk)) {
      // Prefer the target's code block (it is the locale's version).
      chunkDrafts.push(targetChunk.length > 0 ? targetChunk : sourceChunk);
      continue;
    }

    const messages = buildMessages(
      sourceChunk,
      targetChunk,
      semanticHunks,
      sourceLanguage,
      targetLanguage,
      glossary,
    );

    // Try each draft for this chunk, rotating through models.
    let chunkText: string | null = null;
    for (let draft = 0; draft < drafts; draft += 1) {
      const order = remaining(models, draft, exhausted);
      if (order.length === 0) break;

      const rotation = await rotateModels(
        order,
        (model) => answer(provider, model, messages),
        weather,
      );
      for (const failure of rotation.failures) {
        exhausted.add(failure.model);
        failures.push(failure);
      }
      if (!rotation.success) break;

      const text = rotation.success.content;
      if (text.trim().length === 0) {
        core.warning(
          `harmonise: ${targetLanguage.code}: chunk ${String(i + 1)}/${String(count)}: model returned empty content`,
        );
        continue;
      }

      chunkText = sanitize(text);
      break;
    }

    if (chunkText !== null) {
      chunkDrafts.push(chunkText);
    } else {
      // Fallback: keep the original target chunk when drafting fails.
      core.warning(
        `harmonise: ${targetLanguage.code}: chunk ${String(i + 1)}/${String(count)}: no draft produced — keeping original`,
      );
      chunkDrafts.push(targetChunk);
    }
  }

  const reassembled = chunkDrafts.join("");

  // Reinsert ignored blocks (replaced by placeholders before chunking).
  const reinserted = reinsert(reassembled, targetSpans);

  // Score the full reassembled draft against the full original target.
  const measured = scoreDraft(
    reinserted,
    targetContent,
    glossary.map((g) => g.term),
    sourceContent,
    targetLanguage,
    languages,
  );

  const attempt: Draft = {
    // Report the first non-exhausted model as the producer, since chunks may
    // have come from different models.
    model: models.find((m) => !exhausted.has(m)) ?? models[0] ?? "unknown",
    text: reinserted,
    score: measured,
  };

  if (measured.admissible) {
    return { attempts: [attempt], refused: [], failures };
  }

  core.warning(
    `harmonise: ${targetLanguage.code}: chunked draft refused — ${measured.reason ?? "unknown"}`,
  );
  return { attempts: [], refused: [attempt], failures };
}

/**
 * The inner draft loop: rotates through models, scores each result, and
 * collects admitted and refused attempts.
 */
async function draftLoop(params: DraftLoopParams): Promise<DraftResult> {
  const {
    provider,
    models,
    messages,
    targetContent,
    sourceContent,
    targetLanguage,
    languages,
    glossaryTerms,
    drafts,
    weather,
    targetSpans,
  } = params;

  const attempts: Draft[] = [];
  const refused: Draft[] = [];
  const failures: Failure[] = [];
  const exhausted = new Set<string>(weather?.starved ?? []);

  for (let draft = 0; draft < drafts; draft += 1) {
    const order = remaining(models, draft, exhausted);
    if (order.length === 0) break;

    const rotation = await rotateModels(
      order,
      (model) => answer(provider, model, messages),
      weather,
    );
    for (const failure of rotation.failures) {
      exhausted.add(failure.model);
      failures.push(failure);
    }
    if (!rotation.success) break;

    const draftText = rotation.success.content;
    if (draftText.trim().length === 0) {
      core.warning(`harmonise: ${targetLanguage.code}: model returned empty content — skipping`);
      continue;
    }

    const sanitized = sanitize(draftText);
    // Reinsert ignored blocks (replaced by placeholders before the model call).
    const reinserted = reinsert(sanitized, targetSpans);
    const measured = scoreDraft(
      reinserted,
      targetContent,
      glossaryTerms,
      sourceContent,
      targetLanguage,
      languages,
    );

    const attempt: Draft = {
      model: rotation.success.model,
      text: reinserted,
      score: measured,
    };

    if (measured.admissible) {
      attempts.push(attempt);
    } else {
      core.warning(
        `harmonise: ${targetLanguage.code}: draft refused — ${measured.reason ?? "unknown"}`,
      );
      refused.push(attempt);
    }
  }

  return {
    attempts: [...attempts].sort((left, right) => right.score.value - left.score.value),
    refused,
    failures,
  };
}

interface DraftLoopParams {
  readonly provider: Provider;
  readonly models: readonly string[];
  readonly messages: readonly { role: "system" | "user"; content: string }[];
  readonly targetContent: string;
  readonly sourceContent: string;
  readonly targetLanguage: Language;
  readonly languages: readonly Language[];
  readonly glossaryTerms: readonly string[];
  readonly drafts: number;
  readonly targetSpans: readonly IgnoreSpan[];
  readonly weather?: Weather;
}

/**
 * The models still worth asking, in the order this draft prefers them.
 *
 * The rotation starts at the `draft`th model and wraps, so consecutive drafts
 * come from different models wherever the list is long enough to offer one.
 */
function remaining(
  models: readonly string[],
  draft: number,
  exhausted: ReadonlySet<string>,
): string[] {
  const live = models.filter((model) => !exhausted.has(model));
  // No guard for an empty list: `0 % 0` is NaN, `slice(NaN)` is `slice(0)`, and
  // both halves of an empty array are empty.
  const start = draft % live.length;
  return [...live.slice(start), ...live.slice(0, start)];
}

/**
 * `finish_reason: length` means the model stopped because it ran out of room,
 * not because it was done. An answer cut off mid-sentence is a failed model,
 * not a poor draft — the same convention `translate` applies.
 */
async function answer(
  provider: Provider,
  model: string,
  messages: readonly { role: "system" | "user"; content: string }[],
): Promise<Completion> {
  const completion = await provider.complete(model, messages);
  if (completion.ok && completion.finishReason === "length") {
    return {
      ok: false,
      model,
      kind: "protocol",
      reason: "the answer was cut off before it finished",
    };
  }
  return completion;
}

/** A glossary entry read from the `glossary-dir` input. */
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
8. If a semantic change replaces a heading, update the corresponding heading in the target.
9. HTML comments of the form \`<!-- reeve-keep-section -->\` mark sections that must be reproduced exactly as they appear in the target. Do not modify, translate, or remove them.`;

function buildMessages(
  sourceContent: string,
  targetContent: string,
  semanticHunks: readonly ClassifiedHunk[],
  sourceLanguage: Language,
  targetLanguage: Language,
  glossary: readonly GlossaryEntry[],
): readonly { role: "system" | "user"; content: string }[] {
  const glossarySection = formatGlossary(glossary);
  const changes = semanticHunks.map((h) => `- ${h.description}`).join("\n");

  const userContent = `Source language: ${sourceLanguage.label}
Target language: ${targetLanguage.label}

Semantic changes to propagate:
${changes}
${glossarySection ? `\n${glossarySection}\n` : ""}
Source document (authoritative):
${sourceContent}

Target locale's current translation:
${targetContent}

Produce the complete updated target translation incorporating only the semantic changes listed above.`;

  return [
    { role: "system", content: DRAFT_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}
