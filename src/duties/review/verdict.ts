/**
 * The one stage of this duty that talks to a model: turning the diff and the
 * repository's rules into findings.
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
 * **A model is rotated past, never retried**, for the same reason
 * `duplicate/verdict.ts` does not retry: quota, a decommissioned id and an
 * outage do not clear inside one run.
 *
 * **The diff is untrusted**: every line of it was written by the pull request's
 * author, so every line enters the prompt behind `enclose`, and the repository
 * rules (which the same maintainers who write the warrant wrote) enter
 * unwrapped — the one text this prompt treats as its own.
 */
import { enclose } from "../../core/enclose.js";
import { segments } from "../../core/markdown.js";
import type { Completion, Failure, Message, Provider, Weather } from "../../core/provider.js";
import { rotateModels } from "../../core/provider.js";
import type { RawFinding } from "./findings.js";
import type { ShownFile } from "./pr.js";
import type { Rule } from "./rules.js";

/** The model's answer: an array of findings, each naming a rule the diff supports. */
export interface Verdict {
  /** What the model decided the diff should change, one finding per claim. */
  readonly findings: readonly RawFinding[];
  /** Its own confidence, 0 to 1 — compared against the run's floor by the caller. */
  readonly confidence: number;
}

/** The answer when no model reached one, or when the only thing readable was nothing. */
export const NOTHING: Verdict = { findings: [], confidence: 0 };

export interface ReviewRequest {
  readonly provider: Provider;
  /** Model ids in preference order. */
  readonly models: readonly string[];
  /** The pull request standing, already labelled and truncated. */
  readonly prTitle: string;
  readonly prBody: string;
  /** The head SHA the diff was read at — told so the model cannot invent a newer one. */
  readonly headSha: string;
  /** The files the review actually shows, in listing order, each with its proved lines. */
  readonly files: readonly ShownFile[];
  /** The repository's own rules, already trusted, unwrapped in the system prompt. */
  readonly rules: readonly Rule[];
  /** The language, when the duty identified one, so the review can be read in it. */
  readonly language: string | null;
  readonly weather?: Weather;
}

/** What the run didn't get from the model, and why, all in one shape. */
export interface Reviewed {
  readonly verdict: Verdict;
  readonly failures: readonly Failure[];
  /** The answer that could not be read, when one came back and did not parse. */
  readonly unreadable: string | null;
  /** The model that actually answered — null only when every model failed. */
  readonly model: string | null;
}

/**
 * How much of each file's patch reaches the prompt. The diff is capped by the
 * caller's `max-diff-chars`; this is the per-file ceiling inside the prompt,
 * sitting under the model's own context window, so a single huge file does not
 * crowd the rest of the review out.
 */
const PATCH_EXCERPT = 4000;

export async function review(request: ReviewRequest): Promise<Reviewed> {
  const { provider, models, weather, files } = request;
  // Nothing to read is not a failure — a PR whose diff is all ignored,
  // removed, binary or capped comes back with no files at all, and asking a
  // model to review nothing would spend a request to learn what was already
  // known. The preflight findings still fire on the empty diff's behalf.
  if (files.length === 0) {
    return { verdict: NOTHING, failures: [], unreadable: null, model: null };
  }

  const messages = prompt(request);
  const rotation = await rotateModels(
    models,
    (model) => answer(provider, model, messages),
    weather,
  );
  if (!rotation.success) {
    return { verdict: NOTHING, failures: rotation.failures, unreadable: null, model: null };
  }

  const verdict = parseVerdict(rotation.success.content, files);
  return {
    verdict: verdict ?? NOTHING,
    failures: rotation.failures,
    unreadable: verdict === null ? rotation.success.content : null,
    model: rotation.success.model,
  };
}

/**
 * One completion, with a truncated answer reported as the failure it is —
 * the same rule `duplicate/verdict.ts`'s own `answer` follows and for the
 * same reason. `finish_reason: length` means the model ran out of room before
 * the JSON closed, which is unparseable the same as a malformed body.
 */
async function answer(
  provider: Provider,
  model: string,
  messages: readonly Message[],
): Promise<Completion> {
  const completion = await provider.complete(model, messages);
  if (completion.ok && completion.finishReason === "length") {
    return {
      ok: false,
      model,
      kind: "protocol",
      reason: "the answer was cut off before it finished",
    };
  }
  return completion;
}

/** The answer, or null when it is not a verdict. */
export function parseVerdict(answer: string, files: readonly ShownFile[]): Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped(answer));
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

/** A whole answer wrapped in one fence, unwrapped — the same indulgence duplicate makes. */
function unwrapped(answer: string): string {
  const parts = segments(answer.trim());
  const [only] = parts;
  if (parts.length !== 1 || only?.kind !== "fence") return answer;

  const lines = only.text.split("\n");
  return lines.slice(1, -1).join("\n");
}

/**
 * The instructions, then the diff behind a fence.
 *
 * The diff is untrusted — every line was written by the pull request's author
 * — so it goes inside the one boundary the same way `duplicate/verdict.ts`
 * puts the thread inside it. The rules are trusted (they live in the checkout,
 * written by the same maintainers who wrote the warrant) and enter unwrapped,
 * the same way `respond`'s guidance enters its prompt: prompt injection thinks
 * it is talking to the reviewer, and the reviewer tells it what the project
 * asked it to check.
 */
function prompt(request: ReviewRequest): Message[] {
  const { prTitle, prBody, headSha, files, rules, language } = request;

  const material = enclose(
    "untrusted-diff",
    [
      "--- PULL REQUEST BEING REVIEWED ---",
      `TITLE: ${prTitle}`,
      prBody.length === 0 ? "" : `BODY:\n${prBody}`,
      "",
      "--- DIFF (new-file lines proven; every line number a finding cites must be one of these) ---",
      ...files.map(
        (file) =>
          `### ${file.path} (${file.status})\n` +
          (file.additions + file.deletions === 0
            ? ""
            : `+${String(file.additions)} -${String(file.deletions)}\n`) +
          patchExcerpt(file.patch),
      ),
    ].join("\n"),
  );

  return [
    {
      role: "system",
      content: [
        "You are reviewing a pull request on a GitHub repository.",
        "",
        language === null
          ? "The pull request's language could not be identified from the languages this project reads."
          : `The pull request, its threads and your findings should be written in ${language}.`,
        "",
        `The diff below is the whole universe of this review — every finding must name one of its ` +
          `files and one of its proven new-file line numbers.`,
        "",
        "The repository's own review rules are:",
        ...rules.flatMap((rule) => [
          `- [${rule.id}] ${rule.name}${rule.body.length > 0 ? ` — ${rule.body}` : ""}`,
          rule.marker.length > 0 ? `  mark this rule's findings with marker "${rule.marker}"` : "",
        ]),
        "",
        "Answer with one JSON object and nothing else — no prose, no explanation:",
        "",
        '{"findings": [], "confidence": 0.0}',
        "",
        "- `findings`: zero or more of the shape below, each naming a rule from the repository's",
        "  list, a file from the diff, and a proven line number (or `null` when the problem is",
        "  the file as a whole):",
        "",
        '{"rule": "dedup", "severity": "warning", "path": "src/a.ts", "line": 12,',
        ' "snippet": "the exact text at that line", "body": "one or two sentences. Be specific"}',
        "",
        "- `severity` is one of `info`, `warning`, `critical`. Prefer the repository rule's own",
        "  severity when it sets one.",
        `- Report real problems only. A model that invents a line or a file that is not in the diff ` +
          `is answering a different question — do not.`,
        "",
        `The head SHA of the diff you are reviewing is ${headSha}.`,
        "",
        material.rule,
      ].join("\n"),
    },
    { role: "user", content: material.block },
  ];
}

function patchExcerpt(patch: string): string {
  return patch.length <= PATCH_EXCERPT ? patch : `${patch.slice(0, PATCH_EXCERPT)}\n…`;
}
