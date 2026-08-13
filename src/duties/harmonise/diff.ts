/**
 * Diff computation for the `harmonise` duty.
 *
 * Produces a line-by-line diff between the historical source content (resolved
 * from the provenance `sourceRevision` blob SHA) and the current source content.
 * The classifier model receives this diff and classifies each change as
 * semantic, correction, or locale-specific.
 *
 * The invariant: `computeSourceDiff` receives the **actual historical content**
 * and the **actual current content**, and produces a real textual diff — never
 * a fabricated description, and never a full-document dump masquerading as a
 * comparison.
 */

/**
 * Computes a line-by-line diff between the previous and current source content.
 *
 * Returns a diff string with `-` prefixed lines for removals and `+` prefixed
 * lines for additions. The output is a standard diff format the classifier
 * model understands.
 *
 * An empty string means no changes were detected — the two contents are
 * identical line-for-line.
 */
export function computeSourceDiff(previousContent: string, currentContent: string): string {
  const oldLines = previousContent.split("\n");
  const newLines = currentContent.split("\n");

  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table using a flat array.
  // Width is (n+1) so index [i][j] maps to flat[i * width + j].
  const width = n + 1;
  const table = new Array<number>((m + 1) * width).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        table[i * width + j] = (table[(i - 1) * width + (j - 1)] ?? 0) + 1;
      } else {
        const fromAbove = table[(i - 1) * width + j] ?? 0;
        const fromLeft = table[i * width + (j - 1)] ?? 0;
        table[i * width + j] = fromLeft > fromAbove ? fromLeft : fromAbove;
      }
    }
  }

  // Backtrace to produce the diff
  const result: string[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      // Common line — part of the LCS, no diff output
      i--;
      j--;
    } else {
      const fromAbove = i > 0 ? (table[(i - 1) * width + j] ?? 0) : -1;
      const fromLeft = j > 0 ? (table[i * width + (j - 1)] ?? 0) : -1;

      if (j > 0 && fromLeft >= fromAbove) {
        const line = newLines[j - 1] ?? "";
        result.unshift(`+ ${line}`);
        j--;
      } else {
        const line = oldLines[i - 1] ?? "";
        result.unshift(`- ${line}`);
        i--;
      }
    }
  }

  return result.join("\n");
}

/**
 * Formats the initial sync case — no previous content to compare against.
 *
 * On the first run (when `sourceRevision` is empty), there is no historical
 * baseline. The entire source document is presented as new content so the
 * classifier can identify which changes are semantic and need propagation.
 */
export function formatInitialSync(content: string): string {
  return `This is the initial sync. The source document is:\n\n${content}`;
}
