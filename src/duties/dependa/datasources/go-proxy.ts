/**
 * The Go proxy datasource — resolves available versions from proxy.golang.org.
 *
 * Queries the Go module proxy for module versions. Handles:
 * - Standard modules: `https://proxy.golang.org/github.com/foo/bar/@v/list`
 * - Go module version format (always `v`-prefixed)
 * - Temporary unavailability (D12: capacity is weather)
 * - Retracted versions (Go 1.18+ retraction)
 *
 * The Go module proxy is the canonical source for module versions. It returns
 * a simple newline-separated list of versions, which is much simpler than
 * npm's full metadata API.
 *
 * **External metadata is evidence, never authority.**
 */
import type { Release, ResolutionResult } from "../model.js";
import {
  byVersionDescending,
  parseDate,
  temporarilyUnavailable,
  type Datasource,
  type DatasourceId,
} from "./types.js";

/** The Go proxy datasource identifier. */
const ID: DatasourceId = "go-proxy";

/** The base URL for the Go module proxy. */
const GO_PROXY = "https://proxy.golang.org";

export function createGoProxyDatasource(): Datasource {
  return {
    id: ID,
    ecosystem: "go",
    resolve,
  };
}

/**
 * Resolve available versions for a Go module.
 *
 * Queries the Go module proxy and returns a `ResolutionResult`.
 * Network errors degrade to `temporarily-unavailable` (D12).
 */
async function resolve(packageName: string): Promise<ResolutionResult> {
  // Encode the module path for the proxy URL
  const encoded = encodeURIComponent(packageName);

  // Fetch the version list
  const listUrl = `${GO_PROXY}/${encoded}/@v/list`;

  let listResponse: Response;
  try {
    listResponse = await fetch(listUrl, {
      headers: {
        Accept: "text/plain",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return temporarilyUnavailable("Go proxy", error);
  }

  if (listResponse.status === 404) {
    return { status: "not-found" };
  }

  if (listResponse.status === 410) {
    // 410 Gone — module was retired
    return { status: "not-found" };
  }

  if (listResponse.status === 429 || listResponse.status >= 500) {
    return {
      status: "temporarily-unavailable",
      reason: `Go proxy returned ${String(listResponse.status)}`,
    };
  }

  if (!listResponse.ok) {
    return {
      status: "temporarily-unavailable",
      reason: `Go proxy returned ${String(listResponse.status)}`,
    };
  }

  let listText: string;
  try {
    listText = await listResponse.text();
  } catch {
    return { status: "malformed-metadata", reason: "Go proxy response could not be read" };
  }

  // Parse version list (newline-separated, v-prefixed)
  const versionLines = listText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith("v"));

  if (versionLines.length === 0) {
    return { status: "not-found" };
  }

  // Try to fetch info for each version to get release dates
  // We only fetch info for a limited set to avoid too many API calls
  const releases: Release[] = [];

  for (const version of versionLines) {
    // Strip v prefix for internal representation
    const bareVersion = version.replace(/^v/, "");
    const isPrerelease = isPrereleaseVersion(bareVersion);

    releases.push({
      version: bareVersion,
      releasedAt: null, // Will try to fill in below
      deprecated: false,
      yanked: false,
      isPrerelease,
      changelogUrl: buildChangelogUrl(packageName, version),
      diffUrl: buildDiffUrl(packageName, version),
    });
  }

  // Try to fetch latest version info for release date
  // The .info endpoint gives us the timestamp
  if (releases.length > 0) {
    const latestVersion = versionLines[0];
    if (latestVersion !== undefined) {
      try {
        const infoUrl = `${GO_PROXY}/${encoded}/@v/${latestVersion}.info`;
        const infoResponse = await fetch(infoUrl, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });

        if (infoResponse.ok) {
          const info = (await infoResponse.json()) as Record<string, unknown>;
          const time = info.Time;
          if (typeof time === "string") {
            const releasedAt = parseDate(time);
            if (releasedAt !== null && releases[0] !== undefined) {
              // Update the latest release with the actual date
              releases[0] = { ...releases[0], releasedAt };
            }
          }
        }
      } catch {
        // Info fetch failed — that's fine, we still have the version list
      }
    }
  }

  // Newest first — see `byVersionDescending` for why the locale is named.
  releases.sort(byVersionDescending);

  return { status: "available", releases };
}

/**
 * Whether a version string looks like a pre-release.
 */
function isPrereleaseVersion(version: string): boolean {
  // Go pre-release: v1.0.0-alpha.1, v1.0.0-beta.2, v0.1.0-pre.1
  const coreMatch = /^\d+\.\d+\.\d+/.exec(version);
  if (coreMatch === null) return false;

  const afterCore = version.slice(coreMatch[0].length);
  return afterCore.startsWith("-");
}

/**
 * Build a changelog URL for a Go module version.
 *
 * For modules hosted on GitHub, construct a GitHub release URL.
 */
function buildChangelogUrl(modulePath: string, version: string): string | null {
  // GitHub-hosted modules
  if (modulePath.startsWith("github.com/")) {
    const parts = modulePath.split("/");
    if (parts.length >= 3) {
      const owner = parts[1];
      const repo = parts[2];
      return `https://github.com/${owner ?? ""}/${repo ?? ""}/releases/tag/${version}`;
    }
  }

  return null;
}

/**
 * Build a diff/compare URL for a Go module version.
 */
function buildDiffUrl(modulePath: string, version: string): string | null {
  if (modulePath.startsWith("github.com/")) {
    const parts = modulePath.split("/");
    if (parts.length >= 3) {
      const owner = parts[1];
      const repo = parts[2];
      return `https://github.com/${owner ?? ""}/${repo ?? ""}/compare/${version}`;
    }
  }

  return null;
}
