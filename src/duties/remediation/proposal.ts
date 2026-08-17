/**
 * The proposal: what remediation derives from a review finding, and how.
 *
 * The whole duty is this module — a pure function from an envelope to a list
 * of proposal records. Deterministic by construction: the same envelope
 * produces byte-identical records with identical fingerprints, so re-running
 * is cheap and idempotent (the envelope is the memory, and the records are a
 * pure function of it), and a fingerprint gives each proposal a stable
 * identity the future fixing-PR stage can key off.
 *
 * No model is asked anything, ever. The remediation text is template prose
 * derived from the finding's own `ruleBody` and `body` — the words `review`
 * already reconciled — so there is no prompt, no provider, and no way for
 * model output to grant itself authority.
 */
import { fingerprint } from "../../core/marker.js";
import type { Envelope, Finding, PreviousFinding } from "./envelope.js";

/**
 * How this run's view of a finding compares with what the previous run
 * recorded — the same ladder `review`'s own findings use. Remediation reads
 * `review`'s already-reconciled statuses from the envelope rather than
 * re-verifying the diff.
 */
export type Standing = "created" | "persists" | "changed" | "resolved" | "reopened";

/** The deterministic record one run derives from one actionable finding. */
export interface RemediationProposal {
  /** The stable identity of this proposal — what the future fixing-PR stage keys off. */
  readonly fingerprint: string;
  /** The finding's own id: `${rule}:${path}:${line}`. */
  readonly findingId: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: "info" | "warning" | "critical";
  readonly path: string;
  readonly line: number | null;
  /** Review's own words, verbatim. */
  readonly findingBody: string;
  readonly standing: Standing;
  /** Deterministic prose derived from the rule body and the finding body. */
  readonly remediation: string;
}

/** The findings this run proposes for: created, persists, or reopened. */
const ACTIONABLE: ReadonlySet<Standing> = new Set(["created", "persists", "reopened"]);

/**
 * The standing of each finding in the envelope, decided against the full
 * previous record the same way `review`'s own `reconcile` decides it:
 *
 * - a finding whose fingerprint matches a *live* (not resolved) previous
 *   finding is `persists` — the same claim, still standing;
 * - a finding at the same rule/path/line as a live previous one but with a
 *   different fingerprint is `changed` — the code moved under the claim, so
 *   the finding body is stale evidence;
 * - a finding matching by intention (rule and path) a previous finding the
 *   review marked resolved is `reopened` — the claim is back with new
 *   evidence;
 * - everything else is `created`.
 */
export function standingsOf(
  current: readonly Finding[],
  previous: readonly PreviousFinding[],
): ReadonlyMap<string, Standing> {
  const standings = new Map<string, Standing>();
  const live = previous.filter((old) => !old.wasResolved);
  const resolved = previous.filter((old) => old.wasResolved);
  for (const finding of current) {
    const fp = findingFingerprint(finding);
    const atPosition = live.find(
      (old) =>
        old.ruleId === finding.ruleId && old.path === finding.path && old.line === finding.line,
    );
    const standing: Standing =
      atPosition !== undefined
        ? fp === previousFingerprint(atPosition)
          ? "persists"
          : "changed"
        : resolved.some((old) => sameIntention(old, finding))
          ? "reopened"
          : "created";
    standings.set(finding.id, standing);
  }
  return standings;
}

/** Whether two findings intend the same thing — the rung `reopened` rests on. */
function sameIntention(
  a: { readonly ruleId: string; readonly path: string },
  b: { readonly ruleId: string; readonly path: string },
): boolean {
  return a.ruleId === b.ruleId && a.path === b.path;
}

/**
 * The finding's stable identity across runs — the same fingerprint `review`
 * computes, reimplemented locally for the same structural-directionality
 * reason the envelope shape is re-declared (see `envelope.ts`).
 */
export function findingFingerprint(finding: Finding): string {
  return fingerprint(
    `${finding.ruleId}\n${finding.path}\n${finding.line === null ? "" : String(finding.line)}\n${finding.body}`,
    [finding.ruleId],
  );
}

/** The previous record's fingerprint for the same claim, over its own fields. */
function previousFingerprint(old: PreviousFinding): string {
  return fingerprint(
    `${old.ruleId}\n${old.path}\n${old.line === null ? "" : String(old.line)}\n${old.body}`,
    [old.ruleId],
  );
}

/**
 * Derives one proposal per actionable finding, in envelope order.
 *
 * `changed` is deliberately excluded: the code moved under the claim, so the
 * finding body is stale evidence — proposing against it would mislead. A
 * `resolved` finding is excluded because the diff already moved past it.
 */
export function proposeAll(envelope: Envelope): readonly RemediationProposal[] {
  const standings = standingsOf(envelope.findings, envelope.previous);
  return envelope.findings
    .filter((finding) => ACTIONABLE.has(standings.get(finding.id) ?? "created"))
    .map((finding) => proposalFor(finding, standings.get(finding.id) ?? "created"));
}

function proposalFor(finding: Finding, standing: Standing): RemediationProposal {
  const findingId = `${finding.ruleId}:${finding.path}:${String(finding.line ?? 0)}`;
  return {
    fingerprint: fingerprint(`${finding.ruleId}\n${findingFingerprint(finding)}\n${finding.body}`, [
      finding.ruleId,
    ]),
    findingId,
    ruleId: finding.ruleId,
    ruleName: finding.ruleName,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    findingBody: finding.body,
    standing,
    remediation: remediate(finding),
  };
}

/**
 * The deterministic remediation text: no model, no patch — template prose
 * that names the rule, the place, the rule's own intent, and the finding's
 * own words, so a maintainer reading the record has everything the finding
 * had without this duty inventing any of it.
 *
 * `ponytail: a model-generated patch draft is the future step
 * (docs/development/roadmap-2x.md Phase 3-4); this PR ships the proposal
 * floor only, and the future step is itself a separate grant behind the
 * warrant.`
 */
function remediate(finding: Finding): string {
  const where = finding.line === null ? finding.path : `${finding.path}:${String(finding.line)}`;
  return (
    `Rule \`${finding.ruleId}\` (${finding.ruleName}) reports ${where}. ` +
    `${finding.ruleBody} The finding: ${finding.body}. ` +
    `Fix at the reported line; the rule's intent is ${finding.ruleBody}.`
  );
}
