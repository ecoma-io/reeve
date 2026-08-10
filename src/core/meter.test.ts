import { describe, expect, it, vi } from "vitest";

import { createMeter, metered, total } from "./meter.js";
import type { Completion, Provider, Usage } from "./provider.js";

function answering(model: string, usage: Usage | null = null): Completion {
  return { ok: true, model, content: "1", finishReason: "stop", usage };
}

function failing(model: string, usage: Usage | null = null): Completion {
  return { ok: false, model, reason: "out of quota", usage };
}

/** A provider that answers whatever it is handed, one queued answer per call. */
function stub(answers: readonly Completion[]): Provider {
  const queue = [...answers];
  return {
    complete: vi.fn(async (model: string) => {
      const next = queue.shift();
      return Promise.resolve(next ?? answering(model));
    }),
  };
}

describe("the meter", () => {
  it("counts a request against the model and the purpose that made it", async () => {
    const meter = createMeter();
    const provider = stub([answering("a", { prompt: 100, completion: 20 })]);

    await metered(provider, meter, "draft").complete("a", []);

    expect(meter.spent()).toEqual([
      {
        purpose: "draft",
        model: "a",
        requests: 1,
        failed: 0,
        unreported: 0,
        prompt: 100,
        completion: 20,
      },
    ]);
  });

  it("keeps one model's two purposes apart", async () => {
    // The same id detecting and drafting is the ordinary configuration, and
    // "what is detection costing me" is exactly the question one row hides.
    const meter = createMeter();
    const provider = stub([
      answering("a", { prompt: 10, completion: 1 }),
      answering("a", { prompt: 900, completion: 400 }),
    ]);

    await metered(provider, meter, "detect").complete("a", []);
    await metered(provider, meter, "draft").complete("a", []);

    expect(meter.spent().map((spend) => [spend.purpose, spend.prompt])).toEqual([
      ["detect", 10],
      ["draft", 900],
    ]);
  });

  it("adds a model's requests together rather than listing them", async () => {
    const meter = createMeter();
    const provider = stub([
      answering("a", { prompt: 10, completion: 2 }),
      answering("a", { prompt: 30, completion: 4 }),
    ]);
    const drafting = metered(provider, meter, "draft");

    await drafting.complete("a", []);
    await drafting.complete("a", []);

    expect(meter.spent()).toMatchObject([{ requests: 2, prompt: 40, completion: 6 }]);
  });

  it("counts a failed request, because the provider counted it too", async () => {
    const meter = createMeter();
    const provider = stub([failing("a", { prompt: 12, completion: 0 })]);

    await metered(provider, meter, "draft").complete("a", []);

    expect(meter.spent()).toMatchObject([{ requests: 1, failed: 1, prompt: 12 }]);
  });

  it("counts a request whose cost nobody reported, instead of scoring it zero", async () => {
    const meter = createMeter();
    const provider = stub([answering("a"), answering("a", { prompt: 5, completion: 5 })]);
    const drafting = metered(provider, meter, "draft");

    await drafting.complete("a", []);
    await drafting.complete("a", []);

    expect(meter.spent()).toMatchObject([{ requests: 2, unreported: 1, prompt: 5, completion: 5 }]);
  });

  it("keeps the order the pipeline asked in", async () => {
    const meter = createMeter();
    const provider = stub([]);

    await metered(provider, meter, "detect").complete("picker", []);
    await metered(provider, meter, "draft").complete("writer", []);
    await metered(provider, meter, "judge").complete("seat", []);

    expect(meter.spent().map((spend) => spend.model)).toEqual(["picker", "writer", "seat"]);
  });

  it("reports nothing for a run that asked nothing", () => {
    // The run where code decided everything — the cheapest and most common one.
    expect(createMeter().spent()).toEqual([]);
  });
});

describe("metered", () => {
  it("returns the provider's own answer, unchanged", async () => {
    const answer = answering("a", { prompt: 1, completion: 1 });

    expect(await metered(stub([answer]), createMeter(), "draft").complete("a", [])).toBe(answer);
  });

  it("passes the request through as it was made", async () => {
    // A decorator that dropped `temperature` would quietly change what every
    // drafting request asks for, and the only symptom would be worse drafts.
    const provider = stub([]);
    const messages = [{ role: "user", content: "hello" }] as const;

    await metered(provider, createMeter(), "draft").complete("a", messages, { temperature: 0.2 });

    expect(provider.complete).toHaveBeenCalledWith("a", messages, { temperature: 0.2 });
  });
});

describe("total", () => {
  it("adds up every row", async () => {
    const meter = createMeter();
    const provider = stub([
      answering("a", { prompt: 10, completion: 1 }),
      failing("b"),
      answering("b", { prompt: 5, completion: 2 }),
    ]);

    await metered(provider, meter, "detect").complete("a", []);
    await metered(provider, meter, "draft").complete("b", []);
    await metered(provider, meter, "draft").complete("b", []);

    expect(total(meter.spent())).toEqual({
      requests: 3,
      failed: 1,
      unreported: 1,
      prompt: 15,
      completion: 3,
    });
  });

  it("adds up nothing to zero rather than to nothing", () => {
    expect(total([])).toEqual({ requests: 0, failed: 0, unreported: 0, prompt: 0, completion: 0 });
  });
});
