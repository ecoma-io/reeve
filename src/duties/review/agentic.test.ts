import { describe, expect, it } from "vitest";

import { agenticAnswer } from "./agentic.js";
import { DEFAULT_TOOL_BUDGET, type ToolBudget, type ToolExecutor } from "./tools.js";
import type { Completion, Message, Provider, ToolCall } from "../../core/provider.js";

const BASE: readonly Message[] = [
  { role: "system", content: "review" },
  { role: "user", content: "the pr" },
];

function calling(calls: readonly ToolCall[]): Completion {
  return { ok: true, model: "m", content: "", toolCalls: calls, finishReason: "tool_calls" };
}

function saying(content: string, finishReason = "stop"): Completion {
  return { ok: true, model: "m", content, finishReason };
}

/** A scripted provider that records every request it saw. */
function scripted(answers: readonly Completion[]): {
  provider: Provider;
  seen: Message[][];
} {
  const queue = [...answers];
  const seen: Message[][] = [];
  return {
    seen,
    provider: {
      complete: (_model, messages) => {
        seen.push([...messages]);
        const next = queue.shift();
        if (next === undefined) throw new Error("scripted provider ran dry");
        return Promise.resolve(next);
      },
    },
  };
}

function recordingExecutor(result = "TOOL RESULT"): ToolExecutor & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    execute: (call) => {
      calls.push(call);
      return Promise.resolve(result);
    },
    trace: () => [],
    pulled: () => 0,
  };
}

const BUDGET: ToolBudget = { ...DEFAULT_TOOL_BUDGET, maxRounds: 3, maxCallsPerRound: 2 };

/** Narrows for assertions, failing the test rather than the type checker. */
function expectSuccess(completion: Completion): Extract<Completion, { ok: true }> {
  if (!completion.ok) throw new Error(`expected a success, got: ${completion.reason}`);
  return completion;
}

function expectFailure(completion: Completion): Extract<Completion, { ok: false }> {
  if (completion.ok) throw new Error(`expected a failure, got: ${completion.content}`);
  return completion;
}

describe("agenticAnswer", () => {
  it("answers a tool call, fences the result, and returns the final verdict", async () => {
    const call: ToolCall = { id: "c1", name: "read_diff", arguments: '{"path":"a.ts"}' };
    const { provider, seen } = scripted([calling([call]), saying('{"findings":[]}')]);
    const executor = recordingExecutor("THE PATCH");

    const completion = expectSuccess(await agenticAnswer(provider, "m", BASE, executor, BUDGET));

    expect(completion.content).toBe('{"findings":[]}');
    expect(executor.calls).toEqual([call]);
    // The second request replays the assistant's calls and answers them.
    const second = seen[1] ?? [];
    expect(second[2]).toMatchObject({ role: "assistant", toolCalls: [call] });
    const toolMessage = second[3];
    expect(toolMessage?.role).toBe("tool");
    expect(toolMessage?.toolCallId).toBe("c1");
    expect(toolMessage?.content).toContain("THE PATCH");
    // Fenced under a fresh nonce: the untrusted diff text cannot pose as a
    // system message mid-conversation.
    expect(toolMessage?.content).toContain('<untrusted-tool-result id="');
  });

  it("passes a direct answer through untouched", async () => {
    const { provider } = scripted([saying("verdict")]);
    const completion = expectSuccess(
      await agenticAnswer(provider, "m", BASE, recordingExecutor(), BUDGET),
    );
    expect(completion.content).toBe("verdict");
  });

  it("fails loudly when the rounds run out — a half-read diff is never a verdict", async () => {
    const call: ToolCall = { id: "c", name: "read_diff", arguments: "{}" };
    const { provider } = scripted([calling([call]), calling([call]), calling([call])]);
    const completion = expectFailure(
      await agenticAnswer(provider, "m", BASE, recordingExecutor(), BUDGET),
    );
    expect(completion.kind).toBe("protocol");
    expect(completion.reason).toContain("round");
  });

  it("treats a truncated direct answer as the failure it is", async () => {
    const { provider } = scripted([saying("half a verd", "length")]);
    const completion = expectFailure(
      await agenticAnswer(provider, "m", BASE, recordingExecutor(), BUDGET),
    );
    expect(completion.reason).toContain("cut off");
  });

  it("passes provider failures through with their kinds intact", async () => {
    const failure: Completion = { ok: false, model: "m", kind: "capacity", reason: "429" };
    const { provider } = scripted([failure]);
    const completion = await agenticAnswer(provider, "m", BASE, recordingExecutor(), BUDGET);
    expect(completion).toBe(failure);
  });

  it("refuses calls past the per-round cap without executing them", async () => {
    const calls: ToolCall[] = [
      { id: "c1", name: "read_diff", arguments: "{}" },
      { id: "c2", name: "read_diff", arguments: "{}" },
      { id: "c3", name: "read_diff", arguments: "{}" },
    ];
    const { provider, seen } = scripted([calling(calls), saying("done")]);
    const executor = recordingExecutor();

    const completion = await agenticAnswer(provider, "m", BASE, executor, BUDGET);

    expect(completion.ok).toBe(true);
    expect(executor.calls).toHaveLength(2); // the cap
    const second = seen[1] ?? [];
    // Every call is still answered — an unanswered id breaks the conversation.
    const toolMessages = second.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[2]?.content).toContain("too many tool calls");
  });
});
