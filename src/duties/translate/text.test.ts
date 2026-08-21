import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as detect from "../../core/detect.js";
import type { Language } from "../../core/languages.js";
import { createWeather } from "../../core/provider.js";
import type { Meter, Spend } from "../../core/meter.js";
import type { Thread } from "../../core/forge.js";

import { createBudget } from "./budget.js";
import type { Stages } from "./engine.js";
import type { Settings } from "./main.js";
import { marker, translationFingerprint } from "./publish.js";
import type { Looked } from "./summary.js";
import { nothing, processThread, translateReplies, translateText } from "./text.js";

// Every collaborator that would spend a request, touch the network or read
// `@actions/core` is stubbed, the same shape as `engine.test.ts`. `residue`,
// `readBody`, `targets`, `marker`, `publication` and `translationFingerprint`
// stay real — they are pure, and this file's job is to pin the orchestration
// around them, not re-prove logic those modules' own tests already cover.
vi.mock("../../core/detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof detect>();
  return { ...actual, detectLanguage: vi.fn(), createLanguagePicker: vi.fn() };
});
vi.mock("./engine.js", () => ({ translateInto: vi.fn() }));
vi.mock("../../core/publish.js", () => ({
  assemble: vi.fn(() => "ASSEMBLED"),
  publish: vi.fn(),
}));
vi.mock("../../core/forge.js", () => ({
  createReply: vi.fn(),
  createThread: vi.fn(),
  listReplies: vi.fn(),
}));
vi.mock("@actions/core", () => ({ info: vi.fn(), warning: vi.fn() }));

const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };

const stages = {
  detect: { complete: vi.fn() },
  draft: { complete: vi.fn() },
  judge: { complete: vi.fn() },
} as unknown as Stages;

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    token: "token",
    number: 1,
    models: ["model-a"],
    modelNames: new Map(),
    languages: [english, vietnamese],
    warrant: "",

    permitted: ["edit-body"],
    judges: [["judge-a"]],
    judgeNames: new Map(),
    drafts: 1,
    maxBodyChars: null,
    replies: false,
    maxReplies: null,
    chunkChars: 4000,
    glossaryDir: ".reeve/glossary.yml",
    glossary: [],
    maxRequests: null,
    attribution: "none",
    branding: true,
    dryRun: true,
    baseUrl: "https://example.invalid",
    apiKey: "",
    sweep: false,
    since: null,
    limit: null,
    endpoints: [],
    apiKeys: [],
    requestTimeoutMs: 120_000,
    temperature: undefined,
    ...overrides,
  };
}

function meterWith(...requestCounts: number[]): Meter {
  let call = 0;
  return {
    record: vi.fn(),
    spent: (): Spend[] => {
      const requests = requestCounts[Math.min(call, requestCounts.length - 1)] ?? 0;
      call += 1;
      return [
        {
          purpose: "draft",
          model: "model-a",
          endpoint: null,
          requests,
          failed: 0,
          unreported: 0,
          prompt: 0,
          completion: 0,
        },
      ];
    },
  };
}

const thread: Thread = { read: vi.fn(), write: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("nothing", () => {
  it("reports an empty, unpublished outcome carrying the given note", () => {
    expect(nothing("#1", "empty body")).toEqual({
      what: "#1",
      from: null,
      posted: [],
      skipped: [],
      budgetSkipped: [],
      note: "empty body",
      published: false,
    });
  });
});

describe("translateText", () => {
  it("reports an empty body without reaching detection", async () => {
    const { detectLanguage } = await import("../../core/detect.js");

    const result = await translateText(
      "#1",
      "   ",
      thread,
      true,
      settingsWith(),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.note).toBe("empty body");
    expect(detectLanguage).not.toHaveBeenCalled();
  });

  it("reports no prose without reaching detection", async () => {
    const { detectLanguage } = await import("../../core/detect.js");

    const result = await translateText(
      "#1",
      "```\ncode only\n```",
      thread,
      true,
      settingsWith(),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.note).toBe("no prose to translate");
    expect(detectLanguage).not.toHaveBeenCalled();
  });

  it("reports already-translated when the marker's fingerprint already matches", async () => {
    const { detectLanguage } = await import("../../core/detect.js");
    const settings = settingsWith();
    const source = "hello world";
    const wanted = translationFingerprint(source, settings.languages);
    const body = `${source}\n${marker.render(wanted)}`;

    const result = await translateText(
      "#1",
      body,
      thread,
      true,
      settings,
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.note).toBe("already translated");
    expect(detectLanguage).not.toHaveBeenCalled();
  });

  it("reports budget exhausted before spending a request on detection", async () => {
    const { detectLanguage } = await import("../../core/detect.js");
    const budget = createBudget();

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ maxRequests: 0 }),
      stages,
      createWeather(),
      meterWith(0),
      budget,
    );

    expect(result.note).toBe("budget exhausted");
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(budget.denied).toBe(true);
  });

  it("warns about truncation, still detects, and stops one language early on budget", async () => {
    const core = await import("@actions/core");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: null,
      by: "none",
      candidates: [],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: english, text: "hi", model: "model-a" });

    const settings = settingsWith({ maxBodyChars: 5, maxRequests: 3, dryRun: true });
    // Call sequence: 1 pre-detection check, then one per target language.
    // Stays under the ceiling for the first two, then reaches it exactly on
    // the second language's own checkpoint.
    const meter = meterWith(0, 0, 3);

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settings,
      stages,
      createWeather(),
      meter,
      createBudget(),
    );

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("only the first 5 characters were"),
    );
    expect(translateInto).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual([vietnamese]);
    expect(result.budgetSkipped).toEqual([vietnamese]);
    expect(core.warning).toHaveBeenCalledWith(
      "#1: `max-requests` was reached, so vi was not attempted this run. " +
        "What was already drafted still publishes.",
    );
  });

  it("skips a language a model produced nothing for, and warns", async () => {
    const core = await import("@actions/core");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue(null);

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: true }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.skipped).toEqual([vietnamese]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("no model produced a translation"),
    );
  });

  it("dry-runs a successful translation without publishing", async () => {
    const core = await import("@actions/core");
    const { publish } = await import("../../core/publish.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: vietnamese, text: "chào", model: "model-a" });

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: true }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.published).toBe(false);
    expect(result.posted).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Dry run — #1 would have become"),
    );
  });

  it("reports a dry run's draft even when edit-body is not permitted — the report gate runs first", async () => {
    // Pins the ordering `translateText`'s own doc comment states: `dryRun` is
    // checked before the `edit-body` permission check, not after. Swapping
    // the two gates would make this run report nothing instead of what it
    // drafted, and every other test in this file would still pass.
    const core = await import("@actions/core");
    const { publish } = await import("../../core/publish.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: vietnamese, text: "chào", model: "model-a" });

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: true, permitted: [] }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(core.info).toHaveBeenCalledWith("Dry run — #1 would have become:\nASSEMBLED");
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("is not permitted this run"),
    );
    expect(result.posted).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports nothing achieved in a dry run when every language was skipped", async () => {
    const core = await import("@actions/core");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue(null);

    await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: true }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("would have been left alone: no language produced a translation"),
    );
  });

  it("withholds a drafted translation when edit-body is not permitted, and says so", async () => {
    const core = await import("@actions/core");
    const { publish } = await import("../../core/publish.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: vietnamese, text: "chào", model: "model-a" });

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: false, permitted: [] }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.published).toBe(false);
    expect(result.posted).toEqual([]);
    expect(result.note).toContain("`edit-body` is not permitted this run");
    expect(publish).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      "#1: `edit-body` is not permitted this run, so the translation drafted this run was not published.",
    );
  });

  it("withholds nothing untranslated when edit-body is not permitted and there were no drafts", async () => {
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue(null);

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: false, permitted: [] }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.note).toBeNull();
    expect(result.published).toBe(false);
  });

  it("publishes and reports a plain publication", async () => {
    const core = await import("@actions/core");
    const { publish } = await import("../../core/publish.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: vietnamese, text: "chào", model: "model-a" });
    vi.mocked(publish).mockResolvedValue({ action: "published", mismatched: false });

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: false }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.published).toBe(true);
    expect(core.info).toHaveBeenCalledWith("#1: published.");
    expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining("another write landed"));
  });

  it("warns about a race when the publish it just made turns out mismatched", async () => {
    const core = await import("@actions/core");
    const { publish } = await import("../../core/publish.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: vietnamese, text: "chào", model: "model-a" });
    vi.mocked(publish).mockResolvedValue({ action: "published", mismatched: true });

    await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: false }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(core.warning).toHaveBeenCalledWith(
      "#1: another write landed on this thread between this run's write and its check — " +
        "the body may not be exactly what this run published. Add a `concurrency:` group keyed " +
        "on the thread (see the installation guide) to stop two runs from racing the same body.",
    );
  });

  it("reports an unchanged publish", async () => {
    const core = await import("@actions/core");
    const { publish } = await import("../../core/publish.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: vietnamese, text: "chào", model: "model-a" });
    vi.mocked(publish).mockResolvedValue({ action: "unchanged" });

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: false }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.published).toBe(false);
    expect(core.info).toHaveBeenCalledWith("#1: unchanged.");
  });

  it("reports nothing written, naming the reason, when publish declines", async () => {
    const core = await import("@actions/core");
    const { publish } = await import("../../core/publish.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue(null);
    vi.mocked(publish).mockResolvedValue({
      action: "none",
      reason: "the run produced nothing to publish",
    });

    const result = await translateText(
      "#1",
      "hello world",
      thread,
      true,
      settingsWith({ dryRun: false }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.published).toBe(false);
    expect(core.info).toHaveBeenCalledWith(
      "#1: nothing written — the run produced nothing to publish.",
    );
  });
});

describe("translateReplies", () => {
  it("translates nothing and warns nothing when there are no replies", async () => {
    const core = await import("@actions/core");
    const { listReplies } = await import("../../core/forge.js");
    vi.mocked(listReplies).mockResolvedValue({ replies: [], more: false });

    const published = await translateReplies(
      {} as never,
      { owner: "o", repo: "r", number: 1 },
      settingsWith(),
      stages,
      [],
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(published).toBe(0);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("warns when the listing left older replies behind", async () => {
    const core = await import("@actions/core");
    const { listReplies } = await import("../../core/forge.js");
    vi.mocked(listReplies).mockResolvedValue({ replies: [], more: true });

    await translateReplies(
      {} as never,
      { owner: "o", repo: "r", number: 1 },
      settingsWith(),
      stages,
      [],
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("more replies than one run reads"),
    );
  });

  it("stops before the first reply once the budget is already spent", async () => {
    const core = await import("@actions/core");
    const { listReplies, createReply } = await import("../../core/forge.js");
    vi.mocked(listReplies).mockResolvedValue({
      replies: [{ id: 1, body: "hi" }] as never,
      more: false,
    });

    const published = await translateReplies(
      {} as never,
      { owner: "o", repo: "r", number: 1 },
      settingsWith({ maxRequests: 0 }),
      stages,
      [],
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(published).toBe(0);
    expect(createReply).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("remaining replies were not attempted"),
    );
  });

  it("counts a reply that actually got published, and not one that did not", async () => {
    const { listReplies, createReply } = await import("../../core/forge.js");
    const { detectLanguage } = await import("../../core/detect.js");
    const { translateInto } = await import("./engine.js");
    const { publish } = await import("../../core/publish.js");
    vi.mocked(listReplies).mockResolvedValue({
      replies: [
        { id: 1, body: "hello there" },
        { id: 2, body: "" },
      ] as never,
      more: false,
    });
    vi.mocked(createReply).mockReturnValue(thread);
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });
    vi.mocked(translateInto).mockResolvedValue({ to: vietnamese, text: "chào", model: "model-a" });
    vi.mocked(publish).mockResolvedValue({ action: "published", mismatched: false });

    const looked: Looked[] = [];
    const published = await translateReplies(
      {} as never,
      { owner: "o", repo: "r", number: 1 },
      settingsWith({ dryRun: false }),
      stages,
      looked,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(published).toBe(1);
    expect(looked).toHaveLength(2);
  });
});

describe("processThread", () => {
  it("skips replies entirely when the setting is off", async () => {
    const { createThread, listReplies } = await import("../../core/forge.js");
    const { detectLanguage } = await import("../../core/detect.js");
    vi.mocked(createThread).mockReturnValue(thread);
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });

    const result = await processThread(
      {} as never,
      { owner: "o", repo: "r", number: 1 },
      "hello world",
      settingsWith({ replies: false }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(result.replies).toBe(0);
    expect(listReplies).not.toHaveBeenCalled();
    expect(result.ungranted).toBeNull();
  });

  it("translates replies too when the setting is on", async () => {
    const { createThread, listReplies } = await import("../../core/forge.js");
    const { detectLanguage } = await import("../../core/detect.js");
    vi.mocked(createThread).mockReturnValue(thread);
    vi.mocked(listReplies).mockResolvedValue({ replies: [], more: false });
    vi.mocked(detectLanguage).mockResolvedValue({
      language: english,
      by: "script",
      candidates: [english],
    });

    const result = await processThread(
      {} as never,
      { owner: "o", repo: "r", number: 1 },
      "hello world",
      settingsWith({ replies: true }),
      stages,
      createWeather(),
      meterWith(0),
      createBudget(),
    );

    expect(listReplies).toHaveBeenCalled();
    expect(result.looked).toHaveLength(1);
    expect(result.replies).toBe(0);
  });
});
