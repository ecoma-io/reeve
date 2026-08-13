/**
 * Diff classification for the `harmonise` duty.
 *
 * When a contributor edits a locale file, `harmonise` must classify the diff
 * before deciding whether to propagate:
 *
 * 1. **Translation correction** — fixing a bad translation → NO propagation
 * 2. **Shared semantic change** — new section, changed meaning → PROPAGATE
 * 3. **Locale-specific adaptation** — local link, local example → NO propagation
 *
 * Code cannot distinguish "this diff fixes a bad translation" from "this diff
 * adds new meaning" without understanding the text. The model classifies each
 * change, and code enforces the result: only `semantic` changes are
 * translated and applied to other locales.
 */
import * as core from "@actions/core";
import type { Provider } from "../../core/provider.js";

/** The three classification outcomes. */
export type Classification = "semantic" | "correction" | "locale-specific";

/** One hunk of a source diff, classified. */
export interface ClassifiedHunk {
  /** A short description of what changed. */
  readonly description: string;
  readonly classification: Classification;
}

/** The classification result for a source diff. */
export interface ClassificationResult {
  readonly hunks: readonly ClassifiedHunk[];
  /** Whether any hunk is semantic — if not, no propagation needed. */
  readonly hasSemantic: boolean;
}

/** The prompt shape for classification. */
export const CLASSIFICATION_PURPOSE = "classify" as const;

/**
 * Classifies a source diff against the target locale's current state.
 *
 * This is a model call — the model receives the source diff and the target's
 * current content, and returns a classification for each distinct change.
 *
 * The classification is then enforced in code: only `semantic` hunks trigger
 * propagation. This is the same pattern `triage` uses — the model proposes,
 * code enforces.
 */
export async function classifyDiff(
  sourceDiff: string,
  targetContent: string,
  sourceLocale: string,
  targetLocale: string,
  classifier: Provider,
  model: string,
): Promise<ClassificationResult> {
  const prompt = buildClassificationPrompt(sourceDiff, targetContent, sourceLocale, targetLocale);

  const result = await classifier.complete(model, [
    { role: "system", content: CLASSIFICATION_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);

  if (!result.ok) {
    // A classification failure is a run that cannot decide what to propagate.
    // Fail loud — never silently skip propagation (D5).
    throw new Error(
      `harmonise: classification failed — ${result.reason}. ` +
        "The run cannot decide what to propagate without this classification.",
    );
  }

  return parseClassification(result.content);
}

/**
 * The system prompt for classification.
 *
 * The model must return structured output — one classification per line,
 * prefixed with the classification type.
 */
const CLASSIFICATION_SYSTEM_PROMPT = `You classify changes in a source document against its locale translation.

Given a diff of the source document and the current content of the target
locale's translation, classify each distinct change as exactly one of:

- semantic: A shared meaning change — new section, changed instruction,
  updated fact, corrected error. These changes MUST propagate to all locales.
- correction: A translation quality fix — improving word choice, fixing grammar
  in the source language, adjusting tone. These are LOCAL to the source and
  must NOT propagate.
- locale-specific: A locale-specific adaptation — local link, local example,
  regional note, legal disclaimer specific to one jurisdiction. These are LOCAL
  to the source and must NOT propagate.

For each distinct change, output one line:
CLASSIFICATION|description

Example output:
semantic|Added "Troubleshooting" section with common errors
semantic|Updated API rate limit instructions from 100 to 200 requests
correction|Fixed typo "teh" to "the"
locale-specific|Added link to Vietnamese community forum

Output ONLY classification lines. No other text.`;

function buildClassificationPrompt(
  sourceDiff: string,
  targetContent: string,
  sourceLocale: string,
  targetLocale: string,
): string {
  return `Source locale: ${sourceLocale}
Target locale: ${targetLocale}

Source diff (what changed in the source document):
${sourceDiff}

Target locale's current translation:
${targetContent}

Classify each distinct change in the source diff.`;
}

/**
 * Parses the model's classification output.
 *
 * Each line is `CLASSIFICATION|description`. Unknown classifications are
 * treated as corrections (fail-safe: don't propagate what you don't
 * understand).
 */
export function parseClassification(raw: string): ClassificationResult {
  const hunks: ClassifiedHunk[] = [];
  const lines = raw.trim().split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const pipeIndex = trimmed.indexOf("|");
    if (pipeIndex === -1) continue;

    const classification = trimmed.slice(0, pipeIndex).trim().toLowerCase();
    const description = trimmed.slice(pipeIndex + 1).trim();

    // Fail-safe: unknown classifications are corrections (no propagation)
    let typed: Classification;
    if (classification === "semantic") {
      typed = "semantic";
    } else if (classification === "correction") {
      typed = "correction";
    } else if (classification === "locale-specific") {
      typed = "locale-specific";
    } else {
      // Unknown — treat as correction (safe: no propagation)
      typed = "correction";
    }

    hunks.push({ description, classification: typed });
  }

  // If the model produced no parseable output, fail loud (D5)
  if (hunks.length === 0) {
    // No classification = no propagation. This is a safe default but we
    // warn — it likely means the model didn't understand the prompt.
    core.warning(
      "harmonise: classifier produced no parseable output — the model may not have " +
        "understood the prompt. No changes will be propagated.",
    );
    return { hunks: [], hasSemantic: false };
  }

  return {
    hunks,
    hasSemantic: hunks.some((h) => h.classification === "semantic"),
  };
}
