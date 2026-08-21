/**
 * The crates.io datasource — resolves available versions from the crates.io API.
 *
 * Queries the crates.io API for crate metadata. Handles:
 * - Standard crates: `https://crates.io/api/v1/crates/serde`
 * - Rate limiting (crates.io has a 1-request/second limit)
 * - Yanked versions (crates.io marks them)
 * - Temporary unavailability (D12: capacity is weather)
 *
 * **External metadata is evidence, never authority.** A crate's yanked flag
 * is evidence that a version should not be used, but it does not force
 * dependa to skip it — the policy decides.
 */
import type { Release, ResolutionResult } from "../model.js";
import { byVersionDescending, type Datasource, type DatasourceId } from "./types.js";

/** The crates.io datasource identifier. */
const ID: DatasourceId = "crates";

/** The base URL for the crates.io API. */
const CRATES_API = "https://crates.io/api/v1/crates";

export function createCratesDatasource(): Datasource {
  return {
    id: ID,
    ecosystem: "cargo",
    resolve,
  };
}

/**
 * Resolve available versions for a crate.
 *
 * Queries the crates.io API and returns a `ResolutionResult`.
 * Network errors degrade to `temporarily-unavailable` (D12).
 */
async function resolve(packageName: string): Promise<ResolutionResult> {
  const url = `${CRATES_API}/${encodeURIComponent(packageName)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        // crates.io requires a User-Agent header
        "User-Agent": "reeve-dependa (https://github.com/ecoma-io/reeve)",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return temporarilyUnavailable(error);
  }

  if (response.status === 404) {
    return { status: "not-found" };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      status: "temporarily-unavailable",
      reason: `crates.io returned ${String(response.status)}`,
    };
  }

  if (!response.ok) {
    return {
      status: "temporarily-unavailable",
      reason: `crates.io returned ${String(response.status)}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "malformed-metadata", reason: "crates.io response is not valid JSON" };
  }

  if (typeof body !== "object" || body === null) {
    return { status: "malformed-metadata", reason: "crates.io response is not an object" };
  }

  return parseCratesResponse(body as Record<string, unknown>);
}

/**
 * Parse the crates.io API response into a `ResolutionResult`.
 */
function parseCratesResponse(body: Record<string, unknown>): ResolutionResult {
  const crate = body.crate;
  if (typeof crate !== "object" || crate === null) {
    return { status: "malformed-metadata", reason: "crates.io response has no `crate` field" };
  }

  const crateObj = crate as Record<string, unknown>;

  // Extract versions array
  const versions = body.versions;
  if (!Array.isArray(versions)) {
    return { status: "malformed-metadata", reason: "crates.io response has no `versions` array" };
  }

  // Extract repository URL for changelogs
  const repository = crateObj.repository;
  const homepage = crateObj.homepage;
  const githubUrl = extractGithubUrl(
    typeof repository === "string" ? repository : null,
    typeof homepage === "string" ? homepage : null,
  );

  // Build releases
  const releases: Release[] = [];

  for (const ver of versions) {
    if (typeof ver !== "object" || ver === null) continue;

    const v = ver as Record<string, unknown>;

    const num = v.num;
    if (typeof num !== "string" || num.length === 0) continue;

    const yanked = v.yanked === true;
    const isPrerelease = isPrereleaseVersion(num);

    // Release date
    const createdAt = v.created_at;
    const releasedAt = typeof createdAt === "string" ? parseDate(createdAt) : null;

    // Changelog/release notes URLs
    const changelogUrl = githubUrl !== null ? `${githubUrl}/releases/tag/v${num}` : null;
    const diffUrl = githubUrl !== null ? `${githubUrl}/compare/v${num}` : null;

    releases.push({
      version: num,
      releasedAt,
      deprecated: false, // crates.io doesn't have per-version deprecation
      yanked,
      isPrerelease,
      changelogUrl,
      diffUrl,
    });
  }

  if (releases.length === 0) {
    return { status: "malformed-metadata", reason: "crates.io response has no valid versions" };
  }

  // Newest first — see `byVersionDescending` for why the locale is named.
  releases.sort(byVersionDescending);

  return { status: "available", releases };
}

/**
 * Whether a version string looks like a pre-release.
 */
function isPrereleaseVersion(version: string): boolean {
  // Pre-release versions in Cargo: 1.0.0-alpha.1, 1.0.0-beta.2, 0.1.0-pre.1
  const coreMatch = /^\d+\.\d+\.\d+/.exec(version);
  if (coreMatch === null) return false;

  const afterCore = version.slice(coreMatch[0].length);
  return afterCore.startsWith("-");
}

/**
 * Parse a date string from the crates.io API.
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
 * Extract a GitHub URL from repository/homepage fields.
 */
function extractGithubUrl(repository: string | null, homepage: string | null): string | null {
  for (const url of [repository, homepage]) {
    if (url === null) continue;

    const match = /(https:\/\/github\.com\/[^/]+\/[^/\s]+)/.exec(url);
    if (match !== null) {
      return (match[1] ?? "").replace(/\.git$/, "");
    }
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
    reason: `crates.io unreachable: ${message}`,
  };
}
