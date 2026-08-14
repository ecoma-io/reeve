/**
 * Security advisory querying for `dependa`.
 *
 * Queries the GitHub Advisory Database for security vulnerabilities affecting
 * dependencies. The GitHub Advisory Database is a curated, public dataset of
 * security advisories — the authoritative source for CVE and GHSA records
 * that affect open-source packages.
 *
 * **External metadata is evidence, never authority.** An advisory's severity
 * is a fact about the vulnerability; it is not a decision to auto-merge.
 * The policy decides what happens — the advisory is evidence for risk
 * assessment and classification, never a bypass of enforcement.
 *
 * Security status must come from explicit security evidence, not from
 * heuristics like the `deprecated` flag on an npm version. A package can be
 * deprecated for many reasons (renamed, superseded, unmaintained) that have
 * nothing to do with security. Only an explicit advisory constitutes
 * security evidence.
 */
import * as core from "@actions/core";

import type { SecurityAdvisory, Ecosystem } from "../model.js";

/**
 * The GitHub ecosystem parameter values for the Advisory API.
 */
const ADVISORY_ECOSYSTEMS: ReadonlyMap<Ecosystem, string> = new Map([
  ["npm", "npm"],
  ["cargo", "rust"],
  ["go", "go"],
  // GitHub Actions and Docker are not in the advisory database.
  // These ecosystems' security advisories come from other sources.
]);

/**
 * Query the GitHub Advisory Database for security advisories affecting a package.
 *
 * Returns an array of SecurityAdvisory objects, or an empty array when:
 * - No advisories are found
 * - The ecosystem is not covered by the advisory database
 * - The API is temporarily unavailable (degraded gracefully, not an error)
 *
 * D12: capacity is weather. A failed advisory query does not fail the run.
 * The pipeline proceeds without security evidence rather than failing red.
 */
export async function queryAdvisories(
  token: string,
  ecosystem: Ecosystem,
  packageName: string,
): Promise<readonly SecurityAdvisory[]> {
  const apiEcosystem = ADVISORY_ECOSYSTEMS.get(ecosystem);
  if (apiEcosystem === undefined) {
    // Ecosystem not covered by the advisory database — log once per ecosystem
    // so maintainers are aware that security advisories are not checked.
    core.info(
      `dependa: security advisories are not available for the \`${ecosystem}\` ecosystem — ` +
        "vulnerability detection is limited to supported ecosystems (npm, cargo, go).",
    );
    return [];
  }

  // Build the query URL for the GitHub Advisory API
  // The API supports filtering by ecosystem and affected package
  const encoded = encodeURIComponent(packageName);

  // Paginate through all results — the Advisory API returns up to 100 per page.
  const allAdvisories: unknown[] = [];
  let page = 1;
  const maxPages = 5; // Cap at 5 pages (500 advisories) to avoid unbounded work

  while (page <= maxPages) {
    const url = `https://api.github.com/advisories?ecosystem=${apiEcosystem}&affects=${encoded}&per_page=100&page=${String(page)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Network error — degrade gracefully, return what we have so far
      return parseAdvisories(allAdvisories);
    }

    if (!response.ok) {
      // API error — degrade gracefully, return what we have so far
      return parseAdvisories(allAdvisories);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return parseAdvisories(allAdvisories);
    }

    if (!Array.isArray(body)) {
      return parseAdvisories(allAdvisories);
    }

    allAdvisories.push(...(body as readonly Record<string, unknown>[]));

    // If we got fewer than 100 results, we've reached the last page
    if (body.length < 100) break;
    page++;
  }

  return parseAdvisories(allAdvisories);
}

/**
 * Parse the GitHub Advisory API response into SecurityAdvisory objects.
 *
 * The API returns an array of advisory objects with fields:
 * - ghsa_id: the GHSA identifier
 * - severity: "low", "moderate", "high", "critical"
 * - summary: one-line description
 * - vulnerabilities: array of affected package versions with patched versions
 */
function parseAdvisories(advisories: readonly unknown[]): readonly SecurityAdvisory[] {
  const results: SecurityAdvisory[] = [];

  for (const entry of advisories) {
    if (typeof entry !== "object" || entry === null) continue;

    const obj = entry as Record<string, unknown>;

    const id = obj.ghsa_id;
    if (typeof id !== "string" || id.length === 0) continue;

    // Map severity — GitHub uses "low", "moderate", "high", "critical"
    const rawSeverity = obj.severity;
    let severity: SecurityAdvisory["severity"];
    if (
      rawSeverity === "low" ||
      rawSeverity === "moderate" ||
      rawSeverity === "high" ||
      rawSeverity === "critical"
    ) {
      severity = rawSeverity;
    } else {
      // cvss_severity is an alternative field in some responses
      const cvss = obj.cvss_severity;
      if (cvss === "low" || cvss === "moderate" || cvss === "high" || cvss === "critical") {
        severity = cvss;
      } else {
        // Unknown severity — default to the lowest to avoid inflating risk.
        // An advisory whose severity is unknown should not be treated as
        // more important than one explicitly rated low.
        severity = "low";
      }
    }

    const summary = obj.summary;
    if (typeof summary !== "string" || summary.length === 0) continue;

    // Extract patched versions from the vulnerabilities array
    let patchedVersions: string | null = null;
    const vulns = obj.vulnerabilities;
    if (Array.isArray(vulns)) {
      const patched: string[] = [];
      for (const vuln of vulns) {
        if (typeof vuln !== "object" || vuln === null || Array.isArray(vuln)) continue;
        const v = vuln as Record<string, unknown>;
        const pv = v.patched_versions;
        if (typeof pv === "string" && pv.length > 0) {
          patched.push(pv);
        }
      }
      if (patched.length > 0) {
        patchedVersions = patched.join(" || ");
      }
    }

    results.push({
      id,
      severity,
      summary: summary.slice(0, 500),
      patchedVersions,
    });
  }

  return results;
}
