/**
 * Drafting a harmonisation with the real scorer, the real sanitizer, and the
 * real script checker behind it — everything except the endpoint.
 *
 * The endpoint is the one collaborator that stays scripted, and not because it
 * is awkward: a test that reached a model would be measuring somebody's free
 * tier rather than this module, and would answer differently on every run. What
 * is worth proving here is what happens to an answer *after* it arrives, and
 * that is precisely the chain the unit tests stub flat.
 */
import { describe, expect, it } from "vitest";

import type { Language } from "../../core/languages.js";
import type { Completion, Provider } from "../../core/provider.js";
import { draftSyncs } from "./draft.js";
import type { ClassifiedHunk } from "./classify.js";
import { scored } from "./checks.testing.js";

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

const SOURCE = [
  "# Getting Started",
  "",
  "This guide helps you set up Reeve.",
  "",
  "```bash",
  "npm install reeve",
  "```",
  "",
  "See [docs](https://reeve.dev) for more.",
].join("\n");

const TARGET = [
  "# Bắt đầu",
  "",
  "Hướng dẫn này giúp bạn thiết lập Reeve.",
  "",
  "```bash",
  "npm install reeve",
  "```",
  "",
  "Xem [tài liệu](https://reeve.dev) để biết thêm.",
].join("\n");

const SEMANTIC_HUNKS: readonly ClassifiedHunk[] = [
  { description: "Added Troubleshooting section", classification: "semantic" },
];

const FAITHFUL = [
  "# Bắt đầu",
  "",
  "Hướng dẫn này giúp bạn thiết lập Reeve.",
  "",
  "```bash",
  "npm install reeve",
  "```",
  "",
  "Xem [tài liệu](https://reeve.dev) để biết thêm.",
  "",
  "## Khắc phục sự cố",
  "",
  "Lỗi thường gặp và cách giải quyết.",
].join("\n");

describe("drafting a harmonisation", () => {
  it("admits a faithful draft and hands back text safe to publish", async () => {
    const result = await draftSyncs({
      provider: scripted({ "model-a": FAITHFUL }),
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

    const [best] = result.attempts;
    expect(best?.score.admissible).toBe(true);
    expect(best?.score.value).toBeGreaterThan(0.5);
    expect(best?.text).toContain("npm install reeve");
    expect(best?.text).toContain("https://reeve.dev");
    expect(best?.text).toContain("Reeve");
  });

  it("refuses a draft identical to the target", async () => {
    const result = await draftSyncs({
      provider: scripted({ "model-a": TARGET }),
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
    expect(result.refused[0]?.score.reason).toBe("unchanged from original");
  });

  it("admits a draft that translates glossary terms, ranked down for it", async () => {
    const draft = FAITHFUL.replace("Reeve", "Quan trị");
    const result = await draftSyncs({
      provider: scripted({ "model-a": draft }),
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

    // Admitted rather than refused: with `drafts: 1` a refusal is the locale
    // left un-synced, not a fallback to a better candidate. The loss shows in
    // the rank instead — see `score.ts`.
    expect(result.refused).toEqual([]);
    expect(result.attempts).toHaveLength(1);
    expect(scored(result.attempts[0], "glossary")).toBe(0);
  });

  it("ranks the draft that preserves code above the one that translates it", async () => {
    const mangled = FAITHFUL.replace("npm install reeve", "npm cài_đặt reeve");

    const result = await draftSyncs({
      provider: scripted({ "model-a": mangled, "model-b": FAITHFUL }),
      models: ["model-a", "model-b"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 2,
      chunkChars: 0,
      ignore: true,
    });

    expect(result.attempts.map((attempt) => attempt.model)).toEqual(["model-b", "model-a"]);
    expect(result.attempts[0]?.score.value).toBeGreaterThan(
      result.attempts[1]?.score.value ?? Number.NaN,
    );
  });

  it("moves to the next model when the first one is cut off", async () => {
    const result = await draftSyncs({
      provider: scripted({
        "model-a": { ok: true, model: "model-a", content: "# Bắt đ", finishReason: "length" },
        "model-b": FAITHFUL,
      }),
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

    expect(result.attempts.map((attempt) => attempt.model)).toEqual(["model-b"]);
    expect(result.failures).toEqual([
      {
        ok: false,
        model: "model-a",
        reason: "the answer was cut off before it finished",
        kind: "protocol",
      },
    ]);
  });

  it("reports a language nothing could be drafted for as skipped, not as a crash", async () => {
    const result = await draftSyncs({
      provider: scripted({}),
      models: ["model-a", "model-b"],
      sourceContent: SOURCE,
      targetContent: TARGET,
      semanticHunks: SEMANTIC_HUNKS,
      sourceLanguage: english,
      targetLanguage: vietnamese,
      languages: CONFIGURED,
      glossary: [],
      drafts: 2,
      chunkChars: 0,
      ignore: true,
    });

    expect(result.attempts).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.failures.map((failure) => failure.model)).toEqual(["model-a", "model-b"]);
  });

  it("admits a draft in the wrong script for the target, scored at zero for it", async () => {
    // A Chinese draft for a Vietnamese target — the Han script is neither the
    // target's nor present in the source, so `scriptLeak` reports it.
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

    // Wholly foreign, so the check reads zero and this draft loses to any
    // other the run produced — which is the difference between ranking it and
    // throwing it out, and the difference between a bad sync and no sync.
    expect(result.refused).toEqual([]);
    expect(scored(result.attempts[0], "script")).toBe(0);
  });
});
