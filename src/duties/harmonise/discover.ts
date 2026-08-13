/**
 * Discovers locale-variant file groups in the repository.
 *
 * Files are grouped by their base name using the suffix pattern:
 * `docs/getting-started.md` ← EN (source, no suffix)
 * `docs/getting-started.vi.md` ← VI
 * `docs/getting-started.zh.md` ← ZH
 *
 * The suffix pattern is `.<locale-code>.md` before the final `.md` extension.
 * Files without a locale suffix are the source. Grouping is by base name —
 * `docs/getting-started` is the document group, `vi` is the locale within it.
 *
 * The source language is a separate parameter from the target languages because
 * the source language of committed documentation is a deliberate organisational
 * decision — unlike PRs and issues (where `translate` works), the source
 * language of documentation is not an incidental contributor preference.
 */
import { type Language } from "../../core/languages.js";

/** One document group — a source file and its locale variants. */
export interface DocumentGroup {
  /** The base name before any locale suffix — e.g. `docs/getting-started`. */
  readonly id: string;
  /** Locale code → file path. The source locale (no suffix) is always present. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * The locale suffix pattern: `.<locale-code>.md` before the final `.md`.
 *
 * Matches `docs/getting-started.vi.md` → locale `vi`, base `docs/getting-started`.
 * Does NOT match `docs/getting-started.md` (no locale suffix — this is the source).
 * Does NOT match `docs/getting-started.vi.txt` (wrong extension).
 * Does NOT match `docs/.vi.md` (no base name before the suffix).
 */
const LOCALE_SUFFIX = /^(.+)\.([a-z]{2,3}(?:-[A-Z][a-zA-Z]+)?)\.md$/;

/**
 * Groups files by their base name, identifying source and locale variants.
 *
 * @param paths - All Markdown file paths in the repository (or under the
 *   configured `paths` scope).
 * @param sourceLanguage - The source language — the language the unsuffixed
 *   documentation files are written in.
 * @param targetLanguages - The target languages — the locale-suffixed files
 *   that get synchronised against the source.
 * @param pathsFilter - If non-empty, only files under these prefixes are
 *   considered.
 */
export function discoverGroups(
  paths: readonly string[],
  sourceLanguage: Language,
  targetLanguages: readonly Language[],
  pathsFilter: readonly string[],
): readonly DocumentGroup[] {
  const sourceCode = sourceLanguage.code.toLowerCase();
  const targetCodes = new Set(targetLanguages.map((lang) => lang.code.toLowerCase()));
  const scoped =
    pathsFilter.length > 0 ? paths.filter((p) => pathsFilter.some((f) => p.startsWith(f))) : paths;

  // base name → locale code → file path
  const groups = new Map<string, Map<string, string>>();

  for (const path of scoped) {
    if (!path.endsWith(".md")) continue;

    const suffixMatch = LOCALE_SUFFIX.exec(path);
    if (suffixMatch !== null) {
      const base = suffixMatch[1];
      const locale = suffixMatch[2];
      if (base === undefined || locale === undefined) continue;
      // Only include files whose locale is a configured target
      if (!targetCodes.has(locale.toLowerCase())) continue;
      let group = groups.get(base);
      if (group === undefined) {
        group = new Map();
        groups.set(base, group);
      }
      group.set(locale.toLowerCase(), path);
    } else {
      // No locale suffix — this is a source file
      const base = path.slice(0, -".md".length);
      let group = groups.get(base);
      if (group === undefined) {
        group = new Map();
        groups.set(base, group);
      }
      // Source locale always present
      group.set(sourceCode, path);
    }
  }

  const result: DocumentGroup[] = [];
  for (const [id, files] of groups) {
    // A group must have a source file to be valid
    if (!files.has(sourceCode)) continue;
    // A group must have at least one target locale — no target locales means
    // no synchronisation work to do
    let hasTarget = false;
    for (const locale of files.keys()) {
      if (locale !== sourceCode && targetCodes.has(locale)) {
        hasTarget = true;
        break;
      }
    }
    if (!hasTarget) continue;
    result.push({ id, files });
  }

  return result;
}
