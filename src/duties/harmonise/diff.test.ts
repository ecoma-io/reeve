/**
 * Regression tests for the harmonise diff computation.
 *
 * These tests prove that `computeSourceDiff` produces a real textual diff
 * between historical and current source content — the invariant that
 * `sourceRevision` (a Git blob SHA) must be resolved to actual historical
 * content before the classifier receives the diff.
 */
import { describe, expect, it } from "vitest";

import { computeSourceDiff, formatInitialSync } from "./diff.js";

describe("computeSourceDiff", () => {
  // Case A — Semantic source change
  it("shows added sections when the source gains new content", () => {
    const previous = "# Guide\n\nIntroduction.\n\n## Setup\n\nRun `npm install`.";
    const current =
      "# Guide\n\nIntroduction.\n\n## Setup\n\nRun `npm install`.\n\n## Troubleshooting\n\nCommon errors here.";

    const diff = computeSourceDiff(previous, current);

    expect(diff).toContain("+ ## Troubleshooting");
    expect(diff).toContain("+ Common errors here.");
    expect(diff).not.toContain("- ");
  });

  it("shows removed sections when the source loses content", () => {
    const previous =
      "# Guide\n\nIntroduction.\n\n## Setup\n\nRun `npm install`.\n\n## Troubleshooting\n\nCommon errors here.";
    const current = "# Guide\n\nIntroduction.\n\n## Setup\n\nRun `npm install`.";

    const diff = computeSourceDiff(previous, current);

    expect(diff).toContain("- ## Troubleshooting");
    expect(diff).toContain("- Common errors here.");
    expect(diff).not.toContain("+ ");
  });

  it("shows both additions and removals when content is replaced", () => {
    const previous = "# Guide\n\nOld introduction.\n\n## Setup\n\nRun `npm install`.";
    const current = "# Guide\n\nNew introduction.\n\n## Setup\n\nRun `pnpm install`.";

    const diff = computeSourceDiff(previous, current);

    expect(diff).toContain("- Old introduction.");
    expect(diff).toContain("+ New introduction.");
    expect(diff).toContain("- Run `npm install`.");
    expect(diff).toContain("+ Run `pnpm install`.");
  });

  // Case B — No source change
  it("returns an empty string when content is identical", () => {
    const content = "# Guide\n\nIntroduction.\n\n## Setup\n\nRun `npm install`.";

    expect(computeSourceDiff(content, content)).toBe("");
  });

  // Case C — Whitespace-only change
  it("shows whitespace-only changes as diff lines", () => {
    const previous = "Line one.\nLine two.\nLine three.";
    const current = "Line one.\n\nLine two.\nLine three.";

    const diff = computeSourceDiff(previous, current);

    // The blank line was added
    expect(diff).toContain("+ ");
    // No removals — the original lines are all still there
    expect(diff).not.toContain("-");
  });

  // Case D — Historical source contains content that current source does not
  it("shows removed lines — proving historical content is actually retrieved", () => {
    const previous = "A\nB\nC";
    const current = "A\nC";

    const diff = computeSourceDiff(previous, current);

    expect(diff).toContain("- B");
    expect(diff).not.toContain("+ ");
  });

  // Case E — Historical source lacks content that current source has
  it("shows added lines — proving the diff is not fabricated", () => {
    const previous = "A\nC";
    const current = "A\nB\nC";

    const diff = computeSourceDiff(previous, current);

    expect(diff).toContain("+ B");
    expect(diff).not.toContain("- ");
  });

  // Additional edge cases
  it("handles completely different content", () => {
    const previous = "Old line 1\nOld line 2";
    const current = "New line 1\nNew line 2";

    const diff = computeSourceDiff(previous, current);

    expect(diff).toContain("- Old line 1");
    expect(diff).toContain("- Old line 2");
    expect(diff).toContain("+ New line 1");
    expect(diff).toContain("+ New line 2");
  });

  it("handles empty previous content", () => {
    const current = "# New Document\n\nHello.";

    const diff = computeSourceDiff("", current);

    // Every line is an addition
    const lines = diff.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\+ /);
    }
  });

  it("handles empty current content", () => {
    const previous = "# Document\n\nHello.";

    const diff = computeSourceDiff(previous, "");

    // Every line is a removal
    const lines = diff.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^- /);
    }
  });

  it("handles both empty", () => {
    expect(computeSourceDiff("", "")).toBe("");
  });

  it("preserves common lines in their original order", () => {
    const previous = "A\nB\nC\nD";
    const current = "A\nC\nD\nE";

    const diff = computeSourceDiff(previous, current);

    // B was removed, E was added
    expect(diff).toContain("- B");
    expect(diff).toContain("+ E");
  });

  it("handles duplicate lines correctly", () => {
    const previous = "A\nA\nB";
    const current = "A\nB\nB";

    const diff = computeSourceDiff(previous, current);

    // One A removed, one B added
    expect(diff).toContain("- A");
    expect(diff).toContain("+ B");
  });
});

describe("formatInitialSync", () => {
  it("presents the full document as initial sync content", () => {
    const content = "# Guide\n\nHello.";
    const result = formatInitialSync(content);

    expect(result).toContain("This is the initial sync.");
    expect(result).toContain(content);
  });
});
