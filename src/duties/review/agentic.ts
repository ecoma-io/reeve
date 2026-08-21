/**
 * The bounded tool loop one agentic pass runs — the conversation half of the
 * doctrine's "bounded tool loops inside a duty" (`agent-runtime.md`).
 *
 * One model gets one conversation: the pass's own prompt, then rounds of
 * tool calls answered by the executor, until the model answers with content
 * (the verdict, parsed by the same strict parser every pass uses) or a bound
 * is hit. Every bound is a loud protocol failure, never a partial answer:
 * a loop that died mid-read is a pass that failed (D5), and rotation hands
 * the next model a fresh conversation, not this one's history.
 *
 * Every tool result enters the conversation fenced under its own fresh
 * nonce (`enclose`): a diff hunk that contains instructions is exactly the
 * material the fence exists for, and it arrives here mid-conversation where
 * the original prompt's fence cannot reach.
 */
import { enclose } from "../../core/enclose.js";
import type { Completion, Message, Provider } from "../../core/provider.js";
import { REVIEW_TOOLS, type ToolBudget, type ToolExecutor } from "./tools.js";

/**
 * Runs the loop for one model and answers with its final completion: the
 * content-bearing success the caller parses as a verdict, or the failure
 * that ended the attempt. Capacity and protocol failures pass through with
 * their kinds intact, so the caller's rotation and fallback read them the
 * same way they read a single-shot ask.
 */
export async function agenticAnswer(
  provider: Provider,
  model: string,
  base: readonly Message[],
  executor: ToolExecutor,
  budget: ToolBudget,
): Promise<Completion> {
  const messages: Message[] = [...base];

  for (let round = 0; round < budget.maxRounds; round += 1) {
    const completion = await provider.complete(model, messages, { tools: REVIEW_TOOLS });
    if (!completion.ok) return completion;

    const calls = completion.toolCalls ?? [];
    if (calls.length === 0) {
      // The model answered directly. A truncated answer is the failure it is
      // — the same rule the single-shot ask applies — and an empty one cannot
      // happen here (the provider already refuses empty content).
      if (completion.finishReason === "length") {
        return {
          ok: false,
          model,
          kind: "protocol",
          reason: "the answer was cut off before it finished",
        };
      }
      return completion;
    }

    // The conversation replays the assistant's calls verbatim, then answers
    // every one of them — a call left unanswered would break the next
    // request's shape on providers that check. Calls past the per-round cap
    // are answered with a refusal rather than executed.
    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: calls,
    });
    let answered = 0;
    for (const call of calls) {
      const text =
        answered < budget.maxCallsPerRound
          ? await executor.execute(call)
          : `Error: too many tool calls in one round — only the first ` +
            `${String(budget.maxCallsPerRound)} were answered. Ask again next round.`;
      answered += 1;
      messages.push({
        role: "tool",
        content: enclose("untrusted-tool-result", text).block,
        toolCallId: call.id,
      });
    }
  }

  return {
    ok: false,
    model,
    kind: "protocol",
    reason: `the tool loop spent its ${String(budget.maxRounds)} round(s) without a verdict`,
  };
}
