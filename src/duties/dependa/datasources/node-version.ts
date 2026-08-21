/**
 * The node-version datasource — resolves available Node.js runtime versions.
 *
 * Queries the Node release index at `https://nodejs.org/dist/index.json`,
 * which lists every release newest-first with its publication date. No
 * authentication, no pagination — one request answers everything.
 *
 * Only the package name `node` is served: the ecosystem has exactly one
 * package, the runtime itself. Any other name is `not-found` rather than
 * guessed at.
 *
 * Network errors degrade to `temporarily-unavailable` (D12: capacity is
 * weather, never a failure).
 */
import type { Release, ResolutionResult } from "../model.js";
import type { Datasource, DatasourceId } from "./types.js";

/** The node-version datasource identifier. */
const ID: DatasourceId = "node-version";

/** The Node release index — every release, newest first. */
const RELEASE_INDEX_URL = "https://nodejs.org/dist/index.json";

export function createNodeVersionDatasource(): Datasource {
  return {
    id: ID,
    ecosystem: "node-version",
    resolve,
  };
}

/** One entry of the Node release index, as far as this datasource reads it. */
interface NodeIndexEntry {
  readonly version?: unknown;
  readonly date?: unknown;
}

async function resolve(packageName: string): Promise<ResolutionResult> {
  // The ecosystem has one package: the runtime itself.
  if (packageName !== "node") {
    return { status: "not-found" };
  }

  let response: Response;
  try {
    response = await fetch(RELEASE_INDEX_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return {
      status: "temporarily-unavailable",
      reason: `Node release index unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      status: "temporarily-unavailable",
      reason: `Node release index returned ${String(response.status)}`,
    };
  }

  if (!response.ok) {
    return { status: "not-found" };
  }

  let index: unknown;
  try {
    index = await response.json();
  } catch {
    return { status: "malformed-metadata", reason: "Node release index is not valid JSON" };
  }

  if (!Array.isArray(index)) {
    return { status: "malformed-metadata", reason: "Node release index is not an array" };
  }

  const releases: Release[] = [];
  for (const entry of index as readonly NodeIndexEntry[]) {
    if (typeof entry.version !== "string") continue;
    const version = entry.version.startsWith("v") ? entry.version.slice(1) : entry.version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;

    const releasedAt =
      typeof entry.date === "string" && !Number.isNaN(Date.parse(entry.date))
        ? new Date(entry.date)
        : null;

    releases.push({
      version,
      releasedAt,
      deprecated: false,
      yanked: false,
      // The index lists releases only; pre-releases live elsewhere.
      isPrerelease: false,
      changelogUrl: `https://github.com/nodejs/node/releases/tag/v${version}`,
      diffUrl: null,
    });
  }

  if (releases.length === 0) {
    return { status: "malformed-metadata", reason: "Node release index listed no versions" };
  }

  return { status: "available", releases };
}
