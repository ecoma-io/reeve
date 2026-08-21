/**
 * How a pass spends its roster when the diff is served by tools.
 *
 * `runPasses` carries one rule that costs a consumer money when it is wrong:
 * an agentic pass whose every attempt failed is re-run once with the diff
 * embedded — **but only when every failure was a protocol failure.** A model
 * that cannot speak the tools field gets a second, tool-free chance; a roster
 * that is merely out of quota does not, because retrying weather bills the
 * same storm twice and answers no better.
 *
 * `main.integration.test.ts` drives the protocol arm end to end. What is not
 * pinned there is the arm that must NOT fire, which is the expensive one, and
 * the per-attempt bookkeeping the run's trace is built from: a fresh executor
 * for every attempt (no attempt inherits another's pull budget) and a report
 * naming the pass and the model that spent it.
 */
import { describe, expect, it } from "vitest";

import type { Completion, Message, Provider } from "../../core/provider.js";
import { correctnessPass, runPasses, type AgenticSupport, type PassContext } from "./passes.js";
import type { ShownFile } from "./pr.js";
import { DEFAULT_TOOL_BUDGET, type ToolExecutor } from "./tools.js";

function shown(): ShownFile {
  return {
    path: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +12,2 @@\n+const a = 1;",
    lines: new Map([[12, "const a = 1;"]]),
  };
}

const CONTEXT: PassContext = {
  prTitle: "Fix the crash",
  prBody: "",
  headSha: "abc123",
  files: [shown()],
  rules: [{ id: "dedup", name: "Repeated code", marker: "", body: "", severity: "warning" }],
  language: null,
  context: { sections: [], text: null, totalChars: 0, readFiles: 0 },
  agentic: true,
};

const VERDICT = JSON.stringify({ findings: [], confidence: 0.9 });

/** One request the provider saw, reduced to what these cases decide on. */
interface Ask {
  readonly model: string;
  /** True when the request offered the tools — i.e. it was an agentic attempt. */
  readonly withTools: boolean;
  readonly prompt: string;
}

/**
 * A provider whose answer is chosen by the caller from the request itself, so
 * a case can fail the tool-carrying attempts and answer the assembled one
 * without counting rounds.
 */
function recording(reply: (ask: Ask) => Completion): {
  provider: Provider;
  asks: Ask[];
} {
  const asks: Ask[] = [];
  return {
    asks,
    provider: {
      complete: (model, messages: readonly Message[], options) => {
        const ask: Ask = {
          model,
          withTools: options?.tools !== undefined,
          prompt: messages.map((message) => message.content).join("\n"),
        };
        asks.push(ask);
        return Promise.resolve(reply(ask));
      },
    },
  };
}

function failure(kind: "protocol" | "capacity", model: string): Completion {
  return { ok: false, model, kind, reason: `${kind} failure from ${model}` };
}

function answered(model: string): Completion {
  return {
    ok: true,
    model,
    content: VERDICT,
    finishReason: "stop",
  };
}

/** Tracks every executor handed out and every report made against one. */
function support(): AgenticSupport & {
  readonly made: number[];
  readonly reports: { pass: string; model: string }[];
} {
  const made: number[] = [];
  const reports: { pass: string; model: string }[] = [];
  return {
    made,
    reports,
    budget: DEFAULT_TOOL_BUDGET,
    makeExecutor: (): ToolExecutor => {
      made.push(made.length);
      return { execute: () => Promise.resolve(""), trace: () => [], pulled: () => 0 };
    },
    report: (passId, model) => {
      reports.push({ pass: passId, model });
    },
  };
}

describe("the assembled fallback", () => {
  it("re-asks the same pass without tools when every attempt failed on protocol", async () => {
    // The promised fallback: a roster that cannot speak the tools field still
    // gets a review, from the same models, with the diff embedded.
    const { provider, asks } = recording((ask) =>
      ask.withTools ? failure("protocol", ask.model) : answered(ask.model),
    );

    const results = await runPasses(
      provider,
      [correctnessPass()],
      ["m1"],
      CONTEXT,
      undefined,
      support(),
    );

    expect(asks.map((ask) => ask.withTools)).toEqual([true, false]);
    expect(results[0]?.verdict).toEqual({ findings: [], confidence: 0.9 });
    expect(results[0]?.failures).toEqual([]);
  });

  it("embeds the diff in the fallback prompt rather than pointing at tools that failed", async () => {
    // The retry has to change the prompt as well as drop the tools field: a
    // second ask that still says "your tools will serve the diff" would be
    // asking a model that cannot call them to review a diff it never sees.
    const { provider, asks } = recording((ask) =>
      ask.withTools ? failure("protocol", ask.model) : answered(ask.model),
    );

    await runPasses(provider, [correctnessPass()], ["m1"], CONTEXT, undefined, support());

    expect(asks[0]?.prompt).toContain("diffs served by your tools");
    expect(asks[1]?.prompt).not.toContain("diffs served by your tools");
    expect(asks[1]?.prompt).toContain("+const a = 1;");
  });

  it("does not re-ask a roster that ran out of capacity — weather is not billed twice", async () => {
    // The expensive arm. A 429 answers no better without the tools field, so
    // a starved roster is reported starved rather than asked a second time.
    const { provider, asks } = recording((ask) => failure("capacity", ask.model));

    const results = await runPasses(
      provider,
      [correctnessPass()],
      ["m1", "m2"],
      CONTEXT,
      undefined,
      support(),
    );

    expect(asks).toHaveLength(2); // one per model, and no third
    expect(asks.every((ask) => ask.withTools)).toBe(true);
    expect(results[0]?.failures.map((entry) => entry.kind)).toEqual(["capacity", "capacity"]);
    expect(results[0]?.verdict).toBeNull();
  });

  it("does not re-ask when only some of the attempts were protocol failures", async () => {
    // Mixed weather and protocol is still weather: one model that could not
    // speak tools does not make the quota the other one hit any fresher.
    const { provider, asks } = recording((ask) =>
      ask.model === "m1" ? failure("protocol", ask.model) : failure("capacity", ask.model),
    );

    const results = await runPasses(
      provider,
      [correctnessPass()],
      ["m1", "m2"],
      CONTEXT,
      undefined,
      support(),
    );

    expect(asks).toHaveLength(2);
    expect(results[0]?.failures.map((entry) => entry.kind)).toEqual(["protocol", "capacity"]);
  });

  it("keeps the agentic failures when the fallback fails too, rather than reporting one cause", async () => {
    // The pass is unmeasured either way; what a maintainer reads is why. The
    // agentic failures are the ones that name what the models actually did.
    const { provider } = recording((ask) => failure("protocol", ask.model));

    const results = await runPasses(
      provider,
      [correctnessPass()],
      ["m1"],
      CONTEXT,
      undefined,
      support(),
    );

    expect(results[0]?.verdict).toBeNull();
    expect(results[0]?.failures).toHaveLength(1);
    expect(results[0]?.failures[0]?.reason).toContain("protocol failure from m1");
  });

  it("never re-asks a pass that answered on the first attempt", async () => {
    const { provider, asks } = recording((ask) => answered(ask.model));

    await runPasses(provider, [correctnessPass()], ["m1"], CONTEXT, undefined, support());

    expect(asks).toHaveLength(1);
    expect(asks[0]?.withTools).toBe(true);
  });
});

describe("what each agentic attempt is given and reported as", () => {
  it("hands every attempt its own executor, so no attempt inherits another's spend", async () => {
    const tracked = support();
    const { provider } = recording((ask) =>
      ask.model === "m1" ? failure("capacity", ask.model) : answered(ask.model),
    );

    await runPasses(provider, [correctnessPass()], ["m1", "m2"], CONTEXT, undefined, tracked);

    expect(tracked.made).toHaveLength(2);
  });

  it("reports each attempt against the pass and model that spent it", async () => {
    // The run's tool-call trace is built from this hook; a report attributed
    // to the wrong pass would make an expensive pass look cheap.
    const tracked = support();
    const { provider } = recording((ask) =>
      ask.model === "m1" ? failure("capacity", ask.model) : answered(ask.model),
    );

    await runPasses(provider, [correctnessPass()], ["m1", "m2"], CONTEXT, undefined, tracked);

    expect(tracked.reports).toEqual([
      { pass: "correctness", model: "m1" },
      { pass: "correctness", model: "m2" },
    ]);
  });

  it("makes no executor at all for the assembled fallback attempt", async () => {
    // The fallback asks without tools, so an executor built for it would be a
    // pull budget nobody could spend and a trace row nobody made.
    const tracked = support();
    const { provider } = recording((ask) =>
      ask.withTools ? failure("protocol", ask.model) : answered(ask.model),
    );

    await runPasses(provider, [correctnessPass()], ["m1"], CONTEXT, undefined, tracked);

    expect(tracked.made).toHaveLength(1);
    expect(tracked.reports).toEqual([{ pass: "correctness", model: "m1" }]);
  });
});
