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
  /** The head SHA the review resolved this finding at — ties the status claim to a real change. */
  readonly resolvedAtSha?: string;
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

/**
 * What this run's review actually covers, as the diff stood at its head SHA.
 *
 * A resolved finding has to be provably tied to a diff that moved: a model
 * omission alone is not evidence that code changed. `reconcile` consults this
 * standing before it marks anything resolved, so a reread of the same diff
 * never churns a finding's status — see `reconcile` for the exact gate.
 *
 * `files` maps every path the PR names to its proven new-file line set, or
 * `null` when the file is in the review's skipped set (ignored, generated,
 * removed, binary, capped) and carries no line proof this run.
 */
export interface DiffStanding {
  readonly files: ReadonlyMap<string, ReadonlySet<number> | null>;
  /** The head SHA this diff was read at — what a `resolved` status claim is tied to. */
  readonly headSha: string;
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
 * Every previously-active finding this run has no evidence for *and whose
 * position the diff no longer proves* becomes `resolved`: the code changed and
 * the claim did not survive the change. The comment renders it under a
 * "Resolved" heading (it stays part of the thread's history), and the payload
 * keeps it, marked resolved, so a reintroduction is later told apart from a
 * newborn claim.
 *
 * **Resolved is tied to a diff that moved, never to model omission.** A review
 * that calls a finding resolved purely because this run's model did not
 * re-mention it churns the thread on a reread of the same diff — `created →
 * resolved → reopened` on identical synchronize events, with zero code moved.
 * So the gate below is evidence, not absence: a finding is resolved only when
 * its whole file left the review (not shown, not skipped — the file is gone
 * from the pull request), or when the file is still shown but its exact line
 * is no longer proven by the patch. A stale active finding whose file and line
 * still stand is carried forward as `persists` — the review says the claim is
 * still open, with the same text, instead of pretending the diff answered it.
 *
 * This is what the anti-pattern "do not blindly repost the same findings" is
 * enforced with: an identical claim that was resolved is not a `created`, and
 * a claim the model repeats run after run at an unchanged position cannot
 * change its fingerprint — it stays `persists`, which the rendering collapses
 * into stability the reader can recognise rather than a growing copy of itself.
 * A resolved finding that the diff has actually moved past stays in the
 * payload with the SHA it was resolved at, so a later reintroduction is
 * provably distinct from a claim that never left.
 */
export function reconcile(
  candidates: readonly Finding[],
  previous: Previous,
  diff: DiffStanding,
): Reconciled[] {
  const out: Reconciled[] = [];
  const active = previous.findings.filter((old) => !old.wasResolved);
  const resolved = previous.findings.filter((old) => old.wasResolved);
  const matched = new Set<string>();
  const doesNotStand = (old: PreviousFinding): boolean => {
    const lines = diff.files.get(old.path);
    if (lines === undefined) return true; // the file left the pull request
    if (lines === null) return true; // skipped this run: no line proof, the review scope moved on
    return old.line !== null && !lines.has(old.line);
  };

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
    const fp = findingFingerprint(old);
    if (matched.has(fp)) continue;
    if (doesNotStand(old)) {
      out.push({ finding: old, status: "resolved" });
      continue;
    }
    // The evidence for the claim still stands — the model simply did not
    // re-cite it. Carry it forward unchanged rather than call a diff-move
    // that no diff made: `persists` keeps the thread stable on a reread.
    out.push({ finding: old, status: "persists" });
  }

  return out;
}

/**
 * What the next run should remember: the findings this run will show, each
 * marked resolved when this run resolved it, plus the head SHAs reviewed.
 */
/** How many resolved findings the payload keeps, so the memory has a bounded tail. */
const MAX_REMEMBERED_RESOLVED = 8;

export function remember(
  reconciled: readonly Reconciled[],
  headSha: string,
  previous: Previous,
): Previous {
  const seen = new Set<string>();
  const findings: PreviousFinding[] = [];
  for (const entry of reconciled) {
    if (entry.status === "resolved") {
      // The SHA this review resolved the finding at — the status claim names
      // the diff it is evidence of, so a later reader knows what moved.
      findings.push({ ...entry.finding, wasResolved: true, resolvedAtSha: headSha });
      seen.add(findingFingerprint(entry.finding));
      continue;
    }
    findings.push({ ...entry.finding, wasResolved: false });
    seen.add(findingFingerprint(entry.finding));
  }
  // Findings resolved in an earlier run but still in the payload stay there,
  // so `reopened` keeps a memory to work against — capped so the payload does
  // not grow without bound on a long-lived pull request that resolves many
  // findings. The newest resolved findings are kept first; the oldest roll off
  // and a reintroduction of one reads as `created`, which is the honest frame
  // for a claim the payload no longer remembers resolving.
  let keptResolved = 0;
  for (const old of previous.findings) {
    const fp = findingFingerprint(old);
    if (old.wasResolved && !seen.has(fp) && keptResolved < MAX_REMEMBERED_RESOLVED) {
      findings.push(old);
      seen.add(fp);
      keptResolved += 1;
    }
  }
  const shas = previous.reviewedShas.includes(headSha)
    ? previous.reviewedShas
    : [...previous.reviewedShas, headSha].slice(-8);
  return { findings, reviewedShas: shas };
}
