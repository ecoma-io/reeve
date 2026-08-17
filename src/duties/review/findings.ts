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
import type { Evidence, VerificationStatus } from "./evidence.js";

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
  /** The exact text the model claimed at `line`, when a model wrote the finding — "" for deterministic findings. */
  readonly snippet?: string;
  /** Whether deterministic evidence proved this finding, set by the verification engine. */
  readonly verification?: VerificationStatus;
  /** The evidence the verification ran on, set by the verification engine. */
  readonly evidence?: readonly Evidence[];
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
 * A maintainer's triage of a finding, attributed on the thread.
 *
 * This is the human-disposition axis, deliberately orthogonal to the evidence
 * ladder. `resolved` is what the diff evidence says; a disposition is what a
 * maintainer said about a finding. The four values are judgment calls a
 * maintainer can stand behind next to the finding itself: the claim is
 * substantiated (`verified`), worth accepting as a risk (`accepted-risk`), a
 * deliberate no-fix (`wont-fix`), or wrong (`rejected`).
 */
export type DispositionValue = "verified" | "accepted-risk" | "wont-fix" | "rejected";

/** One attributed disposition, as a maintainer's eligible reply on the owned thread records it. */
export interface Disposition {
  readonly value: DispositionValue;
  /** The login of the maintainer who triaged the finding. */
  readonly by: string;
  /** The reply's `created_at`, ISO — when the triage was made. */
  readonly at: string;
  /** The thread reply that carries the disposition — the durable home. */
  readonly replyId: number;
  readonly replyUrl: string;
}

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
 *
 * `disposition` is the human-disposition axis riding on the finding: `null`
 * until a maintainer triaged it, then the attributed reply that did. A
 * disposition survives synchronize, force push, line movement and comment
 * replacement — it is keyed to the finding's *intention* (`ruleId` + `path`),
 * not its mutable evidence.
 */
export interface PreviousFinding extends Finding {
  readonly wasResolved: boolean;
  /**
   * The head SHA the review resolved this finding at — ties the status claim to a real change.
   */
  readonly resolvedAtSha?: string;
  /** The maintainer's triage of this finding, or null when nobody eligible has spoken. */
  readonly disposition: Disposition | null;
}

/**
 * What the previous run left in the owned comment's fingerprint payload.
 *
 * `version` and `checksum` are what make corruption LOUD rather than a silent
 * cold start: every envelope this code writes carries the schema version and a
 * digest over its own canonical findings and SHAs, and a payload that fails the
 * digest is read as `corrupt`, never as an empty memory.
 */
export interface Previous {
  readonly findings: readonly PreviousFinding[];
  /** Every head SHA this thread has been reviewed against, oldest first. */
  readonly reviewedShas: readonly string[];
  /** The envelope schema version this payload declares — always 2 when `remember` wrote it. */
  readonly version?: 2;
  /** Digest over findings + dispositions + SHAs; verifies a payload was ours and whole. */
  readonly checksum?: string;
}

/** A candidate the model (or the preflight) produced, plus what the run decided became of it. */
export interface Reconciled {
  readonly finding: Finding;
  readonly status: Status;
  /** The maintainer's triage overlay, or null when nobody eligible has spoken. */
  readonly disposition: Disposition | null;
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
 * - a candidate with no position match but a match against an ACTIVE previous
 *   finding by intention (rule + file) is `changed` too — the claim moved to a
 *   new line rather than dying and being reborn, so it carries the old
 *   finding's disposition instead of starting over;
 * - a candidate matching (by intention) a finding the previous run marked
 *   `resolved` is `reopened` — the claim is back, so the thread re-opens it;
 * - everything else is `created`.
 *
 * Every previously-active finding this run has no evidence for *and whose
 * position the diff no longer proves* becomes `resolved`: the code changed and
 * the claim did not survive the change. The comment renders it under a
 * "Resolved" heading (it stays part of the thread's history), and the payload
 * keeps it, marked resolved, so a reintroduction is later told apart from a
 * newborn claim. A disposition is keyed to intention, so it survives every
 * status move: `changed` (line movement), `resolved`, and `reopened` all carry
 * the old finding's disposition with them.
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
        out.push({ finding: candidate, status: "persists", disposition: atPosition.disposition });
      } else {
        out.push({ finding: candidate, status: "changed", disposition: atPosition.disposition });
      }
      continue;
    }
    // The claim moved: no position match, but an ACTIVE previous finding with
    // the same intention (rule + file) exists. This is line movement, not a
    // newborn claim — `changed`, and it carries the old disposition (see the
    // reconcile module doc). Only one active intention may claim the candidate,
    // or the match is ambiguous and the candidate reads as new.
    const activeByIntention = active.filter((old) => sameIntention(old, candidate));
    const activeOld = activeByIntention[0];
    if (activeByIntention.length === 1 && activeOld !== undefined) {
      matched.add(findingFingerprint(activeOld));
      out.push({ finding: candidate, status: "changed", disposition: activeOld.disposition });
      continue;
    }
    const previouslyResolved = resolved.find((old) => sameIntention(old, candidate));
    if (previouslyResolved !== undefined) {
      matched.add(findingFingerprint(previouslyResolved));
      out.push({
        finding: candidate,
        status: "reopened",
        disposition: previouslyResolved.disposition,
      });
      continue;
    }
    out.push({ finding: candidate, status: "created", disposition: null });
  }

  for (const old of active) {
    const fp = findingFingerprint(old);
    if (matched.has(fp)) continue;
    if (doesNotStand(old)) {
      out.push({ finding: old, status: "resolved", disposition: old.disposition });
      continue;
    }
    // The evidence for the claim still stands — the model simply did not
    // re-cite it. Carry it forward unchanged rather than call a diff-move
    // that no diff made: `persists` keeps the thread stable on a reread.
    out.push({ finding: old, status: "persists", disposition: old.disposition });
  }

  return out;
}

/**
 * The digest that makes a corrupted envelope LOUD.
 *
 * Every envelope `remember` writes carries this checksum, and `decodeEnvelope`
 * recomputes it over the payload it reads. A payload whose digest does not
 * match is not "an empty memory" — it is damage, and it is reported as such
 * rather than silently cold-started past. The digest covers the canonical
 * findings (fingerprint, resolved flag, resolving SHA and disposition) and the
 * reviewed SHAs, so any alteration — a flipped resolved flag, a forged
 * disposition, a truncated finding — fails the recomputation.
 */
export function envelopeChecksum(previous: Previous): string {
  const findings = previous.findings
    .map((entry) => {
      const d = entry.disposition;
      return [
        findingFingerprint(entry),
        entry.wasResolved ? "resolved" : "active",
        entry.resolvedAtSha ?? "",
        d === null ? "" : `${d.value}:${d.by}:${String(d.replyId)}`,
      ].join("|");
    })
    .join("\n");
  return fingerprint(`findings\n${findings}\nreviewedShas\n${previous.reviewedShas.join("\n")}`, [
    "review",
    "envelope",
  ]);
}

/**
 * The envelope's byte ceiling before compaction kicks in.
 *
 * GitHub's comment limit is 65,536 bytes and the comment carries the marker,
 * the rendered review and the envelope, so the envelope alone is budgeted
 * well below that — ~60,000 bytes. A payload that cannot be compacted back
 * under it is thrown, loud, rather than silently truncated (D5).
 */
const ENVELOPE_BYTES = 60_000;

function envelopeBytes(next: Previous): number {
  return Buffer.byteLength(
    JSON.stringify({ ...next, version: 2, checksum: envelopeChecksum(next) }),
    "utf8",
  );
}

/**
 * How many resolved findings without a disposition the payload keeps, so the
 * memory has a bounded tail on a long-lived pull request. Resolved findings
 * WITH a disposition are exempt — a maintainer's triage never rolls off (D3).
 */
const MAX_REMEMBERED_RESOLVED = 8;

/**
 * What the next run should remember: the findings this run will show, each
 * marked resolved when this run resolved it, plus the head SHAs reviewed.
 *
 * **The envelope is bounded.** GitHub's comment ceiling is the real bound, and
 * the compaction order below keeps the payload under it without ever losing a
 * maintainer's word (D3):
 *
 * 1. reviewed SHAs beyond the most recent one are evicted;
 * 2. resolved findings *without* a disposition are evicted (the resolved tail
 *    is machine memory — the old cap still applies with no dispositions to
 *    protect);
 * 3. resolved findings *with* a disposition are NEVER evicted — a maintainer's
 *    triage never rolls off the memory, because a reintroduced claim that
 *    carries it must not be handed back to the maintainer to say again.
 *
 * If evicting all machine memory still leaves the envelope over the ceiling,
 * `remember` throws, naming the overflow — a payload that cannot be bounded is
 * corruption-shaped, and a corruption is reported loudly (D5), never silently
 * trimmed.
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
      // The SHA this review resolved the finding at — the status claim names
      // the diff it is evidence of, so a later reader knows what moved.
      findings.push({
        ...entry.finding,
        wasResolved: true,
        resolvedAtSha: headSha,
        disposition: entry.disposition,
      });
      seen.add(findingFingerprint(entry.finding));
      continue;
    }
    findings.push({ ...entry.finding, wasResolved: false, disposition: entry.disposition });
    seen.add(findingFingerprint(entry.finding));
  }
  // Findings resolved in an earlier run but still in the payload stay there,
  // so `reopened` keeps a memory to work against. The cap that follows bounds
  // only resolved findings WITHOUT a disposition: resolved findings WITH a
  // disposition are exempt, because a maintainer's triage is the one thing in
  // the payload that never rolls off (D3). A reintroduction of an evicted
  // claim reads as `created`, which is the honest frame for a claim the
  // payload no longer remembers resolving.
  let keptResolved = 0;
  for (const old of previous.findings) {
    const fp = findingFingerprint(old);
    if (
      old.wasResolved &&
      !seen.has(fp) &&
      old.disposition === null &&
      keptResolved < MAX_REMEMBERED_RESOLVED
    ) {
      findings.push(old);
      seen.add(fp);
      keptResolved += 1;
    } else if (old.wasResolved && !seen.has(fp) && old.disposition !== null) {
      findings.push(old);
      seen.add(fp);
    }
  }
  const shas = previous.reviewedShas.includes(headSha)
    ? previous.reviewedShas
    : [...previous.reviewedShas, headSha].slice(-8);

  let next: Previous = { findings, reviewedShas: shas };
  if (envelopeBytes(next) <= ENVELOPE_BYTES) {
    return { ...next, version: 2, checksum: envelopeChecksum(next) };
  }

  // Compaction stage 1: the reviewed-SHA tail is machine memory — keep the
  // most recent SHA only.
  next = { findings, reviewedShas: shas.slice(-1) };
  if (envelopeBytes(next) <= ENVELOPE_BYTES) {
    return { ...next, version: 2, checksum: envelopeChecksum(next) };
  }

  // Compaction stage 2: evict resolved findings without a disposition, oldest
  // resolution first, until the payload fits. Resolved findings WITH a
  // disposition stay — see the module doc.
  const compacted: PreviousFinding[] = [];
  for (const entry of next.findings) {
    if (entry.wasResolved && entry.disposition === null) continue;
    compacted.push(entry);
  }
  next = { findings: compacted, reviewedShas: next.reviewedShas };
  if (envelopeBytes(next) > ENVELOPE_BYTES) {
    throw new Error(
      `review: the envelope cannot fit the comment ceiling — ${String(envelopeBytes(next))} bytes ` +
        "after evicting every evictable SHA and resolved finding, with all maintained " +
        "dispositions kept. A comment this large cannot be bounded, so it fails loud instead of " +
        "being silently trimmed.",
    );
  }
  return { ...next, version: 2, checksum: envelopeChecksum(next) };
}
