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
import { parseImageRef, rewriteImageVersion } from "./docker.js";
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
    if (match !== null) {
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
      continue;
    }

    // Workflow jobs also run on Docker images — `container: image:tag` and
    // the `image:` key inside `container:`/`services:` blocks. Those are
    // dependencies of the `docker` ecosystem discovered from a workflow file;
    // the docker registry answers for their versions, and this manager's
    // `applyUpdate` rewrites the image line in place.
    const image = parseImageLine(line);
    if (image !== null) {
      const key = `image ${image.image}:${image.tag ?? "latest"}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isDigest = image.digest !== null;
      dependencies.push({
        ecosystem: "docker",
        name: image.image,
        // Same constraint shape as the docker manager's FROM handling: an
        // explicit tag is the constraint; an untagged, undigested image is
        // implicitly `latest`; a digest-only reference has no constraint.
        constraint: image.tag ?? (isDigest ? null : "latest"),
        currentVersion: isDigest ? (image.digest ?? "") : (image.tag ?? "latest"),
        manifestPath,
        dev: false,
        manager: ID,
      });
    }
  }

  return { manifestPath, dependencies, partial: false };
}

/**
 * Parse a workflow line that names a Docker image.
 *
 * Matches:
 * - `container: semgrep/semgrep:1.172.0@sha256:…` (short form)
 * - `image: postgres:16` (inside a `container:`/`services:` block)
 *
 * Values carrying workflow expressions (`${{ … }}`) are skipped — they are
 * not a fixed reference this manager can reason about. A bare word with no
 * tag, digest, or registry path (e.g. `image: node`) is also skipped: at this
 * line-based altitude it is indistinguishable from unrelated YAML keys named
 * `image`, and an unpinned image is not something dependa proposes edits for.
 */
function parseImageLine(
  line: string,
): { image: string; tag: string | null; digest: string | null } | null {
  const trimmed = line.trim().replace(/^-\s+/, "");

  let value: string | null = null;
  if (trimmed.startsWith("image:")) {
    value = trimmed.slice("image:".length).trim();
  } else if (trimmed.startsWith("container:")) {
    value = trimmed.slice("container:".length).trim();
  }
  if (value === null || value.length === 0) return null;

  // Strip surrounding quotes
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  // Expressions and empty block openers are not fixed references
  if (value.length === 0 || value.includes("${{")) return null;

  // Require a tag, digest, or registry path — a bare word is too ambiguous
  if (!value.includes(":") && !value.includes("/")) return null;

  return parseImageRef(value);
}

/**
 * Parse a `uses:` line from a workflow YAML file.
 *
 * Matches patterns like:
 * - `uses: actions/checkout@v4` (regular action)
 * - `uses: octo-org/example-repo/.github/workflows/ci.yml@main` (reusable workflow)
 * - `- uses: actions/checkout@v4` (step in a job)
 * - `uses: ./.github/actions/my-action` (local action — skipped)
 * - `uses: docker://alpine:3.8` (docker action — skipped)
 *
 * For reusable workflows, the `repo` field includes the path component
 * (e.g. `example-repo/.github/workflows/ci.yml`).
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

  // Parse owner/repo@ref — split at the LAST @ to handle refs like SHA hashes
  const atIdx = value.lastIndexOf("@");
  if (atIdx <= 0) return null; // No @ or @ at start

  const actionPart = value.slice(0, atIdx);
  const ref = value.slice(atIdx + 1);

  // Action reference must be owner/repo format (or owner/repo/path for reusable workflows).
  // Split at the FIRST slash to get the owner; everything after is the repo (possibly with path).
  const slashIdx = actionPart.indexOf("/");
  if (slashIdx <= 0) return null; // No slash or slash at start (e.g. @ref)

  const owner = actionPart.slice(0, slashIdx);
  const repo = actionPart.slice(slashIdx + 1);

  // Validate: owner must be non-empty and contain only valid chars
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || owner.length === 0) return null;
  // Validate: repo may contain slashes (reusable workflows like
  // `example-repo/.github/workflows/ci.yml`) — allow path characters
  if (repo.length === 0 || !/^[a-zA-Z0-9_.\-/]+$/.test(repo)) return null;
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
  // A docker-ecosystem dependency discovered from a workflow file is an
  // `image:`/`container:` line, not a `uses:` line — rewrite it in place.
  if (proposal.dependency.ecosystem === "docker") {
    return applyImageUpdate(manifestContent, proposal);
  }

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
 * Apply an update to a workflow's `image:`/`container:` line.
 *
 * The rewrite grammar (boundary-aware tags, digest-only and tag+digest
 * forms) lives in `docker.ts`'s `rewriteImageVersion` — one home for the
 * reference grammar, whichever manifest carries it. This function only
 * decides which lines are image lines.
 *
 * Returns null when the old reference is not found on any image line.
 */
function applyImageUpdate(manifestContent: string, proposal: UpdateProposal): string | null {
  const imageName = proposal.dependency.name;
  const oldVersion = proposal.currentVersion;
  const newVersion = proposal.targetVersion;

  const lines = manifestContent.split("\n");
  const newLines: string[] = [];
  let replaced = false;

  for (const line of lines) {
    if (parseImageLine(line) === null) {
      newLines.push(line);
      continue;
    }

    const rewritten = rewriteImageVersion(line, imageName, oldVersion, newVersion);
    if (rewritten !== null) {
      newLines.push(rewritten);
      replaced = true;
    } else {
      newLines.push(line);
    }
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
