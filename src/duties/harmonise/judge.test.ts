import { describe, expect, it, vi } from "vitest";

import { createWeather, type Completion, type Provider } from "../../core/provider.js";
import { judge } from "./judge.js";
import type { Draft } from "./draft.js";

/**
 * The harmonise judge is a thin wrapper over core's panel; the panel mechanics
 * are tested in `core/judge.test.ts`. What is left here is the wrapper's own
 * contract: it hands the panel the candidates, the `by` model name, the
 * weather, and a ballot that names the target locale and numbers the drafts.
 */

/** A provider whose every model answers with the number keyed by its id. */
function answering(answers: Record<string, string | Completion>): Provider {
  return {
    complete: vi.fn((model: string): Promise<Completion> => {
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({ ok: false, model, reason: "not configured", kind: "protocol" });
      }
      return Promise.resolve(
        typeof answer === "string"
          ? { ok: true, model, content: answer, finishReason: "stop" }
          : answer,
      );
    }),
  };
}

function draft(model: string, overrides: Partial<Draft> = {}): Draft {
  return {
    model,
    text: `Harmonised text from ${model}.`,
    score: { value: 0.9, admissible: true, reason: null, checks: [] },
    ...overrides,
  };
}

const to = { code: "pt-BR", label: "Portuguese (Brazil)", scripts: ["Latn"] };
const weather = createWeather(new Set(["hub"]), ["judge@hub"]);

describe("judge", () => {
  it("delegates the panel decision and returns the elected draft", async () => {
    const provider = answering({ judge: "2" });

    const verdict = await judge({
      provider,
      judges: [["judge"]],
      targetContent: "Current target.",
      to,
      attempts: [draft("alpha"), draft("beta")],
      weather,
    });

    expect(verdict.winner?.model).toBe("beta");
    expect(verdict.decidedBy).toBe("judges");
  });

  it("passes the weather through so a capacity failure is remembered", async () => {
    const provider = answering({
      "judge@hub": {
        ok: false,
        model: "judge@hub",
        reason: "quota",
        kind: "protocol",
      },
    });

    const verdict = await judge({
      provider,
      judges: [["judge@hub"]],
      targetContent: "Current target.",
      to,
      attempts: [draft("alpha"), draft("beta")],
      weather,
    });

    // The panel falls back to the score when the judge could not answer, and
    // the failure is recorded in the passed-through weather.
    expect(verdict.winner?.model).toBe("alpha");
    expect(verdict.decidedBy).toBe("score");
    expect(verdict.failures).toHaveLength(1);
  });

  it("builds a ballot that names the target locale and numbers the drafts", async () => {
    const provider = answering({ "judge@hub": "1" });

    await judge({
      provider,
      judges: [["judge@hub"]],
      targetContent: "Conteúdo atual.",
      to,
      attempts: [
        draft("alpha", { text: "Uma tradução." }),
        draft("beta", { text: "Outra tradução." }),
      ],
      weather,
    });

    const call = vi.mocked(provider.complete).mock.calls[0];
    expect(call).toBeDefined();
    const messages = call?.[1] ?? [];
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";

    expect(system).toContain("Portuguese (Brazil) (pt-BR)");
    expect(system).toContain("2 updated versions");
    expect(system).toContain("single digit from 1 to 2");
    // The fenced target and the numbered drafts ride in the user message.
    expect(user).toContain("Conteúdo atual.");
    expect(user).toContain("--- HARMONISATION 1 ---\nUma tradução.");
    expect(user).toContain("--- HARMONISATION 2 ---\nOutra tradução.");
  });
});
