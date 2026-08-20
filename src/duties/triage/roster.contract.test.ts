/**
 * Intent-contract tests — the intent matrix's category-A rows that no existing
 * suite pinned end-to-end.
 *
 * The matrix (`docs/development/intent-matrix.md`) cites the unit suites that pin
 * the core's predicates (`provider.test.ts`, `spam.test.ts`, `detect.test.ts`,
 * `summary.test.ts`). What this file adds is the DUTY-BOUNDARY wiring those
 * suites deliberately leave to the caller: triage's decide() builds its own
 * picker over either the cheap roster or the main roster (GAP 1 in the
 * matrix), and sift()'s empty-roster semantics are sift's own contract.
 *
 * Nothing here mocks the core; the fake `Provider`s drive the real functions.
 */

import { describe, expect, it, vi } from "vitest";

import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import type { Language } from "../../core/languages.js";
import type { Completion, Provider } from "../../core/provider.js";
import { createWeather, rotateModels, starved } from "../../core/provider.js";
import { sift } from "../../core/spam.js";

/** Two Latin-script languages: script narrowing never decides on its own. */
function bothCandidates(): readonly Language[] {
  return [
    { code: "aa", label: "Afar", scripts: ["Latn"] },
    { code: "ab", label: "Abkhaz", scripts: ["Latn"] },
  ];
}

/** A provider that answers each model from a map. Unknown ids fail with a protocol error. */
function answering(answers: Record<string, string>): Provider {
  return {
    complete: vi.fn((model: string, _messages: readonly unknown[]): Promise<Completion> => {
      void _messages;
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({
          ok: false,
          model,
          reason: "not configured in this case",
          kind: "protocol",
        });
      }
      return Promise.resolve({ ok: true, model, content: answer, finishReason: "stop" });
    }),
  };
}

describe("A1 — the roster is an ordered rotation", () => {
  it("never reads its own index to choose a model — first failed, second asked", async () => {
    const providerUnderTest = answering({ second: "ans" });
    const asked: string[] = [];
    const wrapped: Provider = {
      complete: async (model, messages) => {
        asked.push(model);
        return providerUnderTest.complete(model, messages);
      },
    };

    const rotation = await rotateModels(["first", "second"], (m) => wrapped.complete(m, []));

    expect(asked).toEqual(["first", "second"]);
    expect(rotation.success?.model).toBe("second");
  });

  it("stops at the first success and never asks what follows", async () => {
    const providerUnderTest = answering({ first: "ans" });
    const asked: string[] = [];
    const wrapped: Provider = {
      complete: async (model, messages) => {
        asked.push(model);
        return providerUnderTest.complete(model, messages);
      },
    };

    await rotateModels(["first", "second", "third"], (m) => wrapped.complete(m, []));

    expect(asked).toEqual(["first"]);
  });
});

describe("A6 — screen-models: the cheap roster, with the documented fallback", () => {
  it("pays the cheap roster for language when one is configured — never the expensive one", async () => {
    const provider = answering({ cheap: "ab" });

    const language = await detectLanguage(
      "Det svenske kjøkkenet.",
      bothCandidates(),
      createLanguagePicker(provider, ["cheap"], createWeather()),
    );

    expect(language.by).toBe("model");
    expect(vi.mocked(provider.complete).mock.calls.map((call) => call[0])).toEqual(["cheap"]);
  });

  it("asks nothing when the cheap list is empty — the caller falls back to `models` (main.ts:911)", async () => {
    const provider = answering({ main: "ab" });

    // With an empty cheap roster the picker has nothing to ask, so detection
    // resolves to nothing — matching the documented default, where everything
    // code does not decide goes straight to the expensive roster via the
    // caller's own `screenModels.length > 0 ? screenModels : models`.
    const language = await detectLanguage(
      "Det svenske kjøkkenet.",
      bothCandidates(),
      createLanguagePicker(provider, [], createWeather()),
    );

    expect(language.by).toBe("none");
    expect(vi.mocked(provider.complete)).not.toHaveBeenCalled();
  });
});

describe("A6 — sift: the spam screen's own empty-roster contract", () => {
  it("is off — dropped null, nothing asked — when the cheap roster is empty", async () => {
    const provider = answering({});

    const result = await sift({
      provider,
      models: [],
      title: "Crash on save",
      body: "It throws.",
      about: "",
    });

    expect(result.dropped).toBeNull();
    expect(result.failures).toEqual([]);
    expect(vi.mocked(provider.complete)).not.toHaveBeenCalled();
  });

  it("carries on — fails open, never drops — when every cheap model failed", async () => {
    const provider = answering({});

    const result = await sift({
      provider,
      models: ["cheap"],
      title: "Crash on save",
      body: "It throws.",
      about: "",
    });

    expect(result.dropped).toBeNull();
    expect(result.failures.map((failure) => failure.model)).toEqual(["cheap"]);
  });

  it("drops spam only when a cheap model said so", async () => {
    const result = await sift({
      provider: answering({ cheap: "spam" }),
      models: ["cheap"],
      title: "Get rich now",
      body: "Buy my course.",
      about: "",
    });

    expect(result.dropped?.reason).toBe("spam");
  });
});

describe("A3/A5 — weather through the real rotation", () => {
  it("grounds a capacity-failed model so a later stage does not ask it again", async () => {
    const weather = createWeather();
    const capacity: Completion = {
      ok: false,
      model: "over",
      reason: "HTTP 429",
      kind: "capacity",
    };

    await rotateModels(["over"], () => Promise.resolve(capacity), weather);

    expect(weather.grounded("over")).toBe(true);
    expect(starved(["over"], weather)).toBe(true);
  });
});
