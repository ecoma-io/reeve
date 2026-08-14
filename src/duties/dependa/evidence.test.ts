/**
 * Tests for the dependa evidence module.
 *
 * Evidence is always attributed, sanitised, length-capped, and marked as
 * deterministic or model-derived. These tests verify the gather, fromChangelog,
 * fromSecurityAdvisory, encloseEvidence, and renderForPr functions.
 */
import { describe, expect, it } from "vitest";

import type { Evidence, Release, SecurityAdvisory } from "./model.js";

import {
  encloseEvidence,
  fromChangelog,
  fromCommitLog,
  fromGithubRelease,
  fromSecurityAdvisory,
  gather,
  renderForPr,
} from "./evidence.js";

// ── fromChangelog ────────────────────────────────────────────────────────

describe("fromChangelog", () => {
  it("builds a changelog evidence object", () => {
    const evidence = fromChangelog("https://example.com/changelog", "Fixed a bug.", true);
    expect(evidence.kind).toBe("changelog");
    expect(evidence.source).toBe("https://example.com/changelog");
    expect(evidence.content).toBe("Fixed a bug.");
    expect(evidence.deterministic).toBe(true);
  });

  it("marks model-derived evidence", () => {
    const evidence = fromChangelog("https://example.com/changelog", "Summary", false);
    expect(evidence.deterministic).toBe(false);
  });

  it("truncates content exceeding MAX_EVIDENCE_CHARS", () => {
    const longContent = "A".repeat(5000);
    const evidence = fromChangelog("https://example.com", longContent, true);
    expect(evidence.content.length).toBeLessThan(longContent.length);
    expect(evidence.content).toContain("[… truncated]");
  });
});

// ── fromGithubRelease ────────────────────────────────────────────────────

describe("fromGithubRelease", () => {
  it("builds a github-release evidence object", () => {
    const evidence = fromGithubRelease(
      "https://github.com/owner/repo/releases/tag/v1",
      "Release notes here",
    );
    expect(evidence.kind).toBe("github-release");
    expect(evidence.source).toBe("https://github.com/owner/repo/releases/tag/v1");
    expect(evidence.deterministic).toBe(true);
  });
});

// ── fromSecurityAdvisory ─────────────────────────────────────────────────

describe("fromSecurityAdvisory", () => {
  it("builds a security-advisory evidence object", () => {
    const advisory: SecurityAdvisory = {
      id: "CVE-2024-0001",
      severity: "high",
      summary: "Remote code execution vulnerability",
      patchedVersions: ">=2.0.0",
    };
    const evidence = fromSecurityAdvisory(advisory);
    expect(evidence.kind).toBe("security-advisory");
    expect(evidence.source).toBe("CVE-2024-0001");
    expect(evidence.content).toContain("CVE-2024-0001");
    expect(evidence.content).toContain("HIGH");
    expect(evidence.content).toContain("Remote code execution vulnerability");
    expect(evidence.content).toContain("Patched in: >=2.0.0");
    expect(evidence.deterministic).toBe(true);
  });

  it("omits patched versions line when null", () => {
    const advisory: SecurityAdvisory = {
      id: "GHSA-xxxx-xxxx-xxxx",
      severity: "moderate",
      summary: "Information disclosure",
      patchedVersions: null,
    };
    const evidence = fromSecurityAdvisory(advisory);
    expect(evidence.content).not.toContain("Patched in:");
  });
});

// ── fromCommitLog ────────────────────────────────────────────────────────

describe("fromCommitLog", () => {
  it("builds a commit-log evidence object", () => {
    const evidence = fromCommitLog(
      "https://github.com/owner/repo/compare/v1...v2",
      "abc123 def456",
    );
    expect(evidence.kind).toBe("commit-log");
    expect(evidence.source).toBe("https://github.com/owner/repo/compare/v1...v2");
    expect(evidence.deterministic).toBe(true);
  });
});

// ── gather ───────────────────────────────────────────────────────────────

describe("gather", () => {
  it("gathers evidence from releases with changelog URLs", () => {
    const releases: Release[] = [
      {
        version: "1.0.1",
        releasedAt: null,
        deprecated: false,
        yanked: false,
        isPrerelease: false,
        changelogUrl: "https://example.com/v1.0.1",
        diffUrl: null,
      },
    ];
    const fetched = new Map([["https://example.com/v1.0.1", "Bug fix release"]]);

    const evidence = gather(releases, null, fetched);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("changelog");
    expect(evidence[0]?.content).toBe("Bug fix release");
  });

  it("creates empty-content evidence when URL has no fetched text", () => {
    const releases: Release[] = [
      {
        version: "1.0.1",
        releasedAt: null,
        deprecated: false,
        yanked: false,
        isPrerelease: false,
        changelogUrl: "https://example.com/v1.0.1",
        diffUrl: null,
      },
    ];

    const evidence = gather(releases, null, new Map());
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.content).toBe("");
    expect(evidence[0]?.source).toBe("https://example.com/v1.0.1");
  });

  it("uses diffUrl as fallback when changelogUrl is null", () => {
    const releases: Release[] = [
      {
        version: "1.0.1",
        releasedAt: null,
        deprecated: false,
        yanked: false,
        isPrerelease: false,
        changelogUrl: null,
        diffUrl: "https://github.com/owner/repo/compare/v1...v2",
      },
    ];

    const evidence = gather(releases, null, new Map());
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source).toBe("https://github.com/owner/repo/compare/v1...v2");
  });

  it("skips releases with no URLs", () => {
    const releases: Release[] = [
      {
        version: "1.0.1",
        releasedAt: null,
        deprecated: false,
        yanked: false,
        isPrerelease: false,
        changelogUrl: null,
        diffUrl: null,
      },
    ];

    const evidence = gather(releases, null, new Map());
    expect(evidence).toHaveLength(0);
  });

  it("includes security advisory evidence", () => {
    const advisory: SecurityAdvisory = {
      id: "CVE-2024-0001",
      severity: "critical",
      summary: "RCE",
      patchedVersions: ">=2.0.0",
    };

    const evidence = gather([], advisory, new Map());
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("security-advisory");
  });

  it("returns empty when no releases and no advisory", () => {
    expect(gather([], null, new Map())).toEqual([]);
  });
});

// ── encloseEvidence ──────────────────────────────────────────────────────

describe("encloseEvidence", () => {
  it("returns null for empty evidence", () => {
    expect(encloseEvidence([])).toBeNull();
  });

  it("encloses evidence with attribution", () => {
    const evidence: Evidence[] = [
      {
        kind: "changelog",
        source: "https://example.com",
        content: "Fixed bugs",
        deterministic: true,
      },
    ];

    const enclosed = encloseEvidence(evidence);
    expect(enclosed).not.toBeNull();
    // The enclosed result should contain the evidence content and source
    expect(enclosed!.block).toContain("Fixed bugs");
    expect(enclosed!.block).toContain("https://example.com");
  });

  it("marks model-derived evidence", () => {
    const evidence: Evidence[] = [
      { kind: "changelog", source: "url", content: "text", deterministic: false },
    ];

    const enclosed = encloseEvidence(evidence);
    expect(enclosed!.block).toContain("model-derived");
  });

  it("does not mark deterministic evidence", () => {
    const evidence: Evidence[] = [
      { kind: "changelog", source: "url", content: "text", deterministic: true },
    ];

    const enclosed = encloseEvidence(evidence);
    expect(enclosed!.block).not.toContain("model-derived");
  });
});

// ── renderForPr ──────────────────────────────────────────────────────────

describe("renderForPr", () => {
  it("returns empty string for no evidence", () => {
    expect(renderForPr([])).toBe("");
  });

  it("renders evidence as markdown with source links", () => {
    const evidence: Evidence[] = [
      {
        kind: "changelog",
        source: "https://example.com",
        content: "Bug fixes",
        deterministic: true,
      },
    ];

    const rendered = renderForPr(evidence);
    expect(rendered).toContain("### Evidence");
    expect(rendered).toContain("changelog");
    expect(rendered).toContain("Bug fixes");
    expect(rendered).toContain("https://example.com");
  });

  it("renders empty-content evidence as a link without details", () => {
    const evidence: Evidence[] = [
      {
        kind: "github-release",
        source: "https://github.com/release",
        content: "",
        deterministic: true,
      },
    ];

    const rendered = renderForPr(evidence);
    expect(rendered).toContain("github release"); // kind with hyphens replaced by spaces
    expect(rendered).toContain("https://github.com/release");
    // No details section when content is empty
    expect(rendered).not.toContain("<details>");
  });

  it("renders content in a collapsible details section", () => {
    const evidence: Evidence[] = [
      { kind: "changelog", source: "url", content: "Some content here", deterministic: true },
    ];

    const rendered = renderForPr(evidence);
    expect(rendered).toContain("<details>");
    expect(rendered).toContain("</details>");
  });

  it("marks model-derived evidence in the render", () => {
    const evidence: Evidence[] = [
      { kind: "release-notes", source: "url", content: "content", deterministic: false },
    ];

    const rendered = renderForPr(evidence);
    expect(rendered).toContain("*(model-derived)*");
  });
});
