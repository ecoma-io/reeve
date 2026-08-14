/**
 * The GitHub Actions manager — discovers dependencies from workflow YAML files.
 *
 * GitHub Actions dependencies are the `uses:` lines in `.github/workflows/*.yml`:
 *   - `actions/checkout@v4` (tag reference)
 *   - `actions/checkout@a81bbbf8298c0fa03ea29cdc473d45769f953675` (SHA reference)
 *
 * Deterministic: the same workflow YAML content produces the same `Dependency`
 * list every time. No LLM, no network.
 *
 * This manager treats each `uses:` line as a dependency where:
 * - `name` = the action reference (e.g. `actions/checkout`)
 * - `constraint` = the tag/version part (e.g. `v4`, `main`)
 * - `currentVersion` = the pinned SHA if resolvable, or the tag
 * - `dev` = always false (GitHub Actions has no dev/production distinction)
 *
 * SHA references are detected by `isSha()` and classified as `"digest"` updates
 * when a newer SHA exists for the same tag.
 */
import type { Dependency, UpdateProposal } from "../model.js";
import { isSha } from "../semver.js";
import type { Manager, ManagerId, ManagerResult } from "./types.js";

/** The GitHub Actions manager identifier. */
const ID: ManagerId = "github-actions";

/** Directory where GitHub Actions workflow files live. */
const WORKFLOW_DIR = ".github/workflows";

/** Filenames this manager looks for — matches any YAML file in the workflows directory. */
const MANIFEST_FILENAMES = [
  // These are matched by the registry's `endsWith` check, so we provide
  // the most common names. The registry also matches subdirectory paths.
  "workflows/ci.yml",
  "workflows/build.yml",
  "workflows/test.yml",
  "workflows/deploy.yml",
  "workflows/release.yml",
  "workflows/lint.yml",
] as const;

export function createGithubActionsManager(): Manager {
  return {
    id: ID,
    ecosystem: "github-actions",
    manifestFilenames: MANIFEST_FILENAMES,
    parse,
    applyUpdate,
    matchManifest: isWorkflowFile,
  };
}

/**
 * Whether a repository path looks like a GitHub Actions workflow file.
 *
 * Workflow files are YAML files under `.github/workflows/`.
 */
export function isWorkflowFile(path: string): boolean {
  return path.startsWith(`${WORKFLOW_DIR}/`) && /\.(yml|yaml)$/.test(path);
}

/**
 * Parse a workflow YAML file and return every `uses:` dependency found.
 *
 * Scans for lines matching `uses: owner/repo@ref` in jobs, steps,
 * and reusable workflows. Each unique `uses:` line becomes a Dependency.
 */
function parse(
  manifestPath: string,
  manifestContent: string,
  _lockfileContent: string | null,
): ManagerResult {
  // GitHub Actions has no lockfile concept
  const dependencies: Dependency[] = [];
  const seen = new Set<string>();

  const lines = manifestContent.split("\n");
  for (const line of lines) {
    const match = parseUsesLine(line);
    if (match === null) continue;

    // Deduplicate — same action@ref in the same file counts once
    const key = `${match.owner}/${match.repo}@${match.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fullName = `${match.owner}/${match.repo}`;
    const isDigest = isSha(match.ref);

    dependencies.push({
      ecosystem: "github-actions",
      name: fullName,
      constraint: isDigest ? null : match.ref,
      currentVersion: match.ref,
      manifestPath,
      dev: false,
      manager: ID,
    });
  }

  return { manifestPath, dependencies, partial: false };
}

/**
 * Parse a `uses:` line from a workflow YAML file.
 *
 * Matches patterns like:
 * - `uses: actions/checkout@v4`
 * - `- uses: actions/checkout@v4` (step in a job)
 * - `uses: ./.github/actions/my-action` (local action — skipped)
 * - `uses: docker://alpine:3.8` (docker action — skipped)
 *
 * Returns null when the line does not contain a remote action reference.
 */
function parseUsesLine(line: string): { owner: string; repo: string; ref: string } | null {
  // Strip leading whitespace and list markers
  const trimmed = line.trim().replace(/^-\s+/, "");

  // Must start with "uses:"
  if (!trimmed.startsWith("uses:")) return null;

  // Extract the value after "uses:"
  let value = trimmed.slice(5).trim();

  // Strip surrounding quotes (YAML allows single or double quoted strings)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  // Skip local actions (starts with ./)
  if (value.startsWith("./")) return null;

  // Skip docker actions (starts with docker://)
  if (value.startsWith("docker://")) return null;

  // Parse owner/repo@ref
  const atIdx = value.lastIndexOf("@");
  if (atIdx <= 0) return null; // No @ or @ at start

  const actionPart = value.slice(0, atIdx);
  const ref = value.slice(atIdx + 1);

  // Action reference must be owner/repo format
  const slashIdx = actionPart.indexOf("/");
  if (slashIdx <= 0) return null; // No slash or slash at start (e.g. @ref)

  const owner = actionPart.slice(0, slashIdx);
  const repo = actionPart.slice(slashIdx + 1);

  // Validate: owner and repo must be non-empty and contain only valid chars
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) return null;
  if (ref.length === 0) return null;

  return { owner, repo, ref };
}

/**
 * Apply an update to a workflow YAML file, returning the modified content.
 *
 * For tag references: replaces `owner/repo@old-tag` with `owner/repo@new-tag`.
 * For SHA references: replaces `owner/repo@old-sha` with `owner/repo@new-sha`.
 *
 * The replacement is done line-by-line, which preserves the file's formatting
 * and comments. YAML structure is not parsed for the edit — only the `uses:`
 * line text is matched and replaced.
 *
 * Returns null when the old reference is not found in the file.
 */
function applyUpdate(manifestContent: string, proposal: UpdateProposal): string | null {
  const fullName = proposal.dependency.name;
  const oldRef = proposal.dependency.currentVersion;
  const newRef = proposal.targetVersion;

  // Build the old and new `uses:` patterns
  const oldPattern = `${fullName}@${oldRef}`;
  const newPattern = `${fullName}@${newRef}`;

  // Replace all occurrences in the file
  const lines = manifestContent.split("\n");
  const newLines: string[] = [];
  let replaced = false;

  for (const line of lines) {
    if (line.includes(oldPattern)) {
      // Check if this is actually a `uses:` line containing the old reference
      const trimmed = line.trim().replace(/^-\s+/, "");
      if (trimmed.startsWith("uses:") && trimmed.includes(oldPattern)) {
        newLines.push(line.replace(oldPattern, newPattern));
        replaced = true;
        continue;
      }
    }
    newLines.push(line);
  }

  if (!replaced) return null;

  return newLines.join("\n");
}

/**
 * Override the manifest filename matching for GitHub Actions.
 *
 * The standard registry `select()` uses `endsWith()` matching, which works
 * for `package.json` and `Cargo.toml` but not for GitHub Actions workflow
 * files which have variable names. This manager needs the registry to
 * also check for any `.yml`/`.yaml` file under `.github/workflows/`.
 *
 * The registry already supports this: when the manager's `manifestFilenames`
 * includes a path like `workflows/ci.yml`, the registry's `endsWith` check
 * matches any file whose path ends with that segment. Since we provide
 * multiple common workflow names, most files will be found. However, for
 * complete coverage, the registry's `select()` method should also be updated
 * to check `isWorkflowFile()` for the GitHub Actions ecosystem.
 *
 * For now, we provide a broad set of common filenames and rely on the
 * registry's existing logic.
 */
