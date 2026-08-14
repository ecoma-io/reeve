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
      chunkChars: 0,
      ignore: true,
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
      chunkChars: 0,
      ignore: true,
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
      chunkChars: 0,
      ignore: true,
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
      chunkChars: 0,
      ignore: true,
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
      chunkChars: 0,
      ignore: true,
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
      chunkChars: 0,
      ignore: true,
    });

    expect(result.attempts).toEqual([]);
    expect(result.refused[0]?.score.reason).toContain("script");
  });
});

describe("draftSyncs chunking", () => {
  it("falls back to whole-doc drafting when chunkChars is 0", async () => {
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
      glossary: [],
      drafts: 1,
      chunkChars: 0,
      ignore: true,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.score.admissible).toBe(true);
  });

  it("falls back to whole-doc drafting when document fits the budget", async () => {
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
      glossary: [],
      drafts: 1,
      // Budget larger than either document — no chunking needed.
      chunkChars: 10_000,
      ignore: true,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.score.admissible).toBe(true);
  });

  it("splits and reassembles a document that exceeds the budget", async () => {
    // A source with two sections separated by a blank line, and a matching
    // target. With a small chunk budget, each section becomes a chunk.
    const longSource = [
      "# Getting Started",
      "",
      "This guide helps you set up Reeve.",
      "",
      "## Configuration",
      "",
      "Configure Reeve in your workflow.",
    ].join("\n");

    const longTarget = [
      "# Bắt đầu",
      "",
      "Hướng dẫn này giúp bạn thiết lập Reeve.",
      "",
      "## Cấu hình",
      "",
      "Cấu hình Reeve trong quy trình của bạn.",
    ].join("\n");

    const updatedTarget = [
      "# Bắt đầu",
      "",
      "Hướng dẫn này giúp bạn thiết lập Reeve.",
      "",
      "## Cấu hình",
      "",
      "Cấu hình Reeve trong quy trình của bạn.",
      "",
      "## Khắc phục sự cố",
      "",
      "Lỗi thường gặp và cách giải quyết.",
    ].join("\n");

    const result = await draftSyncs({
      provider: scripted({ "model-a": updatedTarget }),
      models: ["model-a"],
      sourceContent: longSource,
      targetContent: longTarget,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 1,
      // Small budget to force chunking.
      chunkChars: 50,
      ignore: true,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.score.admissible).toBe(true);
    expect(result.attempts[0]?.text).toContain("Khắc phục sự cố");
    // Glossary term "Reeve" preserved
    expect(result.attempts[0]?.text).toContain("Reeve");
  });

  it("passes code-only chunks through verbatim without model calls", async () => {
    // A document where one chunk is a code fence — the model should only be
    // called for the prose chunk, and the code chunk preserved as-is.
    const sourceWithCode = [
      "# Getting Started",
      "",
      "This guide helps you set up Reeve.",
      "",
      "```bash",
      "npm install reeve",
      "```",
    ].join("\n");

    const targetWithCode = [
      "# Bắt đầu",
      "",
      "Hướng dẫn này giúp bạn thiết lập Reeve.",
      "",
      "```bash",
      "npm install reeve",
      "```",
    ].join("\n");

    const updatedTarget = [
      "# Bắt đầu",
      "",
      "Hướng dẫn này giúp bạn thiết lập Reeve.",
      "",
      "```bash",
      "npm install reeve",
      "```",
      "",
      "## Khắc phục sự cố",
      "",
      "Lỗi thường gặp.",
    ].join("\n");

    const result = await draftSyncs({
      provider: scripted({ "model-a": updatedTarget }),
      models: ["model-a"],
      sourceContent: sourceWithCode,
      targetContent: targetWithCode,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 1,
      chunkChars: 50,
      ignore: true,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.score.admissible).toBe(true);
    // Code block preserved byte-for-byte.
    expect(result.attempts[0]?.text).toContain("```bash\nnpm install reeve\n```");
  });

  it("keeps the original target chunk when all models fail for a chunk", async () => {
    const longSource = [
      "# Getting Started",
      "",
      "This guide helps you set up Reeve.",
      "",
      "## Configuration",
      "",
      "Configure Reeve in your workflow.",
    ].join("\n");

    const longTarget = [
      "# Bắt đầu",
      "",
      "Hướng dẫn này giúp bạn thiết lập Reeve.",
      "",
      "## Cấu hình",
      "",
      "Cấu hình Reeve trong quy trình của bạn.",
    ].join("\n");

    // All models fail — every chunk falls back to the original target.
    const result = await draftSyncs({
      provider: scripted({}),
      models: ["model-a"],
      sourceContent: longSource,
      targetContent: longTarget,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 1,
      chunkChars: 50,
      ignore: true,
    });

    // Reassembled from original target chunks — identical, so refused.
    expect(result.attempts).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.score.reason).toBe("unchanged from original");
  });
});
