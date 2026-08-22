/**
 * The npm datasource — resolves available versions from the npm registry.
 *
 * Queries the npm registry API for package metadata. Handles:
 * - Standard packages: `https://registry.npmjs.org/package-name`
 * - Scoped packages: `https://registry.npmjs.org/@scope%2Fpackage-name`
 * - Rate limiting and temporary unavailability (D12: capacity is weather)
 * - Malformed registry responses (degraded to `malformed-metadata`)
 *
 * The npm registry returns all versions in the `versions` field, along with
 * `time` (release dates) and `deprecated` flags per version. This datasource
 * maps those into `Release` objects.
 *
 * **External metadata is evidence, never authority.** A package's `deprecated`
 * flag is evidence that an update is important, but it does not force dependa
 * to propose it — the policy decides.
 */
import type { Release, ResolutionResult } from "../model.js";
import {
  byVersionDescending,
  parseDate,
  temporarilyUnavailable,
  type Datasource,
  type DatasourceId,
} from "./types.js";

/** The npm datasource identifier. */
const ID: DatasourceId = "npm";

/** The base URL for the npm registry. */
const NPM_REGISTRY = "https://registry.npmjs.org";

export function createNpmDatasource(): Datasource {
  return {
    id: ID,
    ecosystem: "npm",
    resolve,
  };
}

/**
 * Resolve available versions for an npm package.
 *
 * Queries the npm registry and returns a `ResolutionResult`.
 * Network errors degrade to `temporarily-unavailable` (D12).
 */
async function resolve(packageName: string): Promise<ResolutionResult> {
  // Build the registry URL — scoped packages need URL-encoded slashes
  const encodedName = packageName.startsWith("@")
    ? packageName.replaceAll("/", "%2F")
    : packageName;
  const url = `${NPM_REGISTRY}/${encodedName}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });
  } catch (error) {
    return temporarilyUnavailable("npm registry", error);
  }

  if (response.status === 404) {
    return { status: "not-found" };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      status: "temporarily-unavailable",
      reason: `npm registry returned ${String(response.status)}`,
    };
  }

  if (!response.ok) {
    return {
      status: "temporarily-unavailable",
      reason: `npm registry returned ${String(response.status)}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "malformed-metadata", reason: "npm registry response is not valid JSON" };
  }

  if (typeof body !== "object" || body === null) {
    return { status: "malformed-metadata", reason: "npm registry response is not an object" };
  }

  return parseRegistryResponse(body as Record<string, unknown>);
}

/**
 * Parse the npm registry response into a `ResolutionResult`.
 */
function parseRegistryResponse(body: Record<string, unknown>): ResolutionResult {
  // Extract versions map.
  //
  // `Array.isArray` beside the `typeof` check, because an array IS an object
  // to `typeof` and this map is read with `Object.entries` — so a `versions`
  // that arrived as `["1.0.0", "2.0.0"]` would yield releases named after the
  // array INDICES and report them as `available`. A fabricated version number
  // delivered confidently as an available upgrade is a wrong answer, not a
  // degraded one; malformed upstream data has a status of its own to come
  // back as.
  const versions = body.versions;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) {
    return {
      status: "malformed-metadata",
      reason: "npm registry response has no usable `versions` map",
    };
  }

  // Extract time map (release dates)
  const time =
    typeof body.time === "object" && body.time !== null
      ? (body.time as Record<string, string>)
      : {};

  // Extract dist-tags (e.g. latest, next, beta) — available for future use

  // Build releases from the versions map
  const releases: Release[] = [];

  const versionMap = versions as Record<string, Record<string, unknown>>;
  for (const [version, info] of Object.entries(versionMap)) {
    // Skip if version doesn't look like a version
    if (version.trim().length === 0) continue;

    const isDeprecated = info.deprecated !== undefined && info.deprecated !== false;
    const isPrerelease = isPrereleaseVersion(version);

    // Release date from the time map
    const timeEntry = time[version];
    const releasedAt = parseDate(timeEntry);

    // Changelog/release notes URLs
    const repository = info.repository;
    const homepage = info.homepage;
    const changelogUrl = extractChangelogUrl(repository, homepage, version);
    const diffUrl = extractDiffUrl(repository, version);

    releases.push({
      version,
      releasedAt,
      deprecated: typeof isDeprecated === "string" || isDeprecated,
      yanked: false, // npm doesn't have yanked versions
      isPrerelease,
      changelogUrl,
      diffUrl,
    });
  }

  if (releases.length === 0) {
    return { status: "malformed-metadata", reason: "npm registry response has no valid versions" };
  }

  // Newest first — see `byVersionDescending` for why the locale is named.
  releases.sort(byVersionDescending);

  return { status: "available", releases };
}

/**
 * Whether a version string looks like a pre-release.
 */
function isPrereleaseVersion(version: string): boolean {
  // Pre-release versions have a hyphen after the core: 1.0.0-beta.1
  const coreMatch = /^\d+\.\d+\.\d+/.exec(version);
  if (coreMatch === null) return false;

  const afterCore = version.slice(coreMatch[0].length);
  return afterCore.startsWith("-");
}

/**
 * Extract a changelog URL from repository/homepage metadata.
 *
 * Looks for GitHub repositories and constructs a GitHub release URL.
 */
function extractChangelogUrl(
  repository: unknown,
  homepage: unknown,
  _version: string,
): string | null {
  // Try repository field
  if (typeof repository === "object" && repository !== null) {
    const repo = repository as Record<string, unknown>;
    const url = repo.url;
    if (typeof url === "string") {
      const githubUrl = extractGithubUrl(url);
      if (githubUrl !== null) return `${githubUrl}/releases`;
    }
  }

  // Try string repository
  if (typeof repository === "string") {
    const githubUrl = extractGithubUrl(repository);
    if (githubUrl !== null) return `${githubUrl}/releases`;
  }

  // Try homepage
  if (typeof homepage === "string") {
    const githubUrl = extractGithubUrl(homepage);
    if (githubUrl !== null) return `${githubUrl}/releases`;
  }

  return null;
}

/**
 * Extract a diff/compare URL from repository metadata.
 */
function extractDiffUrl(repository: unknown, _version: string): string | null {
  if (typeof repository === "object" && repository !== null) {
    const repo = repository as Record<string, unknown>;
    const url = repo.url;
    if (typeof url === "string") {
      const githubUrl = extractGithubUrl(url);
      if (githubUrl !== null) return `${githubUrl}/compare`;
    }
  }

  if (typeof repository === "string") {
    const githubUrl = extractGithubUrl(repository);
    if (githubUrl !== null) return `${githubUrl}/compare`;
  }

  return null;
}

/**
 * Extract a clean GitHub URL from various npm repository URL formats.
 *
 * Handles:
 * - `https://github.com/owner/repo`
 * - `git+https://github.com/owner/repo.git`
 * - `git://github.com/owner/repo.git`
 * - `github:owner/repo`
 */
function extractGithubUrl(raw: string): string | null {
  // git+https:// or git:// prefix
  const httpsMatch = /(?:git\+?|git:\/\/)(https:\/\/github\.com\/[^/]+\/[^/\s]+)/.exec(raw);
  if (httpsMatch?.[1]) {
    return httpsMatch[1].replace(/\.git$/, "");
  }

  // Direct HTTPS
  const directMatch = /(https:\/\/github\.com\/[^/]+\/[^/\s]+)/.exec(raw);
  if (directMatch?.[1]) {
    return directMatch[1].replace(/\.git$/, "");
  }

  // GitHub shorthand
  const shorthandMatch = /^github:([^/]+\/[^/\s]+)/.exec(raw);
  if (shorthandMatch !== null) {
    return `https://github.com/${shorthandMatch[1] ?? ""}`;
  }

  return null;
}
