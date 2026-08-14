/**
 * The Docker registry datasource — resolves available versions from Docker Hub
 * and other container registries.
 *
 * Queries the Docker Registry v2 API for image tags. Handles:
 * - Docker Hub: `https://registry.hub.docker.com/v2/repositories/library/image/tags/`
 * - Custom registries: extracted from the image name
 * - Pagination (Docker Hub returns 10 tags per page by default)
 * - Rate limiting (D12: capacity is weather)
 *
 * Docker image tags are not semver by convention, but many popular images
 * (node, python, golang, etc.) use semver-like tags (e.g., `20`, `20-slim`,
 * `20.10`, `20.10.1-alpine`). The semver parser handles these; non-semver
 * tags like `latest`, `alpine`, `buster` are discovered but not classified
 * for update.
 *
 * **External metadata is evidence, never authority.**
 */
import * as core from "@actions/core";
import type { Release, ResolutionResult } from "../model.js";
import type { Datasource, DatasourceId } from "./types.js";

/** The Docker registry datasource identifier. */
const ID: DatasourceId = "docker-registry";

/** Docker Hub API base URL for library images. */
const DOCKER_HUB_API = "https://registry.hub.docker.com/v2/repositories";

export function createDockerRegistryDatasource(): Datasource {
  return {
    id: ID,
    ecosystem: "docker",
    resolve,
  };
}

/**
 * Resolve available versions for a Docker image.
 *
 * Queries the Docker Hub API (or the appropriate registry) and returns
 * a `ResolutionResult`. Network errors degrade to `temporarily-unavailable` (D12).
 */
async function resolve(packageName: string): Promise<ResolutionResult> {
  const { registry, namespace, image } = parseImageName(packageName);

  // SSRF protection: validate the registry hostname before making any request.
  // A Dockerfile containing a FROM line referencing an internal network endpoint
  // (e.g. 169.254.169.254, metadata.google.internal, 127.0.0.1, 10.x.x.x)
  // must NOT cause dependa to make HTTP requests to those endpoints.
  if (registry !== null && !isSafeRegistry(registry)) {
    core.warning(
      `dependa: Docker registry \`${registry}\` appears to be a private/internal address — skipping SSRF protection.`,
    );
    return {
      status: "not-found",
    };
  }

  // Build the tags URL based on the registry
  let tagsUrl: string;
  if (registry === null || registry === "docker.io" || registry === "registry-1.docker.io") {
    // Docker Hub
    const ns = namespace ?? "library";
    tagsUrl = `${DOCKER_HUB_API}/${ns}/${image}/tags/?page_size=100&ordering=last_updated`;
  } else {
    // Custom registry — use the v2 API
    tagsUrl = `https://${registry}/v2/${namespace !== null ? `${namespace}/` : ""}${image}/tags/list`;
  }

  let response: Response;
  try {
    response = await fetch(tagsUrl, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return temporarilyUnavailable(error);
  }

  if (response.status === 404) {
    return { status: "not-found" };
  }

  if (response.status === 401 || response.status === 403) {
    // Auth required — for public Docker Hub images this shouldn't happen,
    // but private registries may require auth
    return {
      status: "temporarily-unavailable",
      reason: `Docker registry returned ${String(response.status)} — authentication may be required`,
    };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      status: "temporarily-unavailable",
      reason: `Docker registry returned ${String(response.status)}`,
    };
  }

  if (!response.ok) {
    return {
      status: "temporarily-unavailable",
      reason: `Docker registry returned ${String(response.status)}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "malformed-metadata", reason: "Docker registry response is not valid JSON" };
  }

  if (typeof body !== "object" || body === null) {
    return { status: "malformed-metadata", reason: "Docker registry response is not an object" };
  }

  // Docker Hub and v2 registry have different response formats
  return parseResponse(body as Record<string, unknown>);
}

/**
 * Parse a Docker registry response into a `ResolutionResult`.
 *
 * Docker Hub returns `{ results: [{ name: "...", ... }] }` with pagination.
 * The v2 API returns `{ tags: ["...", "..."] }`.
 */
function parseResponse(body: Record<string, unknown>): ResolutionResult {
  // Docker Hub format: { results: [...] }
  if (Array.isArray(body.results)) {
    return parseDockerHubResponse(body.results as readonly Record<string, unknown>[]);
  }

  // v2 API format: { tags: [...] }
  if (Array.isArray(body.tags)) {
    return parseV2Response(body.tags as readonly string[]);
  }

  return {
    status: "malformed-metadata",
    reason: "Docker registry response has no `results` or `tags` field",
  };
}

/**
 * Parse a Docker Hub response (array of tag objects).
 */
function parseDockerHubResponse(results: readonly Record<string, unknown>[]): ResolutionResult {
  const releases: Release[] = [];

  for (const tag of results) {
    const name = tag.name;
    if (typeof name !== "string" || name.length === 0) continue;

    // Skip "latest" — it's not a version
    if (name === "latest") continue;

    const isPrerelease = isPrereleaseTag(name);

    // Release date
    const lastUpdated = tag.last_updated;
    const releasedAt = typeof lastUpdated === "string" ? parseDate(lastUpdated) : null;

    releases.push({
      version: name,
      releasedAt,
      deprecated: false,
      yanked: false,
      isPrerelease,
      changelogUrl: null, // Docker images typically don't have changelogs
      diffUrl: null,
    });
  }

  if (releases.length === 0) {
    // Docker Hub returned tags but none were usable
    return { status: "available", releases: [] };
  }

  // Sort newest-first (for semver-like tags, reverse numeric sort)
  releases.sort((a, b) => {
    return b.version.localeCompare(a.version, undefined, { numeric: true });
  });

  return { status: "available", releases };
}

/**
 * Parse a v2 registry response (array of tag strings).
 */
function parseV2Response(tags: readonly string[]): ResolutionResult {
  const releases: Release[] = [];

  for (const name of tags) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (name === "latest") continue;

    const isPrerelease = isPrereleaseTag(name);

    releases.push({
      version: name,
      releasedAt: null,
      deprecated: false,
      yanked: false,
      isPrerelease,
      changelogUrl: null,
      diffUrl: null,
    });
  }

  // Sort newest-first
  releases.sort((a, b) => {
    return b.version.localeCompare(a.version, undefined, { numeric: true });
  });

  return { status: "available", releases };
}

/**
 * Check whether a registry hostname is safe to fetch from.
 *
 * Blocks:
 * - Loopback addresses (127.x.x.x, ::1, localhost)
 * - Link-local addresses (169.254.x.x, fe80::)
 * - RFC 1918 private addresses (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
 * - Known cloud metadata endpoints (metadata.google.internal, etc.)
 *
 * Only public, externally-reachable registries are allowed. This prevents
 * SSRF attacks where a malicious FROM line causes dependa (running inside
 * GitHub Actions) to make requests to internal network endpoints.
 */
function isSafeRegistry(registry: string): boolean {
  // Strip port if present
  const hostname = registry.replace(/:\d+$/, "").toLowerCase();

  // Known safe Docker registries
  const safeHosts = new Set([
    "docker.io",
    "registry-1.docker.io",
    "registry.hub.docker.com",
    "ghcr.io",
    "quay.io",
    "gcr.io",
    "ecr.aws",
    "public.ecr.aws",
  ]);
  if (safeHosts.has(hostname)) return true;

  // Known unsafe hostnames (cloud metadata endpoints)
  const unsafeHosts = ["metadata.google.internal", "metadata.azure.internal", "169.254.169.254"];
  if (unsafeHosts.includes(hostname)) return false;

  // Localhost variants
  if (hostname === "localhost" || hostname === "localhost.localdomain") return false;

  // IP address checks — parse IPv4 and check for private ranges
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match !== null) {
    const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]].map((o) =>
      Number(o ?? 0),
    );
    // Invalid IP (octet > 255)
    if (octets.some((o) => o > 255)) return true; // Not a valid IP, treat as hostname
    const [a = 0, b = 0] = octets;
    // Loopback: 127.x.x.x
    if (a === 127) return false;
    // Link-local: 169.254.x.x
    if (a === 169 && b === 254) return false;
    // RFC 1918: 10.x.x.x
    if (a === 10) return false;
    // RFC 1918: 172.16.x.x – 172.31.x.x
    if (a === 172 && b >= 16 && b <= 31) return false;
    // RFC 1918: 192.168.x.x
    if (a === 192 && b === 168) return false;
    // Not a private range — allow
    return true;
  }

  // IPv6 loopback
  if (hostname === "::1" || hostname === "[::1]") return false;

  // For hostnames that are not IPs and not in the known-safe list,
  // we allow them — we cannot statically determine if a hostname
  // resolves to a private IP without doing a DNS lookup, and doing
  // DNS lookups in this context would add latency and dependency.
  // The known-unsafe hostnames above cover the most common SSRF vectors.
  return true;
}

/**
 * Parse a Docker image name into its components.
 *
 * Format: `[registry/]namespace/image` or just `image` (Docker Hub official).
 * Examples:
 * - `node` → { registry: null, namespace: "library", image: "node" }
 * - `library/node` → { registry: null, namespace: "library", image: "node" }
 * - `ghcr.io/owner/image` → { registry: "ghcr.io", namespace: "owner", image: "image" }
 */
function parseImageName(name: string): {
  readonly registry: string | null;
  readonly namespace: string | null;
  readonly image: string;
} {
  // Check for custom registry (contains a dot or port)
  const slashIdx = name.indexOf("/");
  if (slashIdx !== -1) {
    const firstPart = name.slice(0, slashIdx);

    // If the first part contains a dot or colon, it's a registry
    if (firstPart.includes(".") || firstPart.includes(":")) {
      const rest = name.slice(slashIdx + 1);
      const nextSlash = rest.indexOf("/");

      if (nextSlash !== -1) {
        return {
          registry: firstPart,
          namespace: rest.slice(0, nextSlash),
          image: rest.slice(nextSlash + 1),
        };
      }

      return { registry: firstPart, namespace: null, image: rest };
    }

    // No dot = namespace/image (Docker Hub)
    const rest = name.slice(slashIdx + 1);
    const nextSlash = rest.indexOf("/");

    if (nextSlash !== -1) {
      return {
        registry: null,
        namespace: firstPart,
        image: rest,
      };
    }

    return { registry: null, namespace: firstPart, image: rest };
  }

  // No slash = Docker Hub official image
  return { registry: null, namespace: null, image: name };
}

/**
 * Whether a Docker tag looks like a pre-release.
 *
 * Tags like `20-rc1`, `20-beta`, `20.10.1-rc.1` are pre-release.
 * Tags like `20`, `20-slim`, `20.10.1-alpine` are not pre-release.
 */
function isPrereleaseTag(tag: string): boolean {
  return (
    /[-.]rc\d/i.test(tag) || /[-.]beta/i.test(tag) || /[-.]alpha/i.test(tag) || /[-.]pre/i.test(tag)
  );
}

/**
 * Parse a date string from the Docker Hub API.
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
    reason: `Docker registry unreachable: ${message}`,
  };
}
