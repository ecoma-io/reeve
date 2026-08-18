import * as core from "@actions/core";
import { describe, expect, it, vi } from "vitest";

import { page, report } from "./report.js";
import type { RemediationProposal } from "./proposal.js";

// The one effect `report` reaches for — `setOutput` — is replaced, the same
// way `core/publish.test.ts` replaces `warning`. `page` is pure and needs no
// mock at all.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  setOutput: vi.fn(),
}));

function proposal(overrides: Partial<RemediationProposal> = {}): RemediationProposal {
  return {
    fingerprint: "f000",
    findingId: "diff-evidence:src/app.ts:12",
    ruleId: "diff-evidence",
    ruleName: "Diff evidence",
    severity: "warning",
    path: "src/app.ts",
    line: 12,
    findingBody: "Missing evidence.",
    standing: "created",
    remediation: "Add the evidence at src/app.ts:12.",
    ...overrides,
  };
}

describe("report", () => {
  it("writes the three outputs on every path, including the nothing-derived one", () => {
    const setOutput = vi.mocked(core.setOutput);
    report([], "");
    expect(setOutput).toHaveBeenCalledWith("proposed", "false");
    expect(setOutput).toHaveBeenCalledWith("proposals", "0");
    expect(setOutput).toHaveBeenCalledWith("note", "");

    report([proposal()], "one proposal");
    expect(setOutput).toHaveBeenCalledWith("proposed", "true");
    expect(setOutput).toHaveBeenCalledWith("proposals", "1");
    expect(setOutput).toHaveBeenCalledWith("note", "one proposal");
  });
});

describe("page", () => {
  it("reports the nothing-derived run without a table", () => {
    const summary = page([], "");
    expect(summary).toContain("## Remediation");
    expect(summary).toContain("No remediation proposals were derived this run.");
  });

  it("carries the note into the nothing-derived line when there is one", () => {
    expect(page([], "the envelope was unreadable")).toContain(
      "No remediation proposals were derived this run. the envelope was unreadable",
    );
  });

  it("renders one row per proposal, with the line anchored into the where cell", () => {
    const summary = page([proposal()], "", false);
    expect(summary).toContain("src/app.ts:12");
    expect(summary).toContain("diff-evidence:src/app.ts:12");
    expect(summary).toContain("Add the evidence at src/app.ts:12.");
    // The boundary footer: nothing was written.
    expect(summary).toContain("nothing was written to the repository");
  });

  it("renders the file-only where cell for a whole-file proposal", () => {
    const summary = page([proposal({ line: null })], "", true);
    expect(summary).toContain("src/app.ts");
    expect(summary).not.toContain("src/app.ts:0");
    // Dry-run footer.
    expect(summary).toContain("**Dry run**");
  });
});
