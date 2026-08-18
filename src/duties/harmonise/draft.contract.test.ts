/**
 * The harmonise draft stage's roster contract.
 *
 * `draft.test.ts` has one rotation case — "uses the first available model when
 * multiple are configured" — and that case asserts exactly what a `models[0]`
 * regression produces, so it cannot see one. Both drafting paths (whole-
 * document and chunked) survived every roster sabotage before this file: the
 * roster reduced to its first entry, the run-wide `Weather` seed dropped, an
 * empty answer accepted as a draft. None of those turned the suite red.
 *
 * Every case here asserts WHICH MODELS WERE ASKED, in order. `score` is not
 * stubbed — harmonise's scorer is deterministic over the text it is given, and
 * these cases keep the drafts faithful enough to be admitted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "@actions/core";

// Only the reporting functions are replaced. A chunk that produced no draft
// says so in a warning, and that warning is the observable outcome a case
// about rotation depth has to read back.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  info: vi.fn(),
  warning: vi.fn(),
}));

import type { Language } from "../../core/languages.js";
import {
  AuthenticationFailure,
  createWeather,
  type Completion,
  type Provider,
} from "../../core/provider.js";

import { draftSyncs, type DraftSyncRequest } from "./draft.js";
import type { ClassifiedHunk } from "./classify.js";

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] };
const english: Language = { code: "en", label: "English", scripts: ["Latn"] };
const CONFIGURED = [vietnamese, english];

const SOURCE = "# Getting Started\n\nThis guide helps you set up Reeve.";
const TARGET = "# Bắt đầu\n\nHướng dẫn này giúp bạn thiết lập Reeve.";
/** A draft close enough to the target that scoring admits it. */
const DRAFT = "# Bắt đầu\n\nHướng dẫn này giúp bạn thiết lập Reeve ngay hôm nay.";
const SEMANTIC_HUNKS: readonly ClassifiedHunk[] = [
  { description: "Added a sentence", classification: "semantic" },
];

/** A provider that records which models it was asked, in order. */
function recording(answers: Record<string, string | Completion>): {
  provider: Provider;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    provider: {
      complete: vi.fn((model: string) => {
        asked.push(model);
        const answer = answers[model];
        return Promise.resolve<Completion>(
          answer === undefined
            ? { ok: false, model, reason: "no answer scripted", kind: "protocol" }
            : typeof answer === "string"
              ? { ok: true, model, content: answer, finishReason: "stop" }
              : answer,
        );
      }),
    },
  };
}

function request(over: Partial<DraftSyncRequest> = {}): DraftSyncRequest {
  return {
    provider: recording({}).provider,
    models: ["a"],
    sourceContent: SOURCE,
    targetContent: TARGET,
    semanticHunks: SEMANTIC_HUNKS,
    sourceLanguage: english,
    targetLanguage: vietnamese,
    languages: CONFIGURED,
    glossary: [],
    drafts: 1,
    chunkChars: 0,
    ignore: false,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(core.warning).mockReset();
});

describe("the harmonise roster is an ordered fallback chain", () => {
  it("asks_only_the_first_model_when_the_first_model_answers", async () => {
    const { provider, asked } = recording({ a: DRAFT });

    await draftSyncs(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a"]);
  });

  it("falls_back_when_primary_model_fails", async () => {
    const { provider, asked } = recording({ b: DRAFT });

    const result = await draftSyncs(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(result.failures.map((failure) => failure.model)).toEqual(["a"]);
  });

  it("falls_back_through_two_failures_before_the_third_answers", async () => {
    const { provider, asked } = recording({ c: DRAFT });

    await draftSyncs(request({ provider, models: ["a", "b", "c"] }));

    expect(asked).toEqual(["a", "b", "c"]);
  });

  it("drafts_nothing_and_names_every_model_when_all_models_are_exhausted", async () => {
    const { provider, asked } = recording({});

    const result = await draftSyncs(request({ provider, models: ["a", "b"] }));

    expect(asked).toEqual(["a", "b"]);
    expect(result.attempts).toEqual([]);
    expect(result.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("already_failed_model_is_never_re_asked_on_a_later_draft", async () => {
    const { provider, asked } = recording({ b: DRAFT });

    await draftSyncs(request({ provider, models: ["a", "b"], drafts: 2 }));

    expect(asked).toEqual(["a", "b", "b"]);
    expect(asked.filter((model) => model === "a")).toHaveLength(1);
  });
});

describe("the harmonise draft stage under D12 weather", () => {
  it("never_asks_a_model_an_earlier_stage_already_grounded_from_draft_zero", async () => {
    // Classification runs before drafting and shares the run's weather. A
    // model it found to be out of room must not be re-bought here.
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: DRAFT });

    const result = await draftSyncs(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["live"]);
    // And `busy` is off the list before rotation sees it, rather than rotated
    // past inside it: the seed exists so a model this run has already given up
    // on does not produce a second `draft:` warning on every document.
    expect(result.failures).toEqual([]);
  });

  it("grounds_a_capacity_failed_model_so_the_next_document_skips_it", async () => {
    const weather = createWeather();
    const { provider, asked } = recording({
      busy: { ok: false, model: "busy", reason: "HTTP 429", kind: "capacity" },
      live: DRAFT,
    });

    await draftSyncs(request({ provider, weather, models: ["busy", "live"] }));
    expect(asked).toEqual(["busy", "live"]);

    // The second document group of the same run.
    await draftSyncs(request({ provider, weather, models: ["busy", "live"] }));

    expect(asked).toEqual(["busy", "live", "live"]);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("fails_the_run_red_the_instant_a_model_reports_an_auth_failure", async () => {
    const { provider, asked } = recording({
      a: { ok: false, model: "a", reason: "HTTP 401", kind: "auth" },
      b: DRAFT,
    });

    await expect(draftSyncs(request({ provider, models: ["a", "b"] }))).rejects.toThrow(
      AuthenticationFailure,
    );
    expect(asked).toEqual(["a"]);
  });
});

describe("an empty answer is not a draft", () => {
  it("rotates_to_the_next_draft_rather_than_publishing_an_empty_document", async () => {
    // An empty answer that reached the file would replace a locale's whole
    // translation with nothing.
    const { provider } = recording({ a: "   \n  " });

    const result = await draftSyncs(request({ provider, models: ["a"], drafts: 2 }));

    expect(result.attempts).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it("keeps a later draft that answered after an earlier one came back empty", async () => {
    let call = 0;
    const asked: string[] = [];
    const provider: Provider = {
      complete: vi.fn((model: string) => {
        asked.push(model);
        call += 1;
        return Promise.resolve<Completion>({
          ok: true,
          model,
          content: call === 1 ? "  " : DRAFT,
          finishReason: "stop",
        });
      }),
    };

    const result = await draftSyncs(request({ provider, models: ["a"], drafts: 2 }));

    expect(asked).toEqual(["a", "a"]);
    expect(result.attempts.map((attempt) => attempt.model)).toEqual(["a"]);
  });
});

describe("the chunked drafting path keeps the same roster contract", () => {
  /** A source long enough to force the chunked path at `chunkChars`. */
  const LONG_SOURCE = Array.from(
    { length: 12 },
    (_, at) => `## Section ${String(at)}\n\nThis paragraph explains step ${String(at)} clearly.`,
  ).join("\n\n");
  const LONG_TARGET = Array.from(
    { length: 12 },
    (_, at) => `## Phần ${String(at)}\n\nĐoạn này giải thích bước ${String(at)} rõ ràng.`,
  ).join("\n\n");

  function chunked(over: Partial<DraftSyncRequest> = {}): DraftSyncRequest {
    return request({
      sourceContent: LONG_SOURCE,
      targetContent: LONG_TARGET,
      chunkChars: 200,
      ...over,
    });
  }

  it("walks the whole roster within one chunk rather than one model per chunk", async () => {
    // The discriminating outcome, not the call list: a chunk whose rotation
    // stops at the first model produces NO draft and falls back to the
    // original text, and harmonise says so in a warning. Every chunk must
    // reach the model that can answer, on the chunk itself.
    const asked: string[] = [];
    const provider: Provider = {
      complete: vi.fn((model: string) => {
        asked.push(model);
        return Promise.resolve<Completion>(
          model === "c"
            ? {
                ok: true,
                model,
                content: "Đoạn này giải thích bước rõ ràng.",
                finishReason: "stop",
              }
            : { ok: false, model, reason: "no", kind: "protocol" },
        );
      }),
    };

    await draftSyncs(chunked({ provider, models: ["a", "b", "c"] }));

    const said = vi.mocked(core.warning).mock.calls.map(([message]) => String(message));
    expect(said.filter((message) => message.includes("no draft produced"))).toEqual([]);
    // The first chunk alone had to walk all three.
    expect(asked.slice(0, 3)).toEqual(["a", "b", "c"]);
  });

  it("never_asks_a_model_already_grounded_for_capacity_on_any_chunk", async () => {
    const weather = createWeather();
    weather.ground("busy");
    const { provider, asked } = recording({ live: "Đoạn này giải thích rõ ràng." });

    const result = await draftSyncs(chunked({ provider, weather, models: ["busy", "live"] }));

    expect(asked).not.toContain("busy");
    expect(asked.every((model) => model === "live")).toBe(true);
    // Off the list before rotation sees it, so it does not report one
    // synthetic skip per chunk for a model the run gave up on long ago.
    expect(result.failures).toEqual([]);
  });

  it("grounds_a_capacity_failed_model_mid_chunking_so_no_later_chunk_asks_it", async () => {
    // The whole reason `weather` is threaded into the chunk rotation rather
    // than only consulted at the top: a model that runs out of room on chunk
    // one must not be asked again on chunks two, three and four.
    const weather = createWeather();
    const asked: string[] = [];
    const provider: Provider = {
      complete: vi.fn((model: string) => {
        asked.push(model);
        return Promise.resolve<Completion>(
          model === "busy"
            ? { ok: false, model, reason: "HTTP 429", kind: "capacity" }
            : { ok: true, model, content: "Đoạn này giải thích rõ ràng.", finishReason: "stop" },
        );
      }),
    };

    await draftSyncs(chunked({ provider, weather, models: ["busy", "live"] }));

    expect(asked.filter((model) => model === "busy")).toHaveLength(1);
    expect(weather.grounded("busy")).toBe(true);
  });

  it("keeps the original chunk rather than losing it when every model fails", async () => {
    // A chunk nobody could draft falls back to the target's own text, so a
    // failed model costs an update rather than a locale's content.
    const { provider } = recording({});

    const result = await draftSyncs(chunked({ provider, models: ["a"] }));

    const produced = [...result.attempts, ...result.refused][0]?.text ?? "";
    expect(produced).toContain("Phần 0");
  });
});
