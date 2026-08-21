/**
 * The strict reader of the review's model output: turning a model's answer
 * and the repository's files into findings, or into nothing.
 *
 * **Unreadable output is no verdict**, the same rule `duplicate/verdict.ts`
 * follows and for the same reason: the shapes that fail to parse are the
 * shapes an injection produced, and a best-effort parse of the parts that
 * looked fine is most lenient exactly when it should be strictest. A finding
 * that names a file the diff never showed, or a line number the patch cannot
 * prove, is discarded — not clamped, not resolved against the repository,
 * because a model that answers about a file nobody offered it has answered a
 * different question than the one asked.
 *
 * (The pass engine that builds those prompts and rotates past failed models
 * lives in `passes.ts`; this module only reads what came back.)
 */
import { unfenced } from "../../core/markdown.js";
import type { RawFinding } from "./findings.js";
import type { ShownFile } from "./pr.js";

/** The model's answer: an array of findings, each naming a rule the diff supports. */
export interface Verdict {
  /** What the model decided the diff should change, one finding per claim. */
  readonly findings: readonly RawFinding[];
  /** Its own confidence, 0 to 1 — compared against the run's floor by the caller. */
  readonly confidence: number;
}

/** The answer, or null when it is not a verdict. */
export function parseVerdict(answer: string, files: readonly ShownFile[]): Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced(answer));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;

  const confidence = fields.confidence ?? 0;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;

  const rawFindings = fields.findings;
  if (rawFindings === undefined || rawFindings === null) {
    return { findings: [], confidence };
  }
  if (!Array.isArray(rawFindings)) return null;

  const findings: RawFinding[] = [];
  for (const raw of rawFindings) {
    const finding = parseFinding(raw, files);
    if (finding === null) return null;
    findings.push(finding);
  }

  return { findings, confidence };
}

/** One finding, honest to the diff — or null when the model overreached. */
export function parseFinding(raw: unknown, files: readonly ShownFile[]): RawFinding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;

  const rule = fields.rule;
  if (typeof rule !== "string" || rule.trim().length === 0) return null;

  const severity = fields.severity ?? "warning";
  if (severity !== "info" && severity !== "warning" && severity !== "critical") return null;

  const path = fields.path;
  if (typeof path !== "string") return null;
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) return null;

  const line = fields.line ?? null;
  if (typeof line !== "number") return null;
  if (!Number.isInteger(line) || line < 1) return null;
  if (!file.lines.has(line)) return null;

  const body = fields.body;
  if (typeof body !== "string" || body.trim().length === 0) return null;

  const snippet = fields.snippet ?? body;
  if (typeof snippet !== "string") return null;

  return {
    rule: rule.trim(),
    severity,
    path: file.path,
    line,
    body: body.trim(),
    snippet: snippet.slice(0, 120),
  };
}
