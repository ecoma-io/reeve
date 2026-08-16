import { describe, expect, it } from "vitest";

import {
  findingFingerprint,
  reconcile,
  remember,
  sameIntention,
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
    const out = reconcile([finding()], previous());
    expect(out).toEqual([{ finding: finding(), status: "created" }]);
  });

  it("keeps an unchanged same-position finding `persists`", () => {
    const old = previousFinding({}, false);
    const out = reconcile([finding()], previous({ findings: [old] }));
    expect(out[0]).toMatchObject({ status: "persists" });
  });

  it("marks a same-position finding with new text `changed`", () => {
    const old = previousFinding({}, false);
    const out = reconcile([finding({ body: "New text." })], previous({ findings: [old] }));
    expect(out[0]).toMatchObject({ status: "changed" });
  });

  it("reopens a finding whose intention a previously-resolved memory matches", () => {
    const old = previousFinding({}, true);
    const out = reconcile([finding()], previous({ findings: [old] }));
    expect(out[0]).toMatchObject({ status: "reopened" });
  });

  it("never collapses a same-position claim into `created`", () => {
    const old = previousFinding({}, false);
    const statuses = reconcile([finding({ body: "New text." })], previous({ findings: [old] })).map(
      ({ status }) => status,
    );
    expect(statuses).toContain("changed");
    expect(statuses).not.toContain("created");
  });

  it("resolves every previously-active finding this run has no evidence for", () => {
    const lost = previousFinding({ id: "lost", ruleId: "nope" }, false);
    const moved = previousFinding({ id: "moved", path: "gone.ts" }, false);
    const out = reconcile([finding()], previous({ findings: [lost, moved] }));
    expect(out.map(({ status }) => status).sort()).toEqual(["created", "resolved", "resolved"]);
  });

  it("deduplicates matched candidates against the same old finding once", () => {
    const out = reconcile([], previous());
    // Empty candidates → every active old finding resolves.
    const old = previousFinding({}, false);
    const res = reconcile([], previous({ findings: [old] }));
    expect(res).toEqual([{ finding: old, status: "resolved" }]);
    expect(out).toEqual([]);
  });
});

describe("remember", () => {
  it("marks resolved findings and keeps previously-resolved memory", () => {
    const resolved = previousFinding({}, false);
    const reconciled = [{ finding: resolved, status: "resolved" as const }];
    const next = remember(reconciled, "head2", previous({ findings: [resolved] }));
    expect(next.findings[0]?.wasResolved).toBe(true);
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
