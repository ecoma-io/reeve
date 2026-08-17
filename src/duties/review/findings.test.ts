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
  return { ...finding(overrides), wasResolved };
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
    expect(out).toEqual([{ finding: finding(), status: "created" }]);
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
      { finding: finding(), status: "created" },
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
    expect(out[0]).toEqual({ finding: verified, status: "created" });
  });

  it("carries a stale active finding forward as `persists` when its position still stands", () => {
    // Same diff reread, model omitted the finding: the position still exists,
    // so the review must not report a resolution the diff did not earn.
    const old = previousFinding({}, false);
    const out = reconcile([], previous({ findings: [old] }), standing());
    expect(out).toEqual([{ finding: old, status: "persists" }]);
  });

  it("resolves a stale active finding on a checked-away file the diff no longer proves", () => {
    const old = previousFinding({ id: "gone", path: "gone.ts", line: 12 }, false);
    const out = reconcile([], previous({ findings: [old] }), standing());
    expect(out).toEqual([{ finding: old, status: "resolved" }]);
  });

  it("deduplicates matched candidates against the same old finding once", () => {
    const out = reconcile([], previous(), standing());
    // Empty candidates with no standing → the position still stands, so
    // nothing resolves and nothing churns.
    const old = previousFinding({}, false);
    const res = reconcile([], previous({ findings: [old] }), standing());
    expect(res).toEqual([{ finding: old, status: "persists" }]);
    expect(out).toEqual([]);
  });
});

describe("remember", () => {
  it("marks resolved findings, ties them to the resolving SHA, and keeps previously-resolved memory", () => {
    const resolved = previousFinding({}, false);
    const reconciled = [{ finding: resolved, status: "resolved" as const }];
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
});
