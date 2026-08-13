/**
 * Unit tests for the summary module.
 */
import { describe, expect, it } from "vitest";

import { summarize } from "./summary.js";
import type { GroupResult } from "./summary.js";
import type { DocumentGroup } from "./discover.js";

describe("summarize", () => {
  it("renders an empty run", () => {
    const page = summarize({
      dryRun: false,
      results: [],
      warrant: ".github/reeve.yml",
      implicit: false,
      ungranted: null,
      spent: [],
      modelNames: new Map(),
    });

    expect(page).toContain("Reeve · harmonise");
    expect(page).toContain("No document groups need synchronisation");
  });

  it("renders a dry-run notice", () => {
    const page = summarize({
      dryRun: true,
      results: [],
      warrant: ".github/reeve.yml",
      implicit: false,
      ungranted: null,
      spent: [],
      modelNames: new Map(),
    });

    expect(page).toContain("Dry run");
  });

  it("renders results with synced and conflicts", () => {
    const group: DocumentGroup = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
      ]),
    };

    const result: GroupResult = {
      group,
      classification: "semantic",
      hunks: [{ description: "Added troubleshooting", classification: "semantic" }],
      synced: ["vi"],
      conflicts: [],
      skipped: [],
    };

    const page = summarize({
      dryRun: false,
      results: [result],
      warrant: ".github/reeve.yml",
      implicit: false,
      ungranted: null,
      spent: [],
      modelNames: new Map(),
    });

    expect(page).toContain("docs/guide");
    expect(page).toContain("semantic");
    expect(page).toContain("vi");
  });

  it("renders ungranted notice", () => {
    const page = summarize({
      dryRun: false,
      results: [],
      warrant: ".github/reeve.yml",
      implicit: false,
      ungranted: "not granted",
      spent: [],
      modelNames: new Map(),
    });

    expect(page).toContain("Not granted");
  });
});
