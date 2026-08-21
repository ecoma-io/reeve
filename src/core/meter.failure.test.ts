/**
 * The bill when the provider is what went wrong.
 *
 * `meter.test.ts` counts a ledger against hand-built completions. This drives
 * the same ledger from the real provider seam, because the two questions a
 * failed run's cost table has to answer are both about the boundary rather
 * than about the arithmetic:
 *
 * - **Is a request that failed still in the bill?** It has to be. A gateway
 *   charges for an `HTTP 200` carrying nothing usable exactly as it charges
 *   for an answer, and a ledger that counted only the answers it liked would
 *   understate a rotation-heavy run — which is every run on a free tier.
 * - **Is a request that was never made kept *out* of it?** Equally. A model
 *   the weather already grounded is skipped without a request, and a row for
 *   it would be a charge nobody could find on an invoice.
 *
 * Between them those two decide whether `Failed` in the cost table means
 * anything, and the cost table is the one place a maintainer sees how much a
 * bad roster is costing before they see it on a bill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMeter, metered, type Meter } from "./meter.js";
import {
  createProvider,
  createRoutedProvider,
  createWeather,
  rotateModels,
  type Provider,
} from "./provider.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HELLO = [{ role: "user", content: "hello" }] as const;

function subject(): Provider {
  return createProvider({ baseUrl: "https://api.example.test/v1", apiKey: "sk-test" });
}

/** The model id the stub was asked for, read back out of the request body. */
function askedModel(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("expected a string body");
  const parsed = JSON.parse(init.body) as { model?: unknown };
  if (typeof parsed.model !== "string") throw new Error("expected a model id");
  return parsed.model;
}

describe("what a failed request costs", () => {
  it("bills an answer the provider charged for and Reeve could not use", async () => {
    // The shape this matters for: `HTTP 200`, a `usage` block, and content
    // that is only whitespace. A ledger keyed on success would record nothing
    // here, and the run's totals would be short by every rotation it paid for.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "   " } }],
          usage: { prompt_tokens: 812, completion_tokens: 4 },
        }),
        { status: 200 },
      ),
    );

    const meter: Meter = createMeter();
    await metered(subject(), meter, "draft").complete("m", HELLO);

    expect(meter.spent()).toEqual([
      {
        purpose: "draft",
        model: "m",
        endpoint: null,
        requests: 1,
        failed: 1,
        unreported: 0,
        prompt: 812,
        completion: 4,
      },
    ]);
  });

  it("counts a request that never reached the endpoint as one whose cost nobody reported", async () => {
    // A DNS failure or a refused connection carries no numbers at all, and a
    // zero would read as "this attempt was free" in a column that is meant to
    // say "this total is a floor".
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.example.test"));

    const meter = createMeter();
    await metered(subject(), meter, "detect").complete("m", HELLO);

    expect(meter.spent()).toMatchObject([
      { requests: 1, failed: 1, unreported: 1, prompt: 0, completion: 0 },
    ]);
  });

  it("keeps a model's failed attempt and its later answer on one row", async () => {
    // Rotation's cost, made visible: the same model asked twice for the same
    // purpose is one line with `failed` under `requests`, never two lines that
    // a reader has to add up.
    let first = true;
    fetchMock.mockImplementation(() => {
      const response = first
        ? new Response("<html>502</html>", { status: 502 })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: "hi" } }],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            }),
            { status: 200 },
          );
      first = false;
      return Promise.resolve(response);
    });

    const meter = createMeter();
    const drafting = metered(subject(), meter, "draft");
    await drafting.complete("m", HELLO);
    await drafting.complete("m", HELLO);

    expect(meter.spent()).toMatchObject([
      { model: "m", requests: 2, failed: 1, unreported: 1, prompt: 10, completion: 2 },
    ]);
  });
});

describe("what a skipped request costs", () => {
  it("never bills a model the weather grounded, because no request was made", async () => {
    // `rotateModels` reports a grounded model as a failure without asking it
    // anything, and that failure never passes through a metered provider. A
    // row for it would be a charge with no request behind it — and `Failed`
    // in the cost table would stop meaning "requests this run paid for and
    // could not use".
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "from b" } }] }), {
        status: 200,
      }),
    );

    const weather = createWeather();
    weather.ground("a");

    const meter = createMeter();
    const drafting = metered(subject(), meter, "draft");
    const rotation = await rotateModels(
      ["a", "b"],
      (model) => drafting.complete(model, HELLO),
      weather,
    );

    expect(rotation.failures.map((failure) => failure.model)).toEqual(["a"]);
    expect(meter.spent().map((spend) => spend.model)).toEqual(["b"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("which model the bill names", () => {
  it("names the id the roster was configured with, not the one that went on the wire", async () => {
    // `createRoutedProvider` strips `@alias` before the request — no
    // provider's catalogue has heard of Reeve's routing suffix — and stamps
    // the roster's own id back onto the completion. The meter has to key on
    // that one: a bill written in wire ids would fold two endpoints' copies of
    // the same model into a single row, and the `Endpoint` column would name
    // whichever of them was asked first.
    fetchMock.mockImplementation((_url, init) => {
      askedModel(init);
      return Promise.resolve(new Response("{}", { status: 503 }));
    });

    const meter = createMeter();
    const routed = createRoutedProvider([
      { alias: null, baseUrl: "https://default.test/v1", apiKey: "k", timeoutMs: 1000 },
      { alias: "fast", baseUrl: "https://fast.test/v1", apiKey: "k2", timeoutMs: 1000 },
    ]);

    await metered(routed, meter, "screen").complete("m@fast", HELLO);

    // The wire saw the bare id; the ledger sees the configured one.
    const call = fetchMock.mock.calls.at(-1);
    expect(askedModel(call?.[1])).toBe("m");
    expect(meter.spent()).toMatchObject([{ model: "m@fast", endpoint: "fast", failed: 1 }]);
  });

  it("bills a routing failure that never made a request against the endpoint it named", async () => {
    // A model whose alias names no configured endpoint fails before any
    // network call. It still belongs in the ledger as a failed attempt — the
    // run tried to ask it — and the row has to carry the alias, because
    // "which endpoint was this meant for" is the whole of the diagnosis.
    const meter = createMeter();
    const routed = createRoutedProvider([
      { alias: "fast", baseUrl: "https://fast.test/v1", apiKey: "k", timeoutMs: 1000 },
    ]);

    await metered(routed, meter, "judge").complete("m", HELLO);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(meter.spent()).toMatchObject([
      { purpose: "judge", model: "m", endpoint: null, requests: 1, failed: 1, unreported: 1 },
    ]);
  });
});

describe("the run's temperature rides with every metered request", () => {
  it("keeps a stage's own options alongside it rather than replacing them", async () => {
    // `temperature` is the run's and the tools are the stage's, and a
    // decorator that let one field win would drop the other silently — the
    // only symptom being worse answers, or a provider rejecting a request
    // nobody meant to change.
    const provider: Provider = {
      complete: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          model: "m",
          content: "hi",
          finishReason: "stop",
        }),
      ),
    };
    const tools = [{ name: "read", description: "read a file", parameters: {} }];

    await metered(provider, createMeter(), "review", 0.2).complete("m", HELLO, { tools });

    expect(provider.complete).toHaveBeenCalledWith("m", HELLO, { temperature: 0.2, tools });
  });
});
