/**
 * The finding model and the memory that keeps a review from repeating itself.
 *
 * A finding is the smallest thing a review says: a rule, a file, a line, and a
 * reason. The duty owns exactly one comment per pull request (see
 * `publish.ts`), so nothing below writes to the thread — it makes the claims a
 * comment will report, and reconciles this run's claims against the ones the
 * previous run's comment already holds.
 *
 * The lifecycle is the whole point: a review that mints the same finding every
 * time a synchronize event fires is not a review, it is a nagging bot, and a
 * finding that goes quiet when the code moved on is a review that lost its own
 * memory. The ladder below — `created → persists → changed → resolved →
 * reopened` — is the thread a human review leaves; this duty's owned comment
 * is that thread, so it follows the same ladder, evidence-based at every rung.
 */
import { fingerprint } from "../../core/marker.js";

/** A single claim a review makes about the diff. */
export interface Finding {
  /** Stable across runs: what the finding is about, not this run's opinion of it. */
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly ruleBody: string;
  readonly path: string;
  /** A new-file line number the patch proves, or null when the finding is about the file as a whole. */
  readonly line: number | null;
  readonly severity: "info" | "warning" | "critical";
  readonly body: string;
  /** The deterministic marker that produced this finding, or "" when a model wrote it. */
  readonly marker: string;
}

/**
 * A finding as the model's answer claims it — the unproven shape that has to
 * name a rule, a file, a line and the exact text at it before it can be
 * admitted into `Finding`. See `verdict.ts`'s `parseFinding` for the proof.
 */
export interface RawFinding {
  readonly rule: string;
  readonly severity: "info" | "warning" | "critical";
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
  readonly snippet: string;
}

/** How this run's view of a finding compares with what the previous run recorded. */
export type Status = "created" | "persists" | "changed" | "resolved" | "reopened";

/**
 * A finding exactly as the previous run recorded it.
 *
 * `wasResolved` is the memory that makes `reopened` meaningful: when a finding
 * has been resolved (by the review itself — the diff moved on and it went
 * quiet), it stays in the payload so a later run can tell "this claim is back
 * with new evidence" from "this is a brand-new claim". A resolved finding that
 * silently disappears from the record would turn every reintroduction into a
 * `created`, and the review thread would lose the `reopened` rung it holds in
 * a human review.
 */
export interface PreviousFinding extends Finding {
  readonly wasResolved: boolean;
}

/** What the previous run left in the owned comment's fingerprint payload. */
export interface Previous {
  readonly findings: readonly PreviousFinding[];
  /** Every head SHA this thread has been reviewed against, oldest first. */
  readonly reviewedShas: readonly string[];
}

/** A candidate the model (or the preflight) produced, plus what the run decided became of it. */
export interface Reconciled {
  readonly finding: Finding;
  readonly status: Status;
}

/** The stable identity of a finding: the rule, the place, and the claim text. */
export function findingFingerprint(finding: Finding): string {
  // `fingerprint` lowercases and sorts the key set; the claim text is the part
  // that changes when the code changes, which is exactly what should force a
  // `changed` rather than a `persists`.
  return fingerprint(
    `${finding.ruleId}\n${finding.path}\n${finding.line === null ? "" : String(finding.line)}\n${finding.body}`,
    [finding.ruleId],
  );
}

/** Whether two findings intend the same thing — the rung `reopened` rests on. */
export function sameIntention(a: Finding, b: Finding): boolean {
  return a.ruleId === b.ruleId && a.path === b.path;
}

/**
 * Reconciles this run's findings against the previous run's, so the owned
 * comment reports a survey of the thread, not a re-publication of it.
 *
 * Per candidate:
 *
 * - a finding on the same rule, file, line as a previously-active one with the
 *   same fingerprint is `persists` — carried as-is, text unchanged;
 * - the same position with a different fingerprint is `changed` — the code
 *   moved under it, so the comment shows the delta rather than the echo;
 * - a candidate matching (by intention) a finding the previous run marked
 *   `resolved` is `reopened` — the claim is back, so the thread re-opens it;
 * - everything else is `created`.
 *
 * Every previously-active finding this run has no evidence for becomes
 * `resolved`: the code changed and the claim did not survive the change. The
 * comment renders it under a "Resolved" heading (it stays part of the thread's
 * history), and the payload keeps it, marked resolved, so a reintroduction is
 * later told apart from a newborn claim.
 *
 * This is what the anti-pattern "do not blindly repost the same findings" is
 * enforced with: an identical claim that was resolved is not a `created`, and
 * a claim the model repeats run after run at an unchanged position cannot
 * change its fingerprint — it stays `persists`, which the rendering collapses
 * into stability the reader can recognise rather than a growing copy of itself.
 */
export function reconcile(candidates: readonly Finding[], previous: Previous): Reconciled[] {
  const out: Reconciled[] = [];
  const active = previous.findings.filter((old) => !old.wasResolved);
  const resolved = previous.findings.filter((old) => old.wasResolved);
  const matched = new Set<string>();

  for (const candidate of candidates) {
    const fp = findingFingerprint(candidate);
    const atPosition = active.find(
      (old) =>
        old.ruleId === candidate.ruleId &&
        old.path === candidate.path &&
        old.line === candidate.line,
    );
    if (atPosition !== undefined) {
      matched.add(findingFingerprint(atPosition));
      if (fp === findingFingerprint(atPosition)) {
        out.push({ finding: candidate, status: "persists" });
      } else {
        out.push({ finding: candidate, status: "changed" });
      }
      continue;
    }
    const previouslyResolved = resolved.find((old) => sameIntention(old, candidate));
    if (previouslyResolved !== undefined) {
      matched.add(findingFingerprint(previouslyResolved));
      out.push({ finding: candidate, status: "reopened" });
      continue;
    }
    out.push({ finding: candidate, status: "created" });
  }

  for (const old of active) {
    if (!matched.has(findingFingerprint(old))) {
      out.push({ finding: old, status: "resolved" });
    }
  }

  return out;
}

/**
 * What the next run should remember: the findings this run will show, each
 * marked resolved when this run resolved it, plus the head SHAs reviewed.
 */
export function remember(
  reconciled: readonly Reconciled[],
  headSha: string,
  previous: Previous,
): Previous {
  const seen = new Set<string>();
  const findings: PreviousFinding[] = [];
  for (const entry of reconciled) {
    if (entry.status === "resolved") {
      findings.push({ ...entry.finding, wasResolved: true });
      seen.add(findingFingerprint(entry.finding));
      continue;
    }
    findings.push({ ...entry.finding, wasResolved: false });
    seen.add(findingFingerprint(entry.finding));
  }
  // Findings resolved in an earlier run but still in the payload stay there,
  // so `reopened` keeps a memory to work against.
  for (const old of previous.findings) {
    if (old.wasResolved && !seen.has(findingFingerprint(old))) {
      findings.push(old);
      seen.add(findingFingerprint(old));
    }
  }
  const shas = previous.reviewedShas.includes(headSha)
    ? previous.reviewedShas
    : [...previous.reviewedShas, headSha].slice(-8);
  return { findings, reviewedShas: shas };
}
