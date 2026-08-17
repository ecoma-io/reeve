/**
 * The pure derivation unit: standings mapping, determinism, and the
 * actionable set.
 */
import { describe, expect, it } from "vitest";

import type { Envelope, Finding } from "./envelope.js";
import { proposeAll, standingsOf } from "./proposal.js";

/** A finding in review's own shape, with everything remediation reads. */
function finding(over: Partial<Finding> & { ruleId: string; path: string }): Finding {
  const { ruleId, path, line } = over;
  return {
    id: `${ruleId}:${path}:${String(line ?? 0)}`,
    ruleName: "Named rule",
    ruleBody: "The rule's intent, written out.",
    line: line ?? null,
    severity: "warning",
    body: "The finding body.",
    marker: "",
    ...over,
  };
}

/** The previous record the envelope carries. */
function previous(
  old: Partial<Envelope["previous"][number]> & { ruleId: string; path: string },
): Envelope["previous"][number] {
  const { ruleId, path, line } = old;
  return {
    id: `${ruleId}:${path}:${String(line ?? 0)}`,
    ruleName: "Named rule",
    ruleBody: "The rule's intent, written out.",
    line: line ?? null,
    severity: "warning",
    body: "The finding body.",
    marker: "",
    wasResolved: false,
    ...old,
  };
}

describe("standingsOf", () => {
  it("marks a finding that matches a live previous one as persists", () => {
    const current = finding({ ruleId: "d", path: "src/a.ts", line: 1, body: "Same claim." });
    const old = previous({
      ruleId: "d",
      path: "src/a.ts",
      line: 1,
      body: "Same claim.",
      wasResolved: false,
    });
    expect(standingsOf([current], [old]).get(current.id)).toBe("persists");
  });

  it("marks a finding at a live position with a new fingerprint as changed", () => {
    // Same rule/path/line, different body: the code moved under the claim.
    const current = finding({ ruleId: "d", path: "src/a.ts", line: 1, body: "The claim moved." });
    const old = previous({
      ruleId: "d",
      path: "src/a.ts",
      line: 1,
      body: "The claim as it was.",
      wasResolved: false,
    });
    expect(standingsOf([current], [old]).get(current.id)).toBe("changed");
  });

  it("marks a finding whose rule and path match a resolved previous one as reopened", () => {
    const current = finding({ ruleId: "d", path: "src/a.ts", line: 1, body: "The claim is back." });
    const old = previous({
      ruleId: "d",
      path: "src/a.ts",
      line: 1,
      body: "The claim as it was.",
      wasResolved: true,
    });
    expect(standingsOf([current], [old]).get(current.id)).toBe("reopened");
  });

  it("marks everything else as created", () => {
    const current = finding({ ruleId: "d", path: "src/a.ts" });
    expect(standingsOf([current], []).get(current.id)).toBe("created");
    // A resolved previous entry for a *different* rule is no evidence.
    const old = previous({ ruleId: "e", path: "src/a.ts", wasResolved: true });
    expect(standingsOf([current], [old]).get(current.id)).toBe("created");
  });
});

describe("proposeAll", () => {
  it("derives one deterministic proposal per actionable finding, in envelope order", () => {
    const persisted = finding({ ruleId: "d", path: "src/a.ts", line: 4, body: "Standing claim." });
    const created = finding({ ruleId: "g", path: "src/b.ts", line: 9, body: "New claim." });
    const changed = finding({ ruleId: "k", path: "src/d.ts", body: "Moved-on claim." });

    const envelope: Envelope = {
      // `findings` is the not-resolved subset; `resolved` and `changed` are
      // deliberately absent from it the way review's payload would carry them —
      // a finding is in `findings` because the review left it standing.
      findings: [persisted, created, changed],
      previous: [
        previous({ ruleId: "d", path: "src/a.ts", line: 4, body: "Standing claim." }),
        previous({ ruleId: "r", path: "src/c.ts", body: "Resolved claim.", wasResolved: true }),
        previous({ ruleId: "k", path: "src/d.ts", body: "Changed claim." }),
      ],
    };

    const proposals = proposeAll(envelope);
    expect(proposals).toHaveLength(2);
    // The standing follows the envelope: the carried-over claim is `persists`,
    // the new claim is `created`, and the moved-on claim is excluded.
    expect(proposals[0]?.standing).toBe("persists");
    expect(proposals[1]?.standing).toBe("created");
  });

  it("excludes a finding the review marked resolved — the diff already moved past it", () => {
    // `findings` is empty: review's own `remember` only puts standing findings
    // in the not-resolved half this duty reads as its input. A resolved
    // previous entry is memory, not an actionable input.
    const envelope: Envelope = {
      findings: [],
      previous: [previous({ ruleId: "d", path: "src/a.ts", wasResolved: true })],
    };
    expect(proposeAll(envelope)).toEqual([]);
  });

  it("excludes a changed finding — its body is stale evidence the code moved under", () => {
    const changed = finding({ ruleId: "d", path: "src/a.ts", line: 1, body: "The claim moved." });
    const envelope: Envelope = {
      findings: [changed],
      previous: [
        previous({
          ruleId: "d",
          path: "src/a.ts",
          line: 1,
          body: "The claim as it was.",
          wasResolved: false,
        }),
      ],
    };
    expect(proposeAll(envelope)).toEqual([]);
  });

  it("produces byte-identical records (and fingerprints) for the same envelope", () => {
    const a = finding({ ruleId: "d", path: "src/a.ts", line: 4, body: "Same claim." });
    const envelope: Envelope = {
      findings: [a],
      previous: [],
    };
    const first = proposeAll(envelope);
    const second = proposeAll(envelope);
    expect(first).toEqual(second);
    expect(first[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("carries the finding's own words and a deterministic remediation text", () => {
    const a = finding({
      ruleId: "blocked",
      ruleName: "Blocked text",
      ruleBody: "Debugger statements must not land.",
      path: "src/app.ts",
      line: 13,
      body: "debugger; statement on line 13.",
    });
    const envelope: Envelope = { findings: [a], previous: [] };
    const proposal = proposeAll(envelope)[0];

    expect(proposal).toMatchObject({
      findingId: "blocked:src/app.ts:13",
      ruleId: "blocked",
      path: "src/app.ts",
      line: 13,
      findingBody: "debugger; statement on line 13.",
      standing: "created",
    });
    expect(proposal?.remediation).toContain("`blocked` (Blocked text) reports src/app.ts:13");
    expect(proposal?.remediation).toContain("Debugger statements must not land.");
    expect(proposal?.remediation).toContain("debugger; statement on line 13.");
  });

  it("renders a file-level finding's where without a line", () => {
    const a = finding({ ruleId: "d", path: "src/whole.ts", line: null });
    const envelope: Envelope = { findings: [a], previous: [] };
    const proposal = proposeAll(envelope)[0];
    expect(proposal?.findingId).toBe("d:src/whole.ts:0");
    expect(proposal?.remediation).toContain("reports src/whole.ts.");
  });
});
