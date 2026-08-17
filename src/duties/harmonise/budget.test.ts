/**
 * Unit tests for the budget module — max-requests ceiling.
 */
import { describe, expect, it, vi } from "vitest";

import type { Meter, Spend } from "../../core/meter.js";
import type { Settings } from "./main.js";

import { budgetExhausted, createBudget } from "./budget.js";

function settingsWith(maxRequests: number | null): Settings {
  return {
    token: "token",
    models: ["model-a"],
    modelNames: new Map(),
    sourceLanguage: { code: "en", label: "English", scripts: ["Latn"] },
    languages: [],
    warrant: "",
    permitted: [],
    judges: [],
    judgeNames: new Map(),
    drafts: 1,
    provenanceDir: ".reeve/provenance",
    stateBranch: "reeve/provenance",
    glossaryDir: ".reeve/glossary.yml",
    paths: [],
    maxRequests,
    dryRun: false,
    baseUrl: "https://example.invalid",
    apiKey: "",
    endpoints: [],
    apiKeys: [],
    requestTimeoutMs: 120_000,
    temperature: undefined,
    chunkChars: 0,
    ignore: true,
    sweep: false,
    limit: null,
    number: null,
    since: null,
  };
}

function meterSpending(requests: number): Meter {
  const spend: Spend = {
    purpose: "draft",
    model: "model-a",
    endpoint: null,
    requests,
    failed: 0,
    unreported: 0,
    prompt: 0,
    completion: 0,
  };
  return { record: vi.fn(), spent: () => [spend] };
}

describe("createBudget", () => {
  it("starts undenied", () => {
    expect(createBudget()).toEqual({ denied: false });
  });
});

describe("budgetExhausted", () => {
  it("is never exhausted when max-requests is unset", () => {
    const budget = createBudget();
    expect(budgetExhausted(settingsWith(null), meterSpending(1_000_000), budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("is not exhausted while spend sits below the ceiling", () => {
    const budget = createBudget();
    expect(budgetExhausted(settingsWith(10), meterSpending(9), budget)).toBe(false);
    expect(budget.denied).toBe(false);
  });

  it("is exhausted once spend reaches the ceiling, and marks the budget denied", () => {
    const budget = createBudget();
    expect(budgetExhausted(settingsWith(10), meterSpending(10), budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("is exhausted once spend passes the ceiling", () => {
    const budget = createBudget();
    expect(budgetExhausted(settingsWith(10), meterSpending(11), budget)).toBe(true);
    expect(budget.denied).toBe(true);
  });

  it("leaves an already-denied budget denied even once spend drops back under the ceiling", () => {
    const budget = createBudget();
    budgetExhausted(settingsWith(10), meterSpending(10), budget);
    expect(budgetExhausted(settingsWith(10), meterSpending(0), budget)).toBe(false);
    expect(budget.denied).toBe(true);
  });
});
