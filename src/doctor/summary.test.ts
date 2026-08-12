import { describe, expect, it } from "vitest";

import type { AuthorityRow, Finding, Report } from "./diagnose.js";
import { summarize } from "./summary.js";

function finding(over: Partial<Finding> = {}): Finding {
  return { severity: "green", text: "Every label exists on this repository.", ...over };
}

function row(over: Partial<AuthorityRow> = {}): AuthorityRow {
  return { duty: "triage", granted: ["label"], denied: false, isDefault: true, ...over };
}

function report(over: Partial<Report> = {}): Report {
  return {
    warrantPath: ".github/reeve.yml",
    owner: "ecoma-io",
    repo: "reeve",
    duty: null,
    implicit: false,
    excludedLabels: [],
    authority: [row()],
    findings: [],
    ...over,
  };
}

describe("summarize", () => {
  it("opens with the doctor headline naming the repository, the warrant and the scope", () => {
    const page = summarize(report());

    expect(page).toContain("## Reeve · doctor");
    expect(page).toContain("`ecoma-io/reeve`, against `.github/reeve.yml`, scoped to every duty.");
  });

  it("names the one duty a scoped report was run for", () => {
    expect(summarize(report({ duty: "lifecycle" }))).toContain("scoped to `lifecycle`.");
  });

  it("lists every red finding under Problems", () => {
    const page = summarize(
      report({ findings: [finding({ severity: "red", text: "`bug` is missing." })] }),
    );

    expect(page).toContain("### Problems");
    expect(page).toContain("- `bug` is missing.");
  });

  it("says plainly that nothing would refuse a duty, rather than leaving Problems empty", () => {
    const page = summarize(report({ findings: [] }));

    expect(page).toContain("### Problems");
    expect(page).toContain("None — nothing here would refuse a duty at runtime.");
  });

  it("lists every green finding under Notes, separately from Problems", () => {
    const page = summarize(
      report({
        findings: [
          finding({ severity: "red", text: "`bug` is missing." }),
          finding({ severity: "green", text: "Every other label exists." }),
        ],
      }),
    );

    const notes = page.slice(page.indexOf("### Notes"));
    expect(notes).toContain("- Every other label exists.");
    expect(notes).not.toContain("`bug` is missing.");
  });

  it("says so when there are no notes, the same way an empty Problems section does", () => {
    expect(summarize(report({ findings: [] }))).toContain("Nothing else to report.");
  });

  it("renders the effective-authority table with one row per duty", () => {
    const page = summarize(
      report({
        authority: [
          row({ duty: "triage", granted: ["label"], isDefault: true }),
          row({ duty: "respond", granted: [], denied: true, isDefault: false }),
        ],
      }),
    );

    expect(page).toContain("### Effective authority");
    expect(page).toContain("| `triage` | `label` | this duty's own default |");
    expect(page).toContain(
      "| `respond` | *(none)* | denied — the `capabilities:` block does not name it |",
    );
  });

  it("shows a dash when a granted capability list is neither denied nor the duty's own default", () => {
    const page = summarize(
      report({
        authority: [row({ duty: "triage", granted: ["label", "comment"], isDefault: false })],
      }),
    );

    expect(page).toContain("| `triage` | `label`, `comment` | — |");
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(summarize(report())).toMatch(/[^\n]\n$/);
  });
});
