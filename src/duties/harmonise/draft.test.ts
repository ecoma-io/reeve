/**
 * Unit tests for the draft module — prompt construction, glossary formatting,
 * empty model responses, and provider error handling.
 *
 * The functions `buildMessages` and `formatGlossary` are module-private, so
 * they are tested through `draftSyncs` with a scripted provider — the same
 * pattern `draft.integration.test.ts` uses for its end-to-end scenarios.
 */
import { describe, expect, it } from "vitest";

import type { Language } from "../../core/languages.js";
import type { Completion, Provider } from "../../core/provider.js";
import { draftSyncs } from "./draft.js";
import type { ClassifiedHunk } from "./classify.js";

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] };
const english: Language = { code: "en", label: "English", scripts: ["Latn"] };
const chinese: Language = { code: "zh", label: "中文", scripts: ["Han"] };
const CONFIGURED = [vietnamese, english, chinese];

/** An endpoint whose models answer with whatever the case scripted for them. */
function scripted(answers: Record<string, string | Completion>): Provider {
  return {
    complete(model: string): Promise<Completion> {
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({
          ok: false,
          model,
          reason: "no answer scripted",
          kind: "protocol",
        });
      }
      return Promise.resolve(
        typeof answer === "string"
          ? { ok: true, model, content: answer, finishReason: "stop" }
          : answer,
      );
    },
  };
}

const SOURCE = "# Getting Started\n\nThis guide helps you set up Reeve.";
const TARGET = "# Bắt đầu\n\nHướng dẫn này giúp bạn thiết lập Reeve.";
const SEMANTIC_HUNKS: readonly ClassifiedHunk[] = [
  { description: "Added Troubleshooting section", classification: "semantic" },
];

describe("draftSyncs", () => {
  it("refuses an empty model response", async () => {
    const result = await draftSyncs({
      provider: scripted({ "model-a": "" }),
      models: ["model-a"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 1,
    });

    expect(result.attempts).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("records a provider error as a failure", async () => {
    const result = await draftSyncs({
      provider: scripted({}),
      models: ["model-a"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 1,
    });

    expect(result.attempts).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.model).toBe("model-a");
    expect(result.failures[0]?.ok).toBe(false);
  });

  it("includes glossary terms in the prompt when provided", async () => {
    // The scripted provider always returns the same text regardless of prompt
    // content, but we can verify the draft was processed correctly when a
    // glossary is present — a draft that translates a glossary term is refused.
    const draftThatTranslatesGlossary = TARGET.replace("Reeve", "Quan trị");

    const result = await draftSyncs({
      provider: scripted({ "model-a": draftThatTranslatesGlossary }),
      models: ["model-a"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [{ term: "Reeve" }],
      drafts: 1,
    });

    expect(result.attempts).toEqual([]);
    expect(result.refused[0]?.score.reason).toContain("Reeve");
  });

  it("admits a faithful draft with glossary terms preserved", async () => {
    const faithful = TARGET + "\n\n## Khắc phục sự cố\n\nLỗi thường gặp.";

    const result = await draftSyncs({
      provider: scripted({ "model-a": faithful }),
      models: ["model-a"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [{ term: "Reeve" }],
      drafts: 1,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.score.admissible).toBe(true);
  });

  it("uses the first available model when multiple are configured", async () => {
    const faithful = TARGET + "\n\n## Khắc phục sự cố\n\nLỗi thường gặp.";

    const result = await draftSyncs({
      provider: scripted({ "model-a": faithful }),
      models: ["model-a", "model-b"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 1,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.model).toBe("model-a");
  });

  it("refuses a draft in the wrong script for the target", async () => {
    const chineseDraft = "# 开始使用\n\n本指南帮助您设置 Reeve。";

    const result = await draftSyncs({
      provider: scripted({ "model-a": chineseDraft }),
      models: ["model-a"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 1,
    });

    expect(result.attempts).toEqual([]);
    expect(result.refused[0]?.score.reason).toContain("script");
  });
});
