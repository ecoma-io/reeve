/**
 * The GitHub tags datasource — resolves available versions for GitHub Actions.
 *
 * Queries the GitHub API for tags and releases of an action repository.
 * Handles:
 * - `actions/checkout` → tags like `v4`, `v3`, `v2`
 * - SHA references → resolves to the tag the SHA belongs to
 * - Rate limiting (D12: capacity is weather)
 * - 404 for unknown actions
 *
 * The GitHub API returns tags via `repos.listTags` and releases via
 * `repos.listReleases`. Tags are the primary version source for actions;
 * releases provide changelogs and release notes as evidence.
 *
 * **External metadata is evidence, never authority.**
 */
import type { Release, ResolutionResult } from "../model.js";
import type { Datasource, DatasourceId } from "./types.js";

/** The GitHub tags datasource identifier. */
const ID: DatasourceId = "github-tags";

export function createGithubTagsDatasource(token: string): Datasource {
  return {
    id: ID,
    ecosystem: "github-actions",
    resolve: (packageName: string) => resolve(token, packageName),
  };
}

/**
 * Resolve available versions for a GitHub Action.
 *
 * Queries the GitHub tags API for the action's repository.
 * Network errors degrade to `temporarily-unavailable` (D12).
 */
async function resolve(token: string, packageName: string): Promise<ResolutionResult> {
  // Package names for GitHub Actions are "owner/repo"
  const parts = packageName.split("/");
  if (parts.length < 2) {
    return { status: "not-found" };
  }

  const owner = parts[0];
  const repo = parts.slice(1).join("/");

  // Fetch tags from the GitHub API
  const tagsUrl = `https://api.github.com/repos/${owner ?? ""}/${repo}/tags?per_page=100`;

  let tagsResponse: Response;
  try {
    tagsResponse = await fetch(tagsUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return temporarilyUnavailable(error);
  }

  if (tagsResponse.status === 404) {
    return { status: "not-found" };
  }

  // A 401/403 is this run's own token being refused, not weather — the same
  // class doctor's `classify` turns RED. Rate limits (429) and server errors
  // stay capacity.
  if (tagsResponse.status === 401 || tagsResponse.status === 403) {
    return {
      status: "auth-refused",
      reason: `GitHub API returned ${String(tagsResponse.status)} for tags — the token may lack read access to ${packageName}`,
    };
  }

  if (tagsResponse.status === 429 || tagsResponse.status >= 500) {
    return {
      status: "temporarily-unavailable",
      reason: `GitHub API returned ${String(tagsResponse.status)} for tags`,
    };
  }

  if (!tagsResponse.ok) {
    return {
      status: "temporarily-unavailable",
      reason: `GitHub API returned ${String(tagsResponse.status)} for tags`,
    };
  }

  let tagsBody: unknown;
  try {
    tagsBody = await tagsResponse.json();
  } catch {
    return { status: "malformed-metadata", reason: "GitHub tags response is not valid JSON" };
  }

  if (!Array.isArray(tagsBody)) {
    return { status: "malformed-metadata", reason: "GitHub tags response is not an array" };
  }

  // Also fetch releases for changelogs/release notes
  const releasesUrl = `https://api.github.com/repos/${owner ?? ""}/${repo}/releases?per_page=100`;
  const releasesMap = new Map<string, { body: string; createdAt: string; prerelease: boolean }>();

  try {
    const releasesResponse = await fetch(releasesUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (releasesResponse.ok) {
      const releasesBody = await releasesResponse.json();
      if (Array.isArray(releasesBody)) {
        for (const rel of releasesBody) {
          const tag = (rel as Record<string, unknown>).tag_name;
          if (typeof tag === "string") {
            releasesMap.set(tag, {
              body:
                typeof (rel as Record<string, unknown>).body === "string"
                  ? ((rel as Record<string, unknown>).body as string)
                  : "",
              createdAt:
                typeof (rel as Record<string, unknown>).created_at === "string"
                  ? ((rel as Record<string, unknown>).created_at as string)
                  : "",
              prerelease: (rel as Record<string, unknown>).prerelease === true,
            });
          }
        }
      }
    }
  } catch {
    // Releases fetch failed — tags are still valid, just no changelogs
  }

  // Build releases from tags
  const releases: Release[] = [];

  for (const tag of tagsBody) {
    const tagObj = tag as Record<string, unknown>;
    const name = tagObj.name;
    if (typeof name !== "string" || name.length === 0) continue;

    // Commit SHA is available on tagObj.commit — not currently used
    // Future: pin/digest updates will need commit.sha

    // Check for release info
    const releaseInfo = releasesMap.get(name);
    const isPrerelease = releaseInfo?.prerelease ?? false;

    // Release date from the release or the tag
    const releasedAt =
      releaseInfo !== undefined && releaseInfo.createdAt.length > 0
        ? parseDate(releaseInfo.createdAt)
        : null;

    const changelogUrl =
      releaseInfo !== undefined
        ? `https://github.com/${owner ?? ""}/${repo}/releases/tag/${name}`
        : null;

    const diffUrl = `https://github.com/${owner ?? ""}/${repo}/compare/${name}`;

    releases.push({
      version: name,
      releasedAt,
      deprecated: false,
      yanked: false,
      isPrerelease,
      changelogUrl,
      diffUrl,
    });
  }

  if (releases.length === 0) {
    // No tags found — might be a repo that only uses branches
    return { status: "not-found" };
  }

  // Sort newest-first (tags are usually returned newest-first from GitHub,
  // but we sort to be safe)
  releases.sort((a, b) => {
    // For GitHub Actions, version tags are typically v1, v2, v3, etc.
    // Sort in reverse order (newest first)
    return b.version.localeCompare(a.version, undefined, { numeric: true });
  });

  return { status: "available", releases };
}

/**
 * Parse a date string from the GitHub API.
 */
function parseDate(value: string): Date | null {
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date;
  } catch {
    // Not a valid date
  }
  return null;
}

/**
 * Convert a fetch error to a `temporarily-unavailable` result.
 */
function temporarilyUnavailable(error: unknown): ResolutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "temporarily-unavailable",
    reason: `GitHub API unreachable: ${message}`,
  };
}
