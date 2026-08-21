import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Language } from "../../core/languages.js";
import { createWeather, type Failure } from "../../core/provider.js";
import type { Score } from "../../core/score.js";

import type { Translation } from "./draft.js";
import { translate } from "./draft.js";
import { translateChunk, translateInto, type Stages } from "./engine.js";
import { judge } from "./judge.js";
import type { Settings } from "./main.js";

// Both collaborators are stubbed: what `translateChunk`/`translateInto` owe a
// caller is what they ask `translate`/`judge` for and what they do with the
// answer, not a real draft-and-judge pass. `@actions/core` is stubbed too, so
// every log call this module makes can be asserted directly.
vi.mock("./draft.js", () => ({ translate: vi.fn() }));
vi.mock("./judge.js", () => ({ judge: vi.fn() }));
vi.mock("@actions/core", () => ({ warning: vi.fn(), info: vi.fn() }));

const mockedTranslate = vi.mocked(translate);
const mockedJudge = vi.mocked(judge);

const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };

const perfectScore: Score = { value: 1, admissible: true, reason: null, checks: [] };

const settings: Settings = {
  token: "token",
  number: 1,
  models: ["model-a", "model-b"],
  modelNames: new Map([["model-a", "Careful"]]),
  languages: [english, vietnamese],
  warrant: "",

  permitted: [],
  judges: [["judge-a"]],
  judgeNames: new Map([["judge-a", "Panel"]]),
  drafts: 1,
  maxBodyChars: null,
  replies: false,
  maxReplies: null,
  chunkChars: 40,
  glossaryDir: ".reeve/glossary.yml",
  glossary: [],
  maxRequests: null,
  attribution: "detail",
  branding: true,
  dryRun: false,
  baseUrl: "https://example.invalid",
  apiKey: "",
  sweep: false,
  since: null,
  limit: null,
  endpoints: [],
  apiKeys: [],
  requestTimeoutMs: 120_000,
  temperature: undefined,
};

const stages: Stages = {
  detect: { complete: vi.fn() },
  draft: { complete: vi.fn() },
  judge: { complete: vi.fn() },
};

function translation(overrides: Partial<Translation> = {}): Translation {
  return {
    to: vietnamese,
    attempts: [{ model: "model-a", text: "bản dịch", score: perfectScore }],
    refused: [],
    failures: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("translateChunk", () => {
  it("returns the winning attempt's text, model name and score", async () => {
    mockedTranslate.mockResolvedValue(translation());
    mockedJudge.mockResolvedValue({
      winner: { model: "model-a", text: "bản dịch", score: perfectScore },
      decidedBy: "score",
      votes: [],
      failures: [],
    });

    const result = await translateChunk(
      vietnamese,
      settings,
      stages,
      english,
      "source",
      createWeather(),
    );

    expect(result).toEqual({
      text: "bản dịch",
      model: "Careful",
      contested: false,
      score: 1,
      drafts: 1,
      decidedBy: "score",
      votes: [],
    });
  });

  it("shows the id when no name was configured for it", async () => {
    mockedTranslate.mockResolvedValue(
      translation({ attempts: [{ model: "model-b", text: "x", score: perfectScore }] }),
    );
    mockedJudge.mockResolvedValue({
      winner: { model: "model-b", text: "x", score: perfectScore },
      decidedBy: "score",
      votes: [],
      failures: [],
    });

    const result = await translateChunk(
      vietnamese,
      settings,
      stages,
      null,
      "source",
      createWeather(),
    );

    expect(result?.model).toBe("model-b");
  });

  it("is contested when more than one draft was admitted, even without a vote", async () => {
    mockedTranslate.mockResolvedValue(
      translation({
        attempts: [
          { model: "model-a", text: "a", score: perfectScore },
          { model: "model-b", text: "b", score: perfectScore },
        ],
      }),
    );
    mockedJudge.mockResolvedValue({
      winner: { model: "model-a", text: "a", score: perfectScore },
      decidedBy: "score",
      votes: [],
      failures: [],
    });

    const result = await translateChunk(
      vietnamese,
      settings,
      stages,
      null,
      "source",
      createWeather(),
    );

    expect(result?.contested).toBe(true);
  });

  it("is contested when judges voted, even for a single draft", async () => {
    mockedTranslate.mockResolvedValue(translation());
    mockedJudge.mockResolvedValue({
      winner: { model: "model-a", text: "bản dịch", score: perfectScore },
      decidedBy: "judges",
      votes: [{ model: "judge-a", pick: "model-a" }],
      failures: [],
    });

    const result = await translateChunk(
      vietnamese,
      settings,
      stages,
      null,
      "source",
      createWeather(),
    );

    expect(result?.contested).toBe(true);
    expect(result?.votes).toEqual([{ model: "Panel", pick: "Careful" }]);
  });

  it("returns null without logging a winner when the judge reached none", async () => {
    mockedTranslate.mockResolvedValue(translation());
    mockedJudge.mockResolvedValue({
      winner: null,
      decidedBy: "score",
      votes: [],
      failures: [],
    });
    const core = await import("@actions/core");

    const result = await translateChunk(
      vietnamese,
      settings,
      stages,
      null,
      "source",
      createWeather(),
    );

    expect(result).toBeNull();
    expect(core.info).not.toHaveBeenCalled();
  });

  it("warns once per failed and once per refused draft, naming the model", async () => {
    mockedTranslate.mockResolvedValue(
      translation({
        attempts: [],
        refused: [{ model: "model-b", text: "x", score: { ...perfectScore, admissible: false } }],
        failures: [{ ok: false, model: "model-a", kind: "capacity", reason: "quota exceeded" }],
      }),
    );
    mockedJudge.mockResolvedValue({
      winner: null,
      decidedBy: "score",
      votes: [],
      failures: [],
    });
    const core = await import("@actions/core");

    await translateChunk(vietnamese, settings, stages, null, "source", createWeather());

    expect(core.warning).toHaveBeenCalledWith("vi: Careful failed — quota exceeded");
    expect(core.warning).toHaveBeenCalledWith("vi: model-b was refused — unscored");
  });

  it("warns once per failed judge seat, naming the seat", async () => {
    mockedTranslate.mockResolvedValue(translation());
    mockedJudge.mockResolvedValue({
      winner: { model: "model-a", text: "bản dịch", score: perfectScore },
      decidedBy: "score",
      votes: [],
      failures: [{ ok: false, model: "judge-a", kind: "capacity", reason: "quota exceeded" }],
    });
    const core = await import("@actions/core");

    await translateChunk(vietnamese, settings, stages, null, "source", createWeather());

    expect(core.warning).toHaveBeenCalledWith("vi: judge Panel — quota exceeded");
  });

  it("invokes the roster-exhaustion callback with the exact models and failures when no draft survives", async () => {
    const failures: Failure[] = [
      { ok: false, model: "model-a", kind: "protocol", reason: "bad model id" },
      { ok: false, model: "model-b", kind: "protocol", reason: "bad model id" },
    ];
    mockedTranslate.mockResolvedValue(translation({ attempts: [], failures }));
    mockedJudge.mockResolvedValue({
      winner: null,
      decidedBy: "score",
      votes: [],
      failures: [],
    });
    const callback = vi.fn();

    await translateChunk(vietnamese, settings, stages, null, "source", createWeather(), callback);

    expect(callback).toHaveBeenCalledWith(settings.models, failures);
  });

  it("does not invoke the roster-exhaustion callback when at least one draft survives", async () => {
    mockedTranslate.mockResolvedValue(translation());
    mockedJudge.mockResolvedValue({
      winner: { model: "model-a", text: "bản dịch", score: perfectScore },
      decidedBy: "score",
      votes: [],
      failures: [],
    });
    const callback = vi.fn();

    await translateChunk(vietnamese, settings, stages, null, "source", createWeather(), callback);

    expect(callback).not.toHaveBeenCalled();
  });
});

describe("translateInto", () => {
  it("reuses a code-only chunk verbatim, never asking a model for it", async () => {
    const source = "```\ncode\n```";
    mockedTranslate.mockResolvedValue(translation());

    const result = await translateInto(
      vietnamese,
      settings,
      stages,
      english,
      source,
      createWeather(),
    );

    expect(mockedTranslate).not.toHaveBeenCalled();
    expect(result).toEqual({ to: vietnamese, text: source, model: "—" });
  });

  it("returns null for the whole language when one chunk's translation fails", async () => {
    const source = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
    mockedTranslate.mockResolvedValue(translation());
    mockedJudge.mockResolvedValue({
      winner: null,
      decidedBy: "score",
      votes: [],
      failures: [],
    });

    const result = await translateInto(
      vietnamese,
      settings,
      stages,
      english,
      source,
      createWeather(),
    );

    expect(result).toBeNull();
  });

  it("joins every chunk's text and reports every model that won at least one", async () => {
    const source = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
    mockedTranslate.mockResolvedValueOnce(
      translation({ attempts: [{ model: "model-a", text: "AAA", score: perfectScore }] }),
    );
    mockedJudge.mockResolvedValueOnce({
      winner: { model: "model-a", text: "AAA", score: perfectScore },
      decidedBy: "score",
      votes: [],
      failures: [],
    });
    mockedTranslate.mockResolvedValueOnce(
      translation({ attempts: [{ model: "model-b", text: "BBB", score: perfectScore }] }),
    );
    mockedJudge.mockResolvedValueOnce({
      winner: { model: "model-b", text: "BBB", score: perfectScore },
      decidedBy: "score",
      votes: [],
      failures: [],
    });

    const result = await translateInto(
      vietnamese,
      settings,
      stages,
      english,
      source,
      createWeather(),
    );

    expect(result?.text).toBe("AAABBB");
    expect(result?.model).toBe("Careful, model-b");
    // A multi-chunk body never carries a single-contest `decision` breakdown.
    expect(result?.decision).toBeUndefined();
  });
});
