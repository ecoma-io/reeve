import { describe, expect, it } from "vitest";

import {
  findingFingerprint,
  reconcile,
  remember,
  sameIntention,
  type DiffStanding,
  type Finding,
  type Previous,
} from "./findings.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "id",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "a.ts",
    line: 12,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    ...overrides,
  };
}

function previous(overrides: Partial<Previous> = {}): Previous {
  return { findings: [], reviewedShas: ["old1"], ...overrides };
}

/** A diff standing where `a.ts` is shown at line 12 and `gone.ts` left the PR. */
function standing(overrides: Partial<DiffStanding> = {}): DiffStanding {
  return {
    files: new Map([
      ["a.ts", new Set([12])],
      ["gone.ts", null],
    ]),
    headSha: "head2",
    ...overrides,
  };
}

function previousFinding(
  overrides: Partial<Finding> = {},
  wasResolved = false,
): Previous["findings"][number] {
  return { ...finding(overrides), wasResolved, disposition: null };
}

function withDisposition(
  entry: Previous["findings"][number],
  disposition: NonNullable<Previous["findings"][number]["disposition"]>,
): Previous["findings"][number] {
  return { ...entry, disposition };
}

describe("findingFingerprint", () => {
  it("is stable for the same claim at the same place", () => {
    expect(findingFingerprint(finding())).toBe(findingFingerprint(finding()));
  });

  it("changes when the body changes — the code moved under the claim", () => {
    expect(findingFingerprint(finding({ body: "A" }))).not.toBe(
      findingFingerprint(finding({ body: "B" })),
    );
  });

  it("changes when the position changes", () => {
    expect(findingFingerprint(finding({ line: 1 }))).not.toBe(
      findingFingerprint(finding({ line: 2 })),
    );
  });

  it("is unchanged when verification flips — D9's stays-unchanged rerun", () => {
    // Verification is recomputed per run, never part of the identity: a rerun
    // of untouched code keeps `persists` and the comment stays `unchanged`
    // even though this run's evidence verdict differed.
    expect(findingFingerprint(finding({ verification: "verified" }))).toBe(
      findingFingerprint(finding({ verification: "unverified" })),
    );
    expect(findingFingerprint(finding({ evidence: [] }))).toBe(findingFingerprint(finding()));
  });
});

describe("sameIntention", () => {
  it("is the rule and the file, not the line", () => {
    expect(sameIntention(finding({ line: 1 }), finding({ line: 99 }))).toBe(true);
    expect(sameIntention(finding({ ruleId: "a" }), finding({ ruleId: "b" }))).toBe(false);
    expect(sameIntention(finding({ path: "a.ts" }), finding({ path: "b.ts" }))).toBe(false);
  });
});

describe("reconcile", () => {
  it("makes a newborn finding `created` against an empty memory", () => {
    const out = reconcile([finding()], previous(), standing());
    expect(out).toEqual([{ finding: finding(), status: "created", disposition: null }]);
  });

  it("keeps an unchanged same-position finding `persists`", () => {
    const old = previousFinding({}, false);
    const out = reconcile([finding()], previous({ findings: [old] }), standing());
    expect(out[0]).toMatchObject({ status: "persists" });
  });

  it("marks a same-position finding with new text `changed`", () => {
    const old = previousFinding({}, false);
    const out = reconcile(
      [finding({ body: "New text." })],
      previous({ findings: [old] }),
      standing(),
    );
    expect(out[0]).toMatchObject({ status: "changed" });
  });

  it("reopens a finding whose intention a previously-resolved memory matches", () => {
    const old = previousFinding({}, true);
    const out = reconcile([finding()], previous({ findings: [old] }), standing());
    expect(out[0]).toMatchObject({ status: "reopened" });
  });

  it("never collapses a same-position claim into `created`", () => {
    const old = previousFinding({}, false);
    const statuses = reconcile(
      [finding({ body: "New text." })],
      previous({ findings: [old] }),
      standing(),
    ).map(({ status }) => status);
    expect(statuses).toContain("changed");
    expect(statuses).not.toContain("created");
  });

  it("resolves an active finding whose file left the pull request", () => {
    const moved = previousFinding({ id: "moved", path: "gone.ts" }, false);
    const out = reconcile([finding()], previous({ findings: [moved] }), standing());
    expect(out).toEqual([
      { finding: finding(), status: "created", disposition: null },
      expect.objectContaining({ status: "resolved" }),
    ]);
  });

  it("resolves an active finding whose line the patch no longer proves", () => {
    const old = previousFinding({ line: 13 }, false);
    // The diff still shows a.ts, but only line 12 is proven now.
    const out = reconcile([], previous({ findings: [old] }), standing());
    expect(out).toEqual([expect.objectContaining({ status: "resolved" })]);
  });

  it("carries verification and evidence through reconcile as part of the finding", () => {
    const verified = finding({ verification: "verified" as const, evidence: [] });
    const out = reconcile([verified], previous(), standing());
    expect(out[0]).toEqual({ finding: verified, status: "created", disposition: null });
  });

  it("carries a stale active finding forward as `persists` when its position still stands", () => {
    // Same diff reread, model omitted the finding: the position still exists,
    // so the review must not report a resolution the diff did not earn.
    const old = previousFinding({}, false);
    const out = reconcile([], previous({ findings: [old] }), standing());
    expect(out).toEqual([{ finding: old, status: "persists", disposition: null }]);
  });

  it("resolves a stale active finding on a checked-away file the diff no longer proves", () => {
    const old = previousFinding({ id: "gone", path: "gone.ts", line: 12 }, false);
    const out = reconcile([], previous({ findings: [old] }), standing());
    expect(out).toEqual([{ finding: old, status: "resolved", disposition: null }]);
  });

  it("deduplicates matched candidates against the same old finding once", () => {
    const out = reconcile([], previous(), standing());
    // Empty candidates with no standing → the position still stands, so
    // nothing resolves and nothing churns.
    const old = previousFinding({}, false);
    const res = reconcile([], previous({ findings: [old] }), standing());
    expect(res).toEqual([{ finding: old, status: "persists", disposition: null }]);
    expect(out).toEqual([]);
  });

  it("marks a candidate whose line moved `changed`, carrying the old finding's disposition", () => {
    // The claim moved from line 12 to line 99 in the same rule and file: no
    // position match, but the intention (rule + path) matches an ACTIVE
    // previous finding — so it is `changed`, never a newborn `created`, and the
    // maintainer's triage rides it to the new line.
    const disposition = {
      value: "wont-fix" as const,
      by: "octocat",
      at: "2026-08-17T00:00:00Z",
      replyId: 9,
      replyUrl: "https://github.com/o/r/pull/1#issuecomment-9",
    };
    const old = withDisposition(
      previousFinding({ line: 12, body: "Old text." }, false),
      disposition,
    );
    const out = reconcile(
      [finding({ line: 99, body: "New text at a new line." })],
      previous({ findings: [old] }),
      standing(),
    );
    expect(out).toEqual([
      {
        finding: finding({ line: 99, body: "New text at a new line." }),
        status: "changed",
        disposition,
      },
    ]);
  });

  it("does not call a moved claim `created` when the same intention is active elsewhere", () => {
    const old = previousFinding({ line: 12, body: "Old text." }, false);
    const out = reconcile(
      [finding({ line: 99, body: "New text at a new line." })],
      previous({ findings: [old] }),
      standing(),
    );
    expect(out[0]?.status).toBe("changed");
    expect(out[0]?.status).not.toBe("created");
  });

  it("treats a moved claim as `created` when two active findings share the intention — ambiguous", () => {
    const first = previousFinding({ id: "a", line: 12, body: "A." }, false);
    const second = previousFinding({ id: "b", line: 13, body: "B." }, false);
    const out = reconcile(
      [finding({ line: 99, body: "Where did this come from?" })],
      previous({ findings: [first, second] }),
      standing(),
    );
    expect(out[0]?.status).toBe("created");
  });

  it("carries the disposition when a previously-resolved finding is reopened", () => {
    const disposition = {
      value: "rejected" as const,
      by: "octocat",
      at: "2026-08-17T00:00:00Z",
      replyId: 9,
      replyUrl: "https://github.com/o/r/pull/1#issuecomment-9",
    };
    const old = withDisposition(previousFinding({}, true), disposition);
    const out = reconcile([finding()], previous({ findings: [old] }), standing());
    expect(out[0]).toMatchObject({ status: "reopened", disposition });
  });

  it("carries the disposition when a finding resolves", () => {
    const disposition = {
      value: "verified" as const,
      by: "octocat",
      at: "2026-08-17T00:00:00Z",
      replyId: 9,
      replyUrl: "https://github.com/o/r/pull/1#issuecomment-9",
    };
    const old = withDisposition(
      previousFinding({ id: "gone", path: "gone.ts", line: 12 }, false),
      disposition,
    );
    const out = reconcile([], previous({ findings: [old] }), standing());
    expect(out[0]).toMatchObject({ status: "resolved", disposition });
  });
});

describe("remember", () => {
  it("marks resolved findings, ties them to the resolving SHA, and keeps previously-resolved memory", () => {
    const resolved = previousFinding({}, false);
    const reconciled = [{ finding: resolved, status: "resolved" as const, disposition: null }];
    const next = remember(reconciled, "head2", previous({ findings: [resolved] }));
    expect(next.findings[0]?.wasResolved).toBe(true);
    expect(next.findings[0]?.resolvedAtSha).toBe("head2");
  });

  it("caps the resolved findings kept as memory", () => {
    const olds = Array.from({ length: 30 }, (_, i) =>
      previousFinding({ id: `r${String(i)}`, ruleId: `rule-${String(i)}` }, true),
    );
    const out = remember([], "head2", previous({ findings: olds }));
    const kept = out.findings.filter((f) => f.wasResolved);
    expect(kept).toHaveLength(8);
    // The payload keeps its order and the cap trims the tail, so the oldest
    // resolved findings survive and the newest resolution evidence rolls off —
    // a long-lived pull request's memory stays bounded.
    expect(kept[0]?.id).toBe("r0");
    expect(kept[7]?.id).toBe("r7");
  });

  it("appends the reviewed SHA, capped at eight", () => {
    const next = remember(
      [],
      "head9",
      previous({ findings: [], reviewedShas: ["1", "2", "3", "4", "5", "6", "7", "8"] }),
    );
    expect(next.reviewedShas).toHaveLength(8);
    expect(next.reviewedShas[7]).toBe("head9");
  });

  it("does not duplicate a SHA already reviewed", () => {
    const next = remember([], "old1", previous());
    expect(next.reviewedShas).toEqual(["old1"]);
  });

  it("never evicts a resolved finding that carries a disposition, past the eight-cap", () => {
    // A long-lived pull request resolves a finding a maintainer triaged. The
    // 8-cap applies only to resolved findings WITHOUT a disposition: the
    // triaged one must never roll off the memory (D3), because a reintroduced
    // claim that carries it must not be handed to the maintainer to say again.
    const withD = Array.from({ length: 12 }, (_, i) =>
      withDisposition(
        previousFinding({ id: `d${String(i)}`, ruleId: `rule-d${String(i)}` }, true),
        {
          value: "wont-fix" as const,
          by: "octocat",
          at: "2026-08-17T00:00:00Z",
          replyId: 9,
          replyUrl: "https://github.com/o/r/pull/1#issuecomment-9",
        },
      ),
    );
    const plain = Array.from({ length: 30 }, (_, i) =>
      previousFinding({ id: `p${String(i)}`, ruleId: `rule-p${String(i)}` }, true),
    );
    const out = remember([], "head2", previous({ findings: [...withD, ...plain] }));
    const kept = out.findings.filter((f) => f.wasResolved);
    // All 12 triaged resolutions survive; only 8 of the untriaged ones do.
    expect(kept.filter((f) => f.disposition !== null)).toHaveLength(12);
    expect(kept.filter((f) => f.disposition === null)).toHaveLength(8);
    expect(kept.some((f) => f.id === "d11")).toBe(true);
  });

  it("throws when the envelope cannot fit the comment ceiling even after compaction", () => {
    // A pathological memory: a resolved finding with a disposition cannot be
    // evicted, and one oversized disposition (a huge login) blows the budget
    // past what compaction can recover. The failure is loud — never a silent
    // trim (D5).
    const bloated = withDisposition(previousFinding({ id: "big", path: "huge.ts" }, true), {
      value: "wont-fix" as const,
      by: "x".repeat(70_000),
      at: "2026-08-17T00:00:00Z",
      replyId: 9,
      replyUrl: "https://github.com/o/r/pull/1#issuecomment-9",
    });
    expect(() =>
      remember([], "head2", previous({ findings: [bloated], reviewedShas: ["1"] })),
    ).toThrow(/cannot fit the comment ceiling/);
  });
});
