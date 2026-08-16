import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Outcome, Settings, SweepAccumulator } from "./main.js";
import type { Done } from "./summary.js";

// `@actions/core` is stubbed so `report`/`reportSweep` can be asserted
// against without a real Action environment. `summarize`/`summarizeSweep`
// are stubbed too — this file's job is to pin that `page`/`sweepPage` pass
// the right values through, not to re-prove what `summary.test.ts` already
// covers about the string those functions render.
vi.mock("@actions/core", () => ({ setOutput: vi.fn() }));
vi.mock("./summary.js", () => ({
  summarize: vi.fn(() => "PAGE"),
  summarizeSweep: vi.fn(() => "SWEEP"),
}));

import * as core from "@actions/core";

import { page, remainingOf, report, reportSweep, sweepPage } from "./outputs.js";
import { summarize, summarizeSweep } from "./summary.js";

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    token: "t",
    number: 1,
    models: ["model-a"],
    modelNames: new Map(),
    languages: [],
    warrant: ".github/reeve.yml",
    confidence: 0.5,
    candidates: 5,
    corpusLimit: null,
    corpusSince: null,
    maxBodyChars: null,
    attribution: "none",
    dryRun: false,
    baseUrl: "https://api.example.com",
    apiKey: "key",
    sweep: false,
    since: null,
    limit: null,
    endpoints: [],
    apiKeys: [],
    requestTimeoutMs: 1000,
    temperature: undefined,
    ...overrides,
  };
}

function outcomeWith(overrides: Partial<Outcome> = {}): Outcome {
  return {
    language: null,
    duplicateOf: null,
    confidence: 0,
    lexicalScore: 0,
    permitted: [],
    note: null,
    rank: { corpusSize: 0, offered: 0 },
    pivot: { used: false, note: null },
    proposal: null,
    fingerprint: null,
    rationale: null,
    ungranted: null,
    ...overrides,
  };
}

const done: Done = { commented: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("remainingOf", () => {
  it("is the candidates a sweep has not yet reached", () => {
    const acc: SweepAccumulator = {
      results: [{ number: 1, outcome: "no duplicate" }],
      skipped: 0,
      starvedRun: false,
      candidates: 5,
      ungranted: null,
    };

    expect(remainingOf(acc)).toBe(4);
  });

  it("never goes negative when results somehow outnumber candidates", () => {
    const acc: SweepAccumulator = {
      results: [
        { number: 1, outcome: "no duplicate" },
        { number: 2, outcome: "no duplicate" },
      ],
      skipped: 0,
      starvedRun: false,
      candidates: 1,
      ungranted: null,
    };

    expect(remainingOf(acc)).toBe(0);
  });
});

describe("report", () => {
  it("writes every single-thread output, with the sweep-only ones at zero", () => {
    report(
      outcomeWith({ duplicateOf: 42, confidence: 0.87, language: "en" }),
      { commented: true },
      false,
    );

    expect(core.setOutput).toHaveBeenCalledWith("duplicate-of", "42");
    expect(core.setOutput).toHaveBeenCalledWith("score", "0.87");
    expect(core.setOutput).toHaveBeenCalledWith("language", "en");
    expect(core.setOutput).toHaveBeenCalledWith("commented", "true");
    expect(core.setOutput).toHaveBeenCalledWith("starved", "false");
    expect(core.setOutput).toHaveBeenCalledWith("skipped", "0");
    expect(core.setOutput).toHaveBeenCalledWith("budget-exhausted", "false");
    expect(core.setOutput).toHaveBeenCalledWith("processed", "0");
    expect(core.setOutput).toHaveBeenCalledWith("remaining", "0");
  });

  it("answers duplicate-of and language as empty strings rather than leaving them unset", () => {
    report(outcomeWith(), done, false);

    expect(core.setOutput).toHaveBeenCalledWith("duplicate-of", "");
    expect(core.setOutput).toHaveBeenCalledWith("language", "");
  });
});

describe("reportSweep", () => {
  it("writes processed, remaining and starved, and nothing single-thread-only", () => {
    const acc: SweepAccumulator = {
      results: [
        { number: 1, outcome: "no duplicate" },
        { number: 2, outcome: "proposed #1" },
      ],
      skipped: 0,
      starvedRun: true,
      candidates: 5,
      ungranted: null,
    };

    reportSweep(acc, true);

    expect(core.setOutput).toHaveBeenCalledWith("processed", "2");
    expect(core.setOutput).toHaveBeenCalledWith("remaining", "3");
    expect(core.setOutput).toHaveBeenCalledWith("starved", "true");
    expect(core.setOutput).not.toHaveBeenCalledWith("duplicate-of", expect.anything());
  });

  it("always reports budget-exhausted as false and skipped as zero — duplicate has no request budget or idempotent skip", () => {
    const acc: SweepAccumulator = {
      results: [{ number: 1, outcome: "no duplicate" }],
      skipped: 0,
      starvedRun: true,
      candidates: 5,
      ungranted: null,
    };

    reportSweep(acc, true);

    expect(core.setOutput).toHaveBeenCalledWith("budget-exhausted", "false");
    expect(core.setOutput).toHaveBeenCalledWith("skipped", "0");
  });
});

describe("page", () => {
  it("passes the outcome, settings and posted state through to summarize", () => {
    const outcome = outcomeWith({ duplicateOf: 7, confidence: 0.9, proposal: null });
    const settings = settingsWith({ dryRun: true, warrant: "custom.yml", confidence: 0.6 });

    const result = page(settings, 7, outcome, done, "posted", []);

    expect(result).toBe("PAGE");
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: 7,
        dryRun: true,
        warrant: "custom.yml",
        duplicateOf: 7,
        confidence: 0.9,
        floor: 0.6,
        done,
        posted: "posted",
        languageCode: null,
      }),
    );
  });

  it("reads languageCode off the proposal, not the display language", () => {
    const outcome = outcomeWith({
      language: "English",
      proposal: {
        duplicateOf: 1,
        confidence: 0.9,
        lexicalScore: 0.5,
        rationale: "r",
        model: "m",
        attribution: "none",
        language: "en",
      },
    });

    page(settingsWith(), 1, outcome, done, null, []);

    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ language: "English", languageCode: "en" }),
    );
  });
});

describe("sweepPage", () => {
  it("passes the sweep state through to summarizeSweep, remaining computed from the accumulator", () => {
    const acc: SweepAccumulator = {
      results: [{ number: 1, outcome: "no duplicate" }],
      skipped: 0,
      starvedRun: false,
      candidates: 3,
      ungranted: null,
    };
    const settings = settingsWith({ dryRun: false, warrant: "w.yml" });

    const result = sweepPage(settings, acc, []);

    expect(result).toBe("SWEEP");
    expect(summarizeSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        warrant: "w.yml",
        results: acc.results,
        remaining: 2,
        starvedRun: false,
        ungranted: null,
      }),
    );
  });
});
