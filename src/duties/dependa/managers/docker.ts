/**
 * The Docker manager — discovers dependencies from `Dockerfile`.
 *
 * Deterministic: the same `Dockerfile` content produces the same `Dependency`
 * list every time. No LLM, no network.
 *
 * Docker dependencies are `FROM` instructions in Dockerfiles:
 *   - `FROM node:20` (tag reference)
 *   - `FROM node:20-slim` (tag with variant)
 *   - `FROM node@sha256:abc123...` (digest reference)
 *   - `FROM node:20@sha256:abc123...` (tag + digest)
 *
 * Special cases:
 *   - `FROM scratch` — skipped (no base image)
 *   - `FROM --platform=linux/amd64 node:20` — platform prefix is handled
 *   - Multi-stage builds: each `FROM` line is a separate dependency
 *   - `AS` aliases: preserved in the `name` field
 *
 * Docker images are always production dependencies — there is no dev/production
 * distinction in Dockerfiles. Digest references are classified as `"digest"`
 * updates.
 */
import type { Dependency, UpdateProposal } from "../model.js";
import type { Manager, ManagerId, ManagerResult } from "./types.js";

/** The Docker manager identifier. */
const ID: ManagerId = "docker";

/** Filenames the Docker manager looks for. */
const MANIFEST_FILENAMES = ["Dockerfile"] as const;

export function createDockerManager(): Manager {
  return {
    id: ID,
    ecosystem: "docker",
    manifestFilenames: MANIFEST_FILENAMES,
    parse,
    applyUpdate,
    matchManifest: (path: string): boolean => isDockerfile(path) !== null,
  };
}

/**
 * Whether a repository path looks like a Dockerfile.
 *
 * Matches `Dockerfile`, `Dockerfile.*`, and `*.Dockerfile`.
 */
export function isDockerfile(path: string): string | null {
  // Exact match: Dockerfile
  if (path === "Dockerfile" || path.endsWith("/Dockerfile")) return path;

  // Dockerfile with suffix: Dockerfile.alpine, Dockerfile.prod
  const match = /(?:^|\/)(Dockerfile\.\S+)$/.exec(path);
  if (match !== null) return path;

  // Extension-based: *.Dockerfile
  if (path.endsWith(".Dockerfile")) return path;

  return null;
}

/**
 * Parse a Dockerfile and return every `FROM` image dependency found.
 *
 * Each `FROM` line becomes a Dependency. Multi-stage builds produce
 * multiple dependencies.
 */
function parse(
  manifestPath: string,
  manifestContent: string,
  _lockfileContent: string | null,
): ManagerResult {
  // Docker has no lockfile concept
  const dependencies: Dependency[] = [];
  const seen = new Set<string>();

  for (const line of manifestContent.split("\n")) {
    const match = parseFromLine(line);
    if (match === null) continue;

    // Deduplicate — same image:tag in the same file counts once
    const key = `${match.image}:${match.tag ?? "latest"}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isDigest = match.digest !== null;
    const tag = match.tag ?? "latest";

    dependencies.push({
      ecosystem: "docker",
      name: match.image,
      // The constraint is the explicit tag (e.g. "lts", "20-slim").
      // When no tag was specified AND there's no digest, the implicit tag is "latest"
      // and we set constraint to "latest" (not null) so the pipeline can correctly
      // classify the update. A null constraint would fail pin detection (which
      // requires currentVersion === "") and semver classification ("latest" doesn't
      // parse as semver). Setting constraint = "latest" means the constraint matches
      // currentVersion and the update pipeline handles it.
      // For digest-only references (no tag, just a digest), constraint remains null
      // — the digest IS the constraint and is handled as a "digest" update type.
      constraint: match.tag ?? (isDigest ? null : "latest"),
      currentVersion: isDigest ? (match.digest ?? "") : tag,
      manifestPath,
      dev: false,
      manager: ID,
    });
  }

  return { manifestPath, dependencies, partial: false };
}

/**
 * Parse a `FROM` line from a Dockerfile.
 *
 * Handles:
 * - `FROM image:tag`
 * - `FROM image@sha256:hash`
 * - `FROM image:tag@sha256:hash`
 * - `FROM --platform=linux/amd64 image:tag`
 * - `FROM scratch` (returns null)
 *
 * Returns null when the line does not contain a valid FROM instruction.
 */
function parseFromLine(
  line: string,
): { image: string; tag: string | null; digest: string | null } | null {
  const trimmed = line.trim();

  // Must start with FROM (case-insensitive in Docker, but convention is uppercase)
  if (!/^FROM\s/i.test(trimmed)) return null;

  // Extract the rest after FROM
  let rest = trimmed.replace(/^FROM\s+/i, "").trim();

  // Handle --platform flag
  if (rest.startsWith("--platform=")) {
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return null;
    rest = rest.slice(spaceIdx + 1).trim();
  }

  // Remove AS alias
  const asMatch = /\s+[Aa][Ss]\s+\S+/.exec(rest);
  if (asMatch !== null) {
    rest = rest.slice(0, asMatch.index).trim();
  }

  // Skip scratch
  if (rest === "scratch") return null;

  // Parse image reference
  return parseImageRef(rest);
}

/**
 * Parse a Docker image reference into its components.
 *
 * Format: `[registry/]image[:tag][@digest]`
 * - `node:20` → { image: "node", tag: "20", digest: null }
 * - `node@sha256:abc123` → { image: "node", tag: null, digest: "sha256:abc123" }
 * - `node:20@sha256:abc123` → { image: "node", tag: "20", digest: "sha256:abc123" }
 * - `ghcr.io/owner/image:tag` → { image: "ghcr.io/owner/image", tag: "tag", digest: null }
 *
 * Exported for the GitHub Actions manager, whose workflow `container:` and
 * `services:` images use exactly this grammar.
 */
export function parseImageRef(
  ref: string,
): { image: string; tag: string | null; digest: string | null } | null {
  if (ref.length === 0) return null;

  let remaining = ref;
  let digest: string | null = null;

  // Check for digest: @sha256:...
  const atIdx = remaining.lastIndexOf("@");
  if (atIdx !== -1) {
    const digestPart = remaining.slice(atIdx + 1);
    if (digestPart.startsWith("sha256:")) {
      digest = digestPart;
      remaining = remaining.slice(0, atIdx);
    }
  }

  // Split image and tag
  // The tag separator colon is the last colon that appears after the last slash.
  // A colon before the last slash is part of a registry hostname:port.
  // e.g. `localhost:5000/myimage:tag` → tag="tag"
  // e.g. `node:20` → tag="20"
  // e.g. `ghcr.io/owner/image:20` → tag="20"
  let tag: string | null = null;
  const lastSlash = remaining.lastIndexOf("/");
  const colonIdx = remaining.lastIndexOf(":");
  if (colonIdx !== -1 && colonIdx > lastSlash) {
    // Colon is after the last slash — this is a tag separator
    const afterColon = remaining.slice(colonIdx + 1);
    if (/^[a-zA-Z0-9_.-]+$/.test(afterColon)) {
      tag = afterColon;
      remaining = remaining.slice(0, colonIdx);
    }
  }

  const image = remaining;
  if (image.length === 0) return null;

  // Validate image name
  if (!/^[a-zA-Z0-9._/:-]+$/.test(image)) return null;

  return { image, tag, digest };
}

/**
 * Apply an update to a Dockerfile, returning the modified content.
 *
 * For tag references: replaces `image:old-tag` with `image:new-tag`.
 * For digest references: replaces `image@sha256:old-hash` with `image@sha256:new-hash`.
 * For tag+digest: replaces the tag and digest together.
 *
 * Returns null when the old reference is not found in the file.
 */
function applyUpdate(manifestContent: string, proposal: UpdateProposal): string | null {
  const imageName = proposal.dependency.name;
  const oldVersion = proposal.currentVersion;
  const newVersion = proposal.targetVersion;

  const lines = manifestContent.split("\n");
  const newLines: string[] = [];
  let replaced = false;

  for (const line of lines) {
    // Only modify FROM lines
    if (!/^FROM\s/i.test(line.trim())) {
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
 * Rewrite one line's reference to an image from one version to another.
 *
 * The single home of the rewrite grammar, shared with the GitHub Actions
 * manager — a workflow's `container:`/`services:` image lines carry exactly
 * a Dockerfile `FROM` line's reference grammar.
 *
 * Tag references (`image:old-tag` → `image:new-tag`) use a boundary-aware
 * regex so `node:20` never matches inside `node:20-slim` or `node:20.5` —
 * a tag ends at whitespace, `@` (digest), a quote (YAML), `AS` (Dockerfile
 * alias), or end-of-line. Digest references replace `@sha256:old` with
 * `@sha256:new`, in both the digest-only (`image@sha256:…`) and tag+digest
 * (`image:tag@sha256:…`) forms, and only when the digest belongs to this
 * image. A mixed tag/digest pair cannot be rewritten.
 *
 * Returns the rewritten line, or null when the line does not carry the old
 * reference.
 */
export function rewriteImageVersion(
  line: string,
  imageName: string,
  oldVersion: string,
  newVersion: string,
): string | null {
  if (!line.includes(imageName)) return null;

  const oldIsDigest = oldVersion.startsWith("sha256:");
  const newIsDigest = newVersion.startsWith("sha256:");

  // Tag reference: image:old-tag → image:new-tag
  if (!oldIsDigest && !newIsDigest) {
    const tagBoundaryPattern = new RegExp(
      `${escapeRegex(imageName)}:${escapeRegex(oldVersion)}(?=[\\s@"']|$|[Aa][Ss]\\s)`,
    );
    if (!tagBoundaryPattern.test(line)) return null;
    return line.replace(tagBoundaryPattern, `${imageName}:${newVersion}`);
  }

  // Digest reference: @sha256:old → @sha256:new
  if (oldIsDigest && newIsDigest) {
    const oldDigest = `@${oldVersion}`;
    if (!line.includes(oldDigest)) return null;
    const digestBelongsToImage =
      line.includes(`${imageName}${oldDigest}`) ||
      new RegExp(`${escapeRegex(imageName)}:[^@\\s]+${escapeRegex(oldDigest)}`).test(line);
    if (!digestBelongsToImage) return null;
    return line.replace(oldDigest, `@${newVersion}`);
  }

  return null;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
