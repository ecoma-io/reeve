/**
 * What a review finding is verified against: deterministic evidence the diff
 * itself already proves, never a model's confidence.
 *
 * A finding is `verified` only when actual evidence with `weight >= 1` —
 * proven-at-line — establishes it. Anything less (a cited rule, a plausible
 * snippet that does not match the diff-proven text) stays `unverified`. Model
 * confidence is deliberately not an input: a 0.99-confidence claim about a
 * line whose text the diff does not prove is still unverified, and no number
 * from the model upgrades absence.
 */
import { fingerprint } from "../../core/marker.js";
import { MAX_EVIDENCE_TEXT } from "./limits.js";

/** A place in a specific commit — the strongest anchor a diff run can cite. */
export interface EvidenceRef {
  readonly sha: string;
  readonly path: string;
}

/** One item of deterministic evidence a finding's verification rests on. */
export interface Evidence {
  readonly kind: "diff" | "rules";
  /** 1 = proven-at-line, 0.6 = consistent-with-rule. */
  readonly weight: number;
  /** Short human string (capped at MAX_EVIDENCE_TEXT before hashing). */
  readonly detail: string;
  readonly provenance: {
    readonly ruleId: string;
    readonly sourceFile: string;
    readonly atLine: number | null;
    readonly ref: EvidenceRef;
  };
  readonly at: "deterministic";
}

export type VerificationStatus = "verified" | "unverified";

/**
 * A finding is `verified` only when at least one evidence item is proven at
 * line (`weight >= 1`). Model confidence is NOT an input — it can never
 * upgrade absence.
 */
export function deriveStatus(evidence: readonly Evidence[]): VerificationStatus {
  return evidence.some((entry) => entry.weight >= 1) ? "verified" : "unverified";
}

/**
 * A deterministic, sorted, bounded digest over a finding's evidence — parallel
 * to `findingFingerprint`. Sort by (kind, sourceFile, atLine, detail), cap each
 * detail at MAX_EVIDENCE_TEXT before hashing, and key the digest
 * `["review-evidence"]`.
 */
export function evidenceFingerprint(evidence: readonly Evidence[]): string {
  const rows = evidence
    .map((entry) => ({
      kind: entry.kind,
      sourceFile: entry.provenance.sourceFile,
      atLine: entry.provenance.atLine,
      detail: entry.detail.slice(0, MAX_EVIDENCE_TEXT),
    }))
    .sort((a, b) => {
      // Byte order throughout — a locale collation can flip which row sorts
      // first (e.g. `Foo.ts` vs `foo.ts`) and change the digest.
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
      const line = (a.atLine ?? 0) - (b.atLine ?? 0);
      if (line !== 0) return line;
      return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
    })
    .map(
      (entry) =>
        `${entry.kind}\n${entry.sourceFile}\n${String(entry.atLine ?? "")}\n${entry.detail}`,
    );
  return fingerprint(rows.join("\n"), ["review-evidence"]);
}
