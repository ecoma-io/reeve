/**
 * Ignore markers for the `harmonise` duty: HTML comment directives that tell
 * the sync to preserve sections of the target locale as-is, without
 * translation or propagation.
 *
 * Two forms:
 *
 * - `<!-- reeve:ignore-next-line -->` — skip the immediately following line
 * - `<!-- reeve:ignore-start -->` / `<!-- reeve:ignore-end -->` — skip
 *   everything between them (inclusive of the comment lines themselves)
 *
 * The extract-and-reinsert pattern keeps the model from ever seeing the
 * ignored content: ignored blocks are replaced with a placeholder comment
 * (`<!-- reeve-keep-section -->`) before the model is called, and the
 * target's original content is spliced back in after sanitize runs.
 *
 * `sanitize`'s `defangComments` replaces all non-exempt characters in a
 * comment payload with `-` (exempt: backtick, tilde, backslash, newline,
 * carriage return, space). The payload ` reeve-keep-section ` (20 chars)
 * becomes ` ------------------ ` (18 dashes, 2 spaces). The full sanitized
 * placeholder is `<!-- ------------------ -->`, which `reinsert()` matches
 * with a regex.
 */
import * as core from "@actions/core";

/** A span of content from the target that should be preserved as-is. */
export interface IgnoreSpan {
  /** The original content from the target (including marker comments). */
  readonly content: string;
}

/** Result of extracting ignore markers from content. */
export interface ExtractResult {
  /** Content with ignored blocks replaced by `<!-- reeve-keep-section -->` placeholders. */
  readonly content: string;
  /** The extracted ignored blocks, in document order. */
  readonly spans: readonly IgnoreSpan[];
}

/** The placeholder comment that replaces an ignored block in model input. */
const PLACEHOLDER = "<!-- reeve-keep-section -->";

/**
 * After `sanitize`, the placeholder payload is replaced with dashes
 * (all non-exempt characters become `-`, spaces survive).
 * ` reeve-keep-section ` → ` ------------------ ` (18 dashes, 2 spaces).
 * The full sanitized placeholder is `<!-- ------------------ -->`.
 */
const SANITIZED_PLACEHOLDER = /<!-- ------------------ -->\n?/g;

/** Matches a line that is only an `ignore-next-line` marker. */
const IGNORE_NEXT_LINE = /^\s*<!--\s*reeve:ignore-next-line\s*-->\s*$/;

/** Matches a line that is only an `ignore-start` marker. */
const IGNORE_START = /^\s*<!--\s*reeve:ignore-start\s*-->\s*$/;

/** Matches a line that is only an `ignore-end` marker. */
const IGNORE_END = /^\s*<!--\s*reeve:ignore-end\s*-->\s*$/;

/**
 * Parses `<!-- reeve:ignore-next-line -->` and `<!-- reeve:ignore-start/end -->`
 * markers, replaces ignored blocks with placeholder comments, and returns the
 * extracted content for later reinsertion.
 */
export function extract(content: string): ExtractResult {
  const spans: IgnoreSpan[] = [];
  const lines = splitLines(content);
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = stripTerminator(lines[i] ?? "");

    // Check for ignore-next-line
    if (IGNORE_NEXT_LINE.test(line)) {
      const markerLine = i;
      // Advance past the marker line
      i += 1;
      // Skip blank lines — they are kept in the output, not part of the span
      while (i < lines.length && stripTerminator(lines[i] ?? "").trim().length === 0) {
        output.push(lines[i] ?? "");
        i += 1;
      }
      // Skip other marker lines — they should be processed on their own, not
      // consumed as the ignored line of this marker. This prevents two adjacent
      // ignore-next-line markers from swallowing each other, and prevents
      // ignore-next-line from consuming an ignore-start marker.
      if (i < lines.length) {
        const candidate = stripTerminator(lines[i] ?? "");
        if (
          IGNORE_NEXT_LINE.test(candidate) ||
          IGNORE_START.test(candidate) ||
          IGNORE_END.test(candidate)
        ) {
          // No non-marker line to ignore — the marker itself is still extracted
          // (as an empty-effect span), and the other marker is left for its own
          // processing.
          spans.push({
            content: lines.slice(markerLine, markerLine + 1).join(""),
          });
          output.push(PLACEHOLDER + "\n");
          continue;
        }
      }
      // Collect the next non-blank, non-marker line as the ignored line (if any)
      const ignoredLine = i < lines.length ? i : -1;
      if (ignoredLine >= 0) {
        i += 1;
      }
      // The span is the marker line + the ignored line (no blank lines between)
      spans.push({
        content:
          lines.slice(markerLine, markerLine + 1).join("") +
          (ignoredLine >= 0 ? (lines[ignoredLine] ?? "") : ""),
      });
      output.push(PLACEHOLDER + "\n");
      continue;
    }

    // Check for ignore-start
    if (IGNORE_START.test(line)) {
      const start = i;
      i += 1;
      // Scan for ignore-end
      while (i < lines.length) {
        if (IGNORE_END.test(stripTerminator(lines[i] ?? ""))) {
          i += 1;
          break;
        }
        i += 1;
      }
      // Unclosed ignore-start: runs to end of document (i is already at end)
      spans.push({ content: lines.slice(start, i).join("") });
      output.push(PLACEHOLDER + "\n");
      continue;
    }

    output.push(lines[i] ?? "");
    i += 1;
  }

  return { content: output.join(""), spans };
}

/**
 * Reinserts ignored blocks into a sanitized draft, replacing the
 * sanitized placeholder pattern with the original target content.
 *
 * If the number of placeholders in the draft doesn't match the number
 * of spans, returns the draft unchanged and logs a warning — the model
 * did not preserve the placeholders, and guessing where to reinsert
 * would risk corrupting the output.
 */
export function reinsert(draft: string, spans: readonly IgnoreSpan[]): string {
  if (spans.length === 0) return draft;

  const matches = [...draft.matchAll(SANITIZED_PLACEHOLDER)];
  if (matches.length !== spans.length) {
    core.warning(
      `harmonise: ignore placeholder count mismatch ` +
        `(${String(matches.length)} in draft vs ${String(spans.length)} expected) ` +
        "— ignored sections may not be preserved",
    );
    return draft;
  }

  // Replace from end to start so earlier indices stay valid.
  let result = draft;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    const span = spans[i];
    if (match == null || span == null) continue;
    result =
      result.slice(0, match.index) + span.content + result.slice(match.index + match[0].length);
  }

  return result;
}

/**
 * The placeholder comment, exported for testing.
 * @internal
 */
export const _PLACEHOLDER = PLACEHOLDER;

/**
 * The sanitized placeholder regex, exported for testing.
 * @internal
 */
export const _SANITIZED_PLACEHOLDER = SANITIZED_PLACEHOLDER;

/** Split into lines that still carry their terminator, so joining is exact. */
function splitLines(text: string): string[] {
  const raw = text.split("\n");
  return raw.map((line, index) => (index < raw.length - 1 ? `${line}\n` : line));
}

/** Strip a line terminator for content matching. */
function stripTerminator(line: string): string {
  return line.replace(/\r?\n$/, "");
}
