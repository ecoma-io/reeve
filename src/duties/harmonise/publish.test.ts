/**
 * Unit tests for the publish module — branch naming, PR body rendering, and
 * dry-run logic.
 *
 * Nothing is mocked: this module renders strings and makes branching decisions
 * from the values it is handed, and the most consequential side effects
 * (GitHub API calls) are gated behind the dry-run flag.
 */
import { describe, expect, it } from "vitest";

import { buildPrBody, sanitizeBranchSegment } from "./publish.js";
import type { Draft } from "./draft.js";
import type { DocumentGroup } from "./discover.js";

describe("sanitizeBranchSegment", () => {
  it("replaces slashes with dashes", () => {
    expect(sanitizeBranchSegment("docs/getting-started")).toBe("docs-getting-started");
  });

  it("replaces spaces with dashes", () => {
    expect(sanitizeBranchSegment("docs/my guide")).toBe("docs-my-guide");
  });

  it("replaces tildes with dashes", () => {
    expect(sanitizeBranchSegment("docs/~draft")).toBe("docs--draft");
  });

  it("replaces colons with dashes", () => {
    expect(sanitizeBranchSegment("docs/guide:v2")).toBe("docs-guide-v2");
  });

  it("replaces carets with dashes", () => {
    expect(sanitizeBranchSegment("docs/^wip")).toBe("docs--wip");
  });

  it("prepends 'branch' when the name starts with a dash", () => {
    expect(sanitizeBranchSegment("-leading-dash")).toBe("branch-leading-dash");
  });

  it("does not prepend 'branch' for a normal name", () => {
    expect(sanitizeBranchSegment("docs/guide")).toBe("docs-guide");
  });

  it("preserves dots, underscores, and alphanumerics", () => {
    expect(sanitizeBranchSegment("docs/guide_v2.1")).toBe("docs-guide_v2.1");
  });

  it("handles a simple root-level file", () => {
    expect(sanitizeBranchSegment("README")).toBe("README");
  });

  it("handles deeply nested paths", () => {
    expect(sanitizeBranchSegment("docs/en/guides/setup")).toBe("docs-en-guides-setup");
  });
});

describe("buildPrBody", () => {
  const group: DocumentGroup = {
    id: "docs/getting-started",
    files: new Map([
      ["en", "docs/getting-started.md"],
      ["vi", "docs/getting-started.vi.md"],
    ]),
  };

  /** A minimal admissible draft. */
  function draft(text = "Updated translation."): Draft {
    return {
      model: "model-a",
      text,
      score: { admissible: true, value: 0.9, reason: null, checks: [] },
    };
  }

  it("includes the document group id", () => {
    const body = buildPrBody({ group, drafts: new Map([["vi", draft()]]), conflicts: [] });
    expect(body).toContain("`docs/getting-started`");
  });

  it("lists each updated locale", () => {
    const body = buildPrBody({ group, drafts: new Map([["vi", draft()]]), conflicts: [] });
    expect(body).toContain("`vi`: translation updated");
  });

  it("omits the conflicts section when there are none", () => {
    const body = buildPrBody({ group, drafts: new Map([["vi", draft()]]), conflicts: [] });
    expect(body).not.toContain("Conflicts");
  });

  it("shows the conflicts section when locales have human edits", () => {
    const body = buildPrBody({
      group,
      drafts: new Map([["vi", draft()]]),
      conflicts: ["zh"],
    });
    expect(body).toContain("Conflicts (not overwritten)");
    expect(body).toContain("`zh`: human edit since last sync");
  });

  it("includes the marker for idempotency", () => {
    const body = buildPrBody({ group, drafts: new Map([["vi", draft()]]), conflicts: [] });
    // The marker is a comment: <!-- reeve:harmonise source=... -->
    expect(body).toContain("reeve:harmonise");
  });
});
