/**
 * The three read-only tools an agentic review pass may call, and the executor
 * that answers them — the pull half of the doctrine's bounded tool loop
 * (`docs/development/agent-runtime.md`, "Bounded tool loops inside a duty").
 *
 * Everything here is a read the duty already performs, behind the gates it
 * already holds: the workspace source's own containment for file reads, the
 * secret denylist, and the review's skip decisions (a file the rules file
 * ignored, or the generated defaults skipped, is refused here too — a skip
 * the model could read around would not be a skip). No tool produces an
 * effect, so the capability surface does not move.
 *
 * Budgets are the character caps, relocated: a per-result cap, and a
 * whole-run pull budget past which every call answers "budget exhausted"
 * instead of text. A malformed call answers an error string rather than
 * failing the completion — the model can correct itself inside the round
 * budget, and every answer lands in the trace either way.
 */
import type { ToolCall, ToolDefinition } from "../../core/provider.js";
import { isSecretPath, type WorkspaceSource } from "./context.js";
import type { PrFile } from "./pr.js";

/** The loop's fixed bounds — internal, deliberately not workflow inputs. */
export interface ToolBudget {
  /** Completion rounds one pass may spend before it counts as failed. */
  readonly maxRounds: number;
  /** Tool calls answered per round; the rest of a longer batch are refused. */
  readonly maxCallsPerRound: number;
  /** Characters one tool result may carry. */
  readonly maxResultChars: number;
  /** Characters the whole pass may pull across every result. */
  readonly maxTotalPullChars: number;
  /** Lines one `read_file` call may span. */
  readonly maxFileLines: number;
}

export const DEFAULT_TOOL_BUDGET: ToolBudget = {
  maxRounds: 8,
  maxCallsPerRound: 8,
  maxResultChars: 20_000,
  // ~96k tokens at the conservative 2.5 chars/token — every pulled result
  // stays in the conversation, so this bounds the context the loop can grow.
  maxTotalPullChars: 240_000,
  maxFileLines: 300,
};

/** The tool schemas offered to the model, in the provider's neutral shape. */
export const REVIEW_TOOLS: readonly ToolDefinition[] = [
  {
    name: "list_changed_files",
    description:
      "List every file this pull request changes: path, status, added/deleted line counts, " +
      "and whether its diff is available to read_diff or was skipped (and why). Call this first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_diff",
    description:
      "Read one changed file's unified diff, paged. Only the new-file line numbers this diff " +
      "proves may be cited by a finding. Pass `page` (1-based) to continue a long patch.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "A path from list_changed_files." },
        page: { type: "integer", minimum: 1, description: "1-based page, default 1." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a numbered excerpt of one file from the BASE-branch checkout — context around a " +
      "change, a helper the diff calls, a related test. Evidence only: a finding must still " +
      "cite a diff file and a line read_diff proves.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        start: { type: "integer", minimum: 1, description: "First line, default 1." },
        end: { type: "integer", minimum: 1, description: "Last line, capped to the span budget." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

/** One answered call, for the run's trace. */
export interface ToolTraceEntry {
  readonly name: string;
  readonly ok: boolean;
  /** What was served or why it was refused, one short clause. */
  readonly note: string;
  readonly chars: number;
}

export interface ToolExecutor {
  /** Answers one call; every answer is a string the loop hands back as the tool result. */
  execute(call: ToolCall): Promise<string>;
  /** Every call answered so far, in order. */
  trace(): readonly ToolTraceEntry[];
  /** Characters served so far, against `maxTotalPullChars`. */
  pulled(): number;
}

const EXHAUSTED =
  "The pull budget for this review is exhausted. Answer now with the findings you can prove " +
  "from what you have already read.";

/**
 * Builds the executor for one run: the diff it may serve is exactly the
 * files `classify` decided, the checkout it may read is the same
 * `WorkspaceSource` the context engine reads (or null when the workflow has
 * no checkout, in which case `read_file` says so), and every answer is
 * counted against the pull budget.
 */
export function createToolExecutor(
  files: readonly PrFile[],
  skipped: ReadonlyMap<string, string>,
  source: WorkspaceSource | null,
  budget: ToolBudget,
): ToolExecutor {
  const entries: ToolTraceEntry[] = [];
  let served = 0;

  const record = (name: string, ok: boolean, note: string, text: string): string => {
    served += text.length;
    entries.push({ name, ok, note, chars: text.length });
    return text;
  };

  const answer = async (call: ToolCall): Promise<string> => {
    if (served >= budget.maxTotalPullChars) {
      return record(call.name, false, "pull budget exhausted", EXHAUSTED);
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return record(
          call.name,
          false,
          "arguments not an object",
          "Error: arguments must be a JSON object.",
        );
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return record(
        call.name,
        false,
        "arguments not JSON",
        "Error: arguments were not valid JSON.",
      );
    }

    switch (call.name) {
      case "list_changed_files": {
        const lines = files.map((file) => {
          const reason = skipped.get(file.path);
          return (
            `${file.path} — ${file.status}, +${String(file.additions)} -${String(file.deletions)}` +
            (reason === undefined ? "" : ` — skipped: ${reason}, not readable here`)
          );
        });
        const text = clip(lines.join("\n"), budget.maxResultChars);
        return record(call.name, true, `${String(files.length)} file(s)`, text);
      }

      case "read_diff": {
        const path = typeof args.path === "string" ? args.path : "";
        const page = readPage(args.page);
        const file = files.find((entry) => entry.path === path);
        if (file === undefined) {
          return record(
            call.name,
            false,
            `no such changed file`,
            `Error: ${path} is not a file this pull request changes.`,
          );
        }
        const reason = skipped.get(path);
        if (reason !== undefined) {
          // A skip the model could read around would not be a skip: the
          // configuration's silence and the generated default hold here too.
          return record(
            call.name,
            false,
            `refused: ${reason}`,
            `Error: ${path} was skipped (${reason}) and its diff is not served.`,
          );
        }
        if (file.patch === null || file.patch.length === 0) {
          return record(
            call.name,
            false,
            "no text patch",
            `Error: ${path} has no textual diff (binary or empty).`,
          );
        }
        const pages = Math.max(1, Math.ceil(file.patch.length / budget.maxResultChars));
        if (page > pages) {
          return record(
            call.name,
            false,
            "page out of range",
            `Error: ${path} has ${String(pages)} page(s).`,
          );
        }
        const slice = file.patch.slice(
          (page - 1) * budget.maxResultChars,
          page * budget.maxResultChars,
        );
        const text = `--- ${path} (page ${String(page)}/${String(pages)}) ---\n${slice}`;
        return record(call.name, true, `${path} p${String(page)}/${String(pages)}`, text);
      }

      case "read_file": {
        const path = typeof args.path === "string" ? args.path : "";
        if (source === null) {
          return record(
            call.name,
            false,
            "no checkout",
            "Error: this run has no workspace checkout to read from.",
          );
        }
        if (path.length === 0 || isSecretPath(path)) {
          // The same denylist every context read passes; a refusal here is a
          // refusal the model sees, so a steered read fails loudly and moves on.
          return record(call.name, false, "denied path", `Error: ${path} is not readable.`);
        }
        const body = await source.readText(path);
        if (body === null) {
          return record(
            call.name,
            false,
            "unreadable",
            `Error: ${path} could not be read (missing, denied, or too large).`,
          );
        }
        const lines = body.split("\n");
        const start = readLine(args.start, 1);
        const endAsked = readLine(args.end, start + budget.maxFileLines - 1);
        const end = Math.min(endAsked, start + budget.maxFileLines - 1, lines.length);
        if (start > lines.length) {
          return record(
            call.name,
            false,
            "start past EOF",
            `Error: ${path} has ${String(lines.length)} line(s).`,
          );
        }
        const numbered = lines
          .slice(start - 1, end)
          .map((line, index) => `${String(start + index).padStart(5)} | ${line}`);
        const text = clip(
          `--- ${path} (base branch, lines ${String(start)}-${String(end)} of ${String(lines.length)}) ---\n` +
            numbered.join("\n"),
          budget.maxResultChars,
        );
        return record(call.name, true, `${path}:${String(start)}-${String(end)}`, text);
      }

      default:
        return record(
          call.name,
          false,
          "unknown tool",
          `Error: ${call.name} is not a tool this review offers.`,
        );
    }
  };

  return {
    execute: answer,
    trace: () => entries,
    pulled: () => served,
  };
}

function clip(text: string, cap: number): string {
  return text.length <= cap
    ? text
    : `${text.slice(0, cap)}\n… (truncated at ${String(cap)} characters)`;
}

function readPage(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

function readLine(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : fallback;
}
