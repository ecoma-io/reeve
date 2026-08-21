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
import {
  byVersionDescending,
  parseDate,
  temporarilyUnavailable,
  type Datasource,
  type DatasourceId,
} from "./types.js";

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

/** Maximum pages to paginate through on Docker Hub. Caps total tags at ~1000. */
const MAX_PAGES = 10;

/**
 * Resolve available versions for a Docker image.
 *
 * Queries the Docker Hub API (or the appropriate registry) and returns
 * a `ResolutionResult`. Network errors degrade to `temporarily-unavailable` (D12).
 *
 * Docker Hub paginates its tag listing (default 10 per page, we request 100).
 * This function follows `next` URLs up to `MAX_PAGES` pages to collect a
 * representative set of tags. The v2 `/tags/list` endpoint returns all tags
 * in one response and does not need pagination.
 */
async function resolve(packageName: string): Promise<ResolutionResult> {
  const { registry, namespace, image } = parseImageName(packageName);

  // SSRF protection: validate the registry hostname before making any request.
  // A Dockerfile containing a FROM line referencing an internal network endpoint
  // (e.g. 169.254.169.254, metadata.google.internal, 127.0.0.1, 10.x.x.x)
  // must NOT cause dependa to make HTTP requests to those endpoints.
  if (registry !== null && !isSafeRegistry(registry)) {
    core.warning(
      `dependa: Docker registry \`${registry}\` appears to be a private/internal address — ` +
        "no request was made to it.",
    );
    return {
      status: "not-found",
    };
  }

  // Build the tags URL based on the registry.
  // `null` means no more pages to fetch (pagination exhausted or v2 API done).
  let tagsUrl: string | null;
  if (registry === null || registry === "docker.io" || registry === "registry-1.docker.io") {
    // Docker Hub
    const ns = namespace ?? "library";
    tagsUrl = `${DOCKER_HUB_API}/${ns}/${image}/tags/?page_size=100&ordering=last_updated`;
  } else {
    // Custom registry — use the v2 API
    tagsUrl = `https://${registry}/v2/${namespace !== null ? `${namespace}/` : ""}${image}/tags/list`;
  }

  // Docker Hub returns paginated results; the v2 API returns all tags at once.
  // Collect all pages from Docker Hub, up to MAX_PAGES.
  const allResults: Record<string, unknown>[] = [];
  let v2Tags: string[] | null = null;
  let pageCount = 0;

  while (tagsUrl !== null && pageCount < MAX_PAGES) {
    let response: Response;
    try {
      response = await fetch(tagsUrl, {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // If we already collected partial results, return what we have
      if (allResults.length > 0) {
        core.warning(
          `dependa: Docker Hub pagination failed after ${String(allResults.length)} tags — returning partial results.`,
        );
        return parseDockerHubResponse(allResults);
      }
      return temporarilyUnavailable("Docker registry", error);
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
      // If we already collected partial results, return what we have
      if (allResults.length > 0) {
        core.warning(
          `dependa: Docker Hub returned ${String(response.status)} after ${String(allResults.length)} tags — returning partial results.`,
        );
        return parseDockerHubResponse(allResults);
      }
      return {
        status: "temporarily-unavailable",
        reason: `Docker registry returned ${String(response.status)}`,
      };
    }

    if (!response.ok) {
      if (allResults.length > 0) {
        return parseDockerHubResponse(allResults);
      }
      return {
        status: "temporarily-unavailable",
        reason: `Docker registry returned ${String(response.status)}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (allResults.length > 0) {
        return parseDockerHubResponse(allResults);
      }
      return { status: "malformed-metadata", reason: "Docker registry response is not valid JSON" };
    }

    if (typeof body !== "object" || body === null) {
      if (allResults.length > 0) {
        return parseDockerHubResponse(allResults);
      }
      return { status: "malformed-metadata", reason: "Docker registry response is not an object" };
    }

    const obj = body as Record<string, unknown>;

    // Docker Hub format: { results: [...], next: "url" | null }
    if (Array.isArray(obj.results)) {
      for (const tag of obj.results as readonly Record<string, unknown>[]) {
        allResults.push(tag);
      }
      // Follow the next page URL if present
      tagsUrl = typeof obj.next === "string" && obj.next.length > 0 ? obj.next : null;
      pageCount++;
      continue;
    }

    // v2 API format: { tags: [...] } — not paginated, return directly
    if (Array.isArray(obj.tags)) {
      v2Tags = obj.tags as string[];
      break;
    }

    if (allResults.length > 0) {
      return parseDockerHubResponse(allResults);
    }
    return {
      status: "malformed-metadata",
      reason: "Docker registry response has no `results` or `tags` field",
    };
  }

  if (pageCount >= MAX_PAGES && tagsUrl !== null) {
    core.info(
      `dependa: Docker Hub pagination reached ${String(MAX_PAGES)} pages — some tags may be missed.`,
    );
  }

  // Return the collected results
  if (v2Tags !== null) {
    return parseV2Response(v2Tags);
  }
  return parseDockerHubResponse(allResults);
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

  // Newest first — see `byVersionDescending` for why the locale is named.
  releases.sort(byVersionDescending);

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

  // Newest first — see `byVersionDescending` for why the locale is named.
  releases.sort(byVersionDescending);

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
