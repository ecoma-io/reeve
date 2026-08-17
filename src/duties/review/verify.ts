/**
 * The deterministic engine that turns admitted model findings into verifiable
 * claims. Only model findings reach it (the caller never passes the preflight
 * findings, which are always-right by construction); each is checked against
 * evidence the diff already proves — the claimed snippet against the
 * diff-proven line text, and the cited rule against the rules snapshot — and
 * carries the result on the finding itself. No model pass, no subprocess, no
 * command execution: everything here reads data this run already read.
 */
import type { Evidence, VerificationStatus } from "./evidence.js";
import { deriveStatus } from "./evidence.js";
import type { Finding } from "./findings.js";
import {
  MAX_EVIDENCE_ITEMS_PER_RUN,
  MAX_EVIDENCE_PER_FINDING,
  MAX_EVIDENCE_TOTAL_CHARS,
} from "./limits.js";
import { diffEvidence, ruleEvidence } from "./providers.js";
import type { Rules } from "./rules.js";

/** A model finding plus the deterministic evidence that proves or fails it. */
export interface VerifiedFinding extends Finding {
  readonly evidence: readonly Evidence[];
  readonly verification: VerificationStatus;
}

export interface VerifyRequest {
  readonly findings: readonly Finding[];
  readonly shown: readonly { path: string; lines: ReadonlyMap<number, string> }[];
  readonly rules: Rules;
  readonly headSha: string;
}

/**
 * Verifies each model finding against deterministic evidence.
 *
 * A finding's evidence is the rule it cites (when the rules snapshot contains
 * it) plus the diff-proven line its claimed snippet matches (when the finding
 * names a line). Evidence is bounded per finding and per run; when a limit
 * would be exceeded the kept evidence is truncated to the highest-weight items
 * and the status is derived from what was kept — the finding itself is never
 * dropped. `verified` only on a proven-at-line item; everything else stays
 * `unverified`.
 */
export function verifyFindings(request: VerifyRequest): readonly VerifiedFinding[] {
  const shown = new Map(request.shown.map((file) => [file.path, file]));
  let runItems = 0;
  let runChars = 0;

  return request.findings.map((finding) => {
    const collected: Evidence[] = [];
    const rule = ruleEvidence(request.rules, finding.ruleId);
    if (rule !== null) collected.push(rule);
    if (finding.line !== null) {
      const file = shown.get(finding.path);
      if (file !== undefined) {
        const diff = diffEvidence(file, finding.line, finding.snippet ?? null, request.headSha);
        if (diff !== null) collected.push(diff);
      }
    }

    // Bounded, highest-weight first, so the run's total evidence never floods
    // the envelope or the summary while the finding still reports its status.
    const room = MAX_EVIDENCE_PER_FINDING;
    const kept: Evidence[] = [];
    for (const entry of collected.sort((a, b) => b.weight - a.weight)) {
      if (kept.length >= room) break;
      if (runItems >= MAX_EVIDENCE_ITEMS_PER_RUN) break;
      if (runChars + entry.detail.length > MAX_EVIDENCE_TOTAL_CHARS) break;
      kept.push(entry);
      runItems += 1;
      runChars += entry.detail.length;
    }

    const verification = deriveStatus(kept);
    return { ...finding, evidence: kept, verification };
  });
}
