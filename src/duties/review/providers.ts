/**
 * The two deterministic evidence providers: both read only what the run has
 * already read — the diff-proven lines and the repository's rules snapshot —
 * and both return null when evidence cannot be established. That is the
 * conservative default: absence of proof is never filled in from confidence.
 */
import type { Evidence } from "./evidence.js";

/**
 * The diff-proven line at `line` in `file`, checked against the model's
 * claimed snippet. Both sides are trimmed; they match when the claimed snippet
 * is a non-empty substring of the proven line text or the proven line text is
 * a substring of the claimed snippet — i.e. they agree on significant text.
 * Returns null (no evidence) when there is no line, no claim, or no agreement.
 */
export function diffEvidence(
  file: { path: string; lines: ReadonlyMap<number, string> },
  line: number | null,
  claimedSnippet: string | null,
  headSha: string,
): Evidence | null {
  if (line === null || claimedSnippet === null) return null;
  const claim = claimedSnippet.trim();
  if (claim.length === 0) return null;
  const proven = file.lines.get(line)?.trim() ?? "";
  if (proven.length === 0) return null;
  if (!proven.includes(claim) && !claim.includes(proven)) return null;
  return {
    kind: "diff",
    weight: 1,
    detail: `diff-proven line ${String(line)}`,
    provenance: {
      ruleId: "diff-evidence",
      sourceFile: file.path,
      atLine: line,
      ref: { sha: headSha, path: file.path },
    },
    at: "deterministic",
  };
}

/**
 * The repository's rules snapshot proves a rule with `ruleId` exists, so a
 * finding that cites it is consistent with the rules the run read. Absence of
 * the rule is no evidence.
 */
export function ruleEvidence(
  rules: { rules: readonly { id: string }[]; raw: string },
  ruleId: string,
): Evidence | null {
  if (!rules.rules.some((entry) => entry.id === ruleId)) return null;
  return {
    kind: "rules",
    weight: 0.6,
    detail: "cites a repository rule",
    provenance: {
      ruleId,
      sourceFile: "repository rules",
      atLine: null,
      ref: { sha: "", path: "" },
    },
    at: "deterministic",
  };
}
