/**
 * The finding lifecycle end to end: creation, update, resolution, reopen, and
 * the three diff events that decide between them — a moved line, a deleted
 * line, a renamed file.
 *
 * `findings.test.ts` pins each rung against a hand-built memory. This file
 * drives the rungs in SEQUENCE — reconcile, remember, reconcile again against
 * what was remembered — because the bugs a lifecycle has are the ones that
 * only appear on the second or third run: a status that churns on a reread, a
 * disposition that falls off between runs, a fingerprint that moves when the
 * claim did not.
 */
import { describe, expect, it } from "vitest";

import {
  envelopeChecksum,
  findingFingerprint,
  reconcile,
  remember,
  sameIntention,
  type Disposition,
  type DiffStanding,
  type Finding,
  type Previous,
  type Reconciled,
} from "./findings.js";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "dedup:src/app.ts:10",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "src/app.ts",
    line: 10,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    ...overrides,
  };
}

/** A diff standing: `path -> proven lines`, or `null` for a skipped file. */
function standing(
  files: Readonly<Record<string, readonly number[] | null>>,
  headSha = SHA1,
): DiffStanding {
  return {
    files: new Map(
      Object.entries(files).map(([path, lines]) => [path, lines === null ? null : new Set(lines)]),
    ),
    headSha,
  };
}

const EMPTY: Previous = { findings: [], reviewedShas: [] };

const DISPOSITION: Disposition = {
  value: "accepted-risk",
  by: "maintainer",
  at: "2026-01-01T00:00:00Z",
  replyId: 5,
  replyUrl: "https://example.invalid/5",
};

/** The status a named path carries in a reconciliation, or undefined. */
const statusAt = (out: readonly Reconciled[], path: string): string | undefined =>
  out.find((entry) => entry.finding.path === path)?.status;

describe("one claim across a pull request's whole life", () => {
  it("created_then_persists_then_resolved_then_reopened_across_four_runs", () => {
    const claim = finding();
    const diff = standing({ "src/app.ts": [10] });

    // Run 1 — the claim is new.
    const run1 = reconcile([claim], EMPTY, diff);
    expect(run1[0]?.status).toBe("created");
    const memory1 = remember(run1, SHA1, EMPTY);

    // Run 2 — the same claim on the same diff. Not a second `created`, and
    // not a churn to `changed`: the review says the same thing it said.
    const run2 = reconcile([claim], memory1, diff);
    expect(run2[0]?.status).toBe("persists");
    const memory2 = remember(run2, SHA1, memory1);

    // Run 3 — the diff moved past line 10 and the model no longer cites it.
    const moved = standing({ "src/app.ts": [11, 12] }, SHA2);
    const run3 = reconcile([], memory2, moved);
    expect(run3[0]?.status).toBe("resolved");
    const memory3 = remember(run3, SHA2, memory2);
    expect(memory3.findings[0]).toMatchObject({ wasResolved: true, resolvedAtSha: SHA2 });

    // Run 4 — the claim comes back. It is a reopen, not a newborn: the thread
    // keeps the rung a human review would keep.
    const run4 = reconcile([claim], memory3, standing({ "src/app.ts": [10] }, SHA2));
    expect(run4[0]?.status).toBe("reopened");
  });

  it("a_rerun_on_the_same_diff_never_churns_a_status", () => {
    // The anti-nagging property: reconcile→remember→reconcile is a fixed point
    // for an unchanged diff and an unchanged model answer.
    const claim = finding();
    const diff = standing({ "src/app.ts": [10] });
    let memory = remember(reconcile([claim], EMPTY, diff), SHA1, EMPTY);
    for (let run = 0; run < 4; run += 1) {
      const out = reconcile([claim], memory, diff);
      expect(out.map((entry) => entry.status)).toEqual(["persists"]);
      memory = remember(out, SHA1, memory);
      expect(memory.findings).toHaveLength(1);
    }
  });

  it("a_claim_the_model_stopped_citing_while_its_line_still_stands_persists_not_resolves", () => {
    // Model omission is not evidence that code changed. Calling this
    // `resolved` would produce created→resolved→reopened churn on identical
    // synchronize events with zero code moved.
    const memory = remember(
      reconcile([finding()], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    const out = reconcile([], memory, standing({ "src/app.ts": [10] }));
    expect(out[0]?.status).toBe("persists");
  });
});

describe("the three diff events that decide a status", () => {
  it("moved_line_is_changed_and_keeps_the_claim_rather_than_killing_and_reborning_it", () => {
    const memory = remember(
      reconcile([finding({ line: 10 })], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    const out = reconcile([finding({ line: 42 })], memory, standing({ "src/app.ts": [42] }, SHA2));
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("changed");
  });

  it("deleted_line_resolves_the_claim_at_the_sha_the_deletion_landed_on", () => {
    const memory = remember(
      reconcile([finding({ line: 10 })], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    const out = reconcile([], memory, standing({ "src/app.ts": [11] }, SHA2));
    expect(out[0]?.status).toBe("resolved");
    expect(remember(out, SHA2, memory).findings[0]?.resolvedAtSha).toBe(SHA2);
  });

  it("renamed_file_resolves_the_old_path_and_creates_at_the_new_one", () => {
    // ADJUDICATE: intention is `ruleId + path`, so a rename is two events —
    // the claim at the old path resolves (its file left the pull request) and
    // the claim at the new path is `created`. A disposition keyed to the old
    // path therefore does NOT follow the file across a rename. Pinned as
    // current behaviour; carrying it would need a rename map reconcile does
    // not receive.
    const old = finding({ path: "src/old.ts", line: 10 });
    const memory = remember(reconcile([old], EMPTY, standing({ "src/old.ts": [10] })), SHA1, EMPTY);
    const renamed = finding({ path: "src/new.ts", line: 10 });
    const out = reconcile([renamed], memory, standing({ "src/new.ts": [10] }, SHA2));
    expect(statusAt(out, "src/new.ts")).toBe("created");
    expect(statusAt(out, "src/old.ts")).toBe("resolved");
    expect(sameIntention(old, renamed)).toBe(false);
  });

  it("a_file_the_rules_started_skipping_resolves_its_findings_rather_than_stranding_them", () => {
    // `null` in the standing means "shown last run, no line proof this run" —
    // the review's scope moved on, so the claim goes quiet instead of being
    // carried forward as if it were still being checked.
    const memory = remember(
      reconcile([finding()], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    const out = reconcile([], memory, standing({ "src/app.ts": null }, SHA2));
    expect(out[0]?.status).toBe("resolved");
  });

  it("a_whole_file_finding_survives_every_line_moving_under_it", () => {
    // A `line: null` claim is about the file, so no line the patch stopped
    // proving can resolve it — only the file leaving the pull request can.
    const whole = finding({ line: null });
    const memory = remember(
      reconcile([whole], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    expect(reconcile([], memory, standing({ "src/app.ts": [99] }, SHA2))[0]?.status).toBe(
      "persists",
    );
    expect(reconcile([], memory, standing({ "src/other.ts": [1] }, SHA2))[0]?.status).toBe(
      "resolved",
    );
  });
});

describe("a maintainer's word outlives every status move", () => {
  const withDisposition = (): Previous => {
    const first = reconcile([finding()], EMPTY, standing({ "src/app.ts": [10] }));
    const triaged = first.map((entry) => ({ ...entry, disposition: DISPOSITION }));
    return remember(triaged, SHA1, EMPTY);
  };

  it("a_disposition_rides_a_moved_claim_to_its_new_line", () => {
    const out = reconcile(
      [finding({ line: 42 })],
      withDisposition(),
      standing({ "src/app.ts": [42] }, SHA2),
    );
    expect(out[0]).toMatchObject({ status: "changed", disposition: DISPOSITION });
  });

  it("a_disposition_rides_a_claim_through_resolution_and_back_through_reopen", () => {
    const memory = withDisposition();
    const resolved = reconcile([], memory, standing({ "src/app.ts": [11] }, SHA2));
    expect(resolved[0]).toMatchObject({ status: "resolved", disposition: DISPOSITION });

    const afterResolve = remember(resolved, SHA2, memory);
    const reopened = reconcile([finding()], afterResolve, standing({ "src/app.ts": [10] }, SHA2));
    expect(reopened[0]).toMatchObject({ status: "reopened", disposition: DISPOSITION });
  });

  it("a_triaged_resolved_finding_is_never_evicted_by_the_memory_cap", () => {
    // The machine's own resolved tail rolls off at eight; a maintainer's word
    // does not roll off at all, because a reintroduced claim carrying it must
    // not be handed back to be said again.
    const triaged = remember(
      reconcile([finding({ path: "src/kept.ts" })], EMPTY, standing({ "src/kept.ts": [10] })).map(
        (entry) => ({ ...entry, disposition: DISPOSITION }),
      ),
      SHA1,
      EMPTY,
    );
    let memory = remember(
      reconcile([], triaged, standing({ "src/kept.ts": null }, SHA2)),
      SHA2,
      triaged,
    );
    // Twelve more resolutions, each with no disposition — well past the cap.
    for (let i = 0; i < 12; i += 1) {
      const path = `src/churn${String(i)}.ts`;
      const created = reconcile([finding({ path })], memory, standing({ [path]: [10] }, SHA2));
      memory = remember(created, SHA2, memory);
      memory = remember(reconcile([], memory, standing({ [path]: null }, SHA2)), SHA2, memory);
    }
    const kept = memory.findings.find((entry) => entry.path === "src/kept.ts");
    expect(kept?.disposition).toEqual(DISPOSITION);
    // The machine tail is bounded at EXACTLY the eight carried from the
    // previous payload plus the one this run itself resolved, however many
    // runs churned before it. Asserted as the exact number rather than as a
    // ceiling: a cap that drifted to ten would satisfy any `<= 12` and the
    // test would have nothing to say about it.
    const machineTail = memory.findings.filter(
      (entry) => entry.wasResolved && entry.disposition === null,
    );
    expect(machineTail).toHaveLength(9);
  });

  it("no_status_move_ever_invents_a_disposition_that_was_not_there", () => {
    // The fabrication test: reconcile has no confidence input and no way to
    // mint a maintainer's word. Every rung, from an undisposed memory, must
    // come back with `null`.
    const memory = remember(
      reconcile([finding()], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    const rungs = [
      reconcile([finding()], memory, standing({ "src/app.ts": [10] })),
      reconcile([finding({ line: 42 })], memory, standing({ "src/app.ts": [42] }, SHA2)),
      reconcile([], memory, standing({ "src/app.ts": [11] }, SHA2)),
      reconcile([finding({ path: "src/new.ts" })], memory, standing({ "src/new.ts": [10] }, SHA2)),
    ];
    for (const out of rungs) for (const entry of out) expect(entry.disposition).toBeNull();
  });
});

describe("fingerprint stability is what makes each rung correct", () => {
  it("the_same_claim_at_the_same_place_fingerprints_the_same_across_runs", () => {
    expect(findingFingerprint(finding())).toBe(findingFingerprint(finding()));
  });

  it("a_fingerprint_ignores_everything_a_rerun_recomputes", () => {
    // Verification status, evidence, the finding's own id and rule metadata
    // are all this-run values. Folding them in would make a rerun that proved
    // the same claim look like a different claim.
    expect(findingFingerprint(finding())).toBe(
      findingFingerprint(
        finding({
          id: "another-id",
          ruleName: "renamed",
          ruleBody: "reworded",
          severity: "critical",
          marker: "duplication",
          verification: "verified",
          evidence: [],
        }),
      ),
    );
  });

  it("a_fingerprint_moves_when_the_claim_text_the_place_or_the_rule_moves", () => {
    const base = findingFingerprint(finding());
    expect(findingFingerprint(finding({ body: "Different." }))).not.toBe(base);
    expect(findingFingerprint(finding({ line: 11 }))).not.toBe(base);
    expect(findingFingerprint(finding({ path: "src/other.ts" }))).not.toBe(base);
    expect(findingFingerprint(finding({ ruleId: "other" }))).not.toBe(base);
  });

  it("a_whole_file_claim_and_a_line_one_claim_never_share_a_fingerprint", () => {
    expect(findingFingerprint(finding({ line: null }))).not.toBe(
      findingFingerprint(finding({ line: 1 })),
    );
  });

  it("the_envelope_checksum_moves_with_every_field_it_is_meant_to_seal", () => {
    const base: Previous = {
      findings: [{ ...finding(), wasResolved: false, disposition: null }],
      reviewedShas: [SHA1],
    };
    const seal = envelopeChecksum(base);
    expect(envelopeChecksum({ ...base, reviewedShas: [SHA1, SHA2] })).not.toBe(seal);
    expect(
      envelopeChecksum({ ...base, findings: [{ ...base.findings[0]!, wasResolved: true }] }),
    ).not.toBe(seal);
    expect(
      envelopeChecksum({ ...base, findings: [{ ...base.findings[0]!, resolvedAtSha: SHA2 }] }),
    ).not.toBe(seal);
    expect(
      envelopeChecksum({ ...base, findings: [{ ...base.findings[0]!, disposition: DISPOSITION }] }),
    ).not.toBe(seal);
  });

  it("the_envelope_checksum_is_stable_for_an_unchanged_memory", () => {
    const memory = remember(
      reconcile([finding()], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    expect(envelopeChecksum(memory)).toBe(envelopeChecksum({ ...memory }));
  });
});

describe("duplicate claims in one run", () => {
  it("two_candidates_at_the_same_position_both_survive_and_neither_becomes_created_twice", () => {
    const memory = remember(
      reconcile([finding()], EMPTY, standing({ "src/app.ts": [10] })),
      SHA1,
      EMPTY,
    );
    const out = reconcile(
      [finding({ body: "One." }), finding({ body: "Two." })],
      memory,
      standing({ "src/app.ts": [10] }),
    );
    expect(out).toHaveLength(2);
    expect(out.every((entry) => entry.status === "changed")).toBe(true);
    // The old finding was matched, so it is not ALSO carried forward as a
    // third entry — the run reports two claims, not three.
    expect(out.filter((entry) => entry.status === "persists")).toEqual([]);
  });

  it("an_ambiguous_move_reads_as_created_rather_than_guessing_which_claim_moved", () => {
    const memory: Previous = {
      findings: [
        { ...finding({ line: 10 }), wasResolved: false, disposition: null },
        { ...finding({ line: 20 }), wasResolved: false, disposition: null },
      ],
      reviewedShas: [SHA1],
    };
    const out = reconcile(
      [finding({ line: 30 })],
      memory,
      standing({ "src/app.ts": [10, 20, 30] }),
    );
    expect(statusAt(out, "src/app.ts")).toBe("created");
    // Neither old claim was consumed by the guess: both still stand.
    expect(out.filter((entry) => entry.status === "persists")).toHaveLength(2);
  });

  it("dedup_is_stable_across_reruns_the_memory_never_grows_on_an_unchanged_diff", () => {
    // The property that actually protects a long-lived pull request: running
    // the same review ten times against the same diff must leave exactly the
    // memory one run leaves. A payload that grew by one row per synchronize
    // event would hit the envelope ceiling and fail the run.
    const claims = [finding({ line: 10 }), finding({ line: 20, body: "Also repeated." })];
    const diff = standing({ "src/app.ts": [10, 20] });
    let memory = remember(reconcile(claims, EMPTY, diff), SHA1, EMPTY);
    const first = memory.findings.map((entry) => findingFingerprint(entry)).sort();
    for (let run = 0; run < 10; run += 1) {
      memory = remember(reconcile(claims, memory, diff), SHA1, memory);
      expect(memory.findings.map((entry) => findingFingerprint(entry)).sort()).toEqual(first);
      expect(memory.reviewedShas).toEqual([SHA1]);
    }
  });
});

describe("two architecture breaches in one file stay two claims", () => {
  // The regression this pins: architecture findings once all carried the id
  // `review-arch`, so `(ruleId, path)` — the pair a disposition is keyed to and
  // the pair `sameIntention` compares — collapsed every breach in a file into
  // one intention. A second breach of a different rule then reconciled as the
  // first one having MOVED, and inherited the `wont-fix` a maintainer had
  // granted the first.
  const accepted: Disposition = {
    value: "wont-fix",
    by: "maintainer",
    at: "2026-01-01T00:00:00Z",
    replyId: 1,
    replyUrl: "https://github.com/o/r/pull/1#issuecomment-1",
  };

  const breach = (ruleIndex: number, line: number): Finding =>
    finding({
      id: `review-arch:${String(ruleIndex)}:src/app.ts:${String(line)}`,
      ruleId: `review-arch:${String(ruleIndex)}`,
      ruleName: "Architecture boundary",
      line,
      body: `breach of rule ${String(ruleIndex)}`,
      marker: "preflight:arch",
    });

  it("does not read a breach of another rule as the accepted one having moved", () => {
    const previous: Previous = {
      findings: [{ ...breach(0, 3), wasResolved: false, disposition: accepted }],
      reviewedShas: [SHA1],
    };
    const diff: DiffStanding = {
      files: new Map([["src/app.ts", new Set([3, 9])]]),
      headSha: SHA2,
    };

    const out = reconcile([breach(0, 3), breach(1, 9)], previous, diff);
    const newcomer = out.find((entry) => entry.finding.line === 9);

    expect(newcomer?.status).toBe("created");
    expect(newcomer?.disposition).toBeNull();
  });

  it("keeps the accepted breach accepted while the new one stands on its own", () => {
    const previous: Previous = {
      findings: [{ ...breach(0, 3), wasResolved: false, disposition: accepted }],
      reviewedShas: [SHA1],
    };
    const diff: DiffStanding = {
      files: new Map([["src/app.ts", new Set([3, 9])]]),
      headSha: SHA2,
    };

    const out = reconcile([breach(0, 3), breach(1, 9)], previous, diff);

    expect(out.find((entry) => entry.finding.line === 3)?.disposition).toEqual(accepted);
  });

  it("treats two breaches of two rules as two intentions", () => {
    expect(sameIntention(breach(0, 3), breach(1, 3))).toBe(false);
  });
});
