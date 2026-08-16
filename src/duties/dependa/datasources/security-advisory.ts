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

    // A 401/403 is this run's own token being refused — not weather. Silence
    // here is the N1 failure mode: every advisory query fails and the run
    // stays green. Throw a tagged error so dependa's caller treats it as
    // configuration rather than a transient warning.
    if (response.status === 401 || response.status === 403) {
      const error = new Error(
        `dependa: security advisory API refused this run's token (HTTP ${String(response.status)})`,
      );
      error.name = "AuthRefused";
      throw error;
    }

    if (!response.ok) {
      // Other API errors degrade gracefully — return what we have so far
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

  // Warn when pagination was truncated by the page cap — the maintainer
  // should know that not all advisories were retrieved so they can decide
  // whether to investigate further.
  if (page > maxPages) {
    core.warning(
      `dependa: security advisory query for \`${packageName}\` (${apiEcosystem}) ` +
        `was truncated at ${String(maxPages)} pages (${String(maxPages * 100)} advisories). ` +
        "Some advisories may be missing.",
    );
  }

  return parseAdvisories(allAdvisories);
}

/**
 * Parse the GitHub Advisory API response into SecurityAdvisory objects.
 *
 * The API returns an array of advisory objects with fields:
 * - ghsa_id: the GHSA identifier
 * - severity: "low", "medium", "high", "critical" (REST uses "medium"; GraphQL uses "moderate")
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

    // Map severity — GitHub uses "low", "medium", "high", "critical"
    // (Note: GitHub's GraphQL API uses "moderate", but the REST API uses "medium".)
    const rawSeverity = obj.severity;
    let severity: SecurityAdvisory["severity"];
    if (
      rawSeverity === "low" ||
      rawSeverity === "medium" ||
      rawSeverity === "moderate" ||
      rawSeverity === "high" ||
      rawSeverity === "critical"
    ) {
      // Normalise "medium" (REST) and "moderate" (GraphQL) to the same value.
      severity = rawSeverity === "moderate" ? "medium" : rawSeverity;
    } else {
      // cvss_severity is an alternative field in some responses
      const cvss = obj.cvss_severity;
      if (
        cvss === "low" ||
        cvss === "medium" ||
        cvss === "moderate" ||
        cvss === "high" ||
        cvss === "critical"
      ) {
        severity = cvss === "moderate" ? "medium" : cvss;
      } else {
        // Unknown severity — default to the lowest to avoid inflating risk.
        // An advisory whose severity is unknown should not be treated as
        // more important than one explicitly rated low.
        severity = "low";
      }
    }

    const summary = obj.summary;
    if (typeof summary !== "string" || summary.length === 0) continue;

    // Extract patched and vulnerable versions from the vulnerabilities array.
    // The REST API fields:
    //   - first_patched_version: a version string (e.g. "1.82.0")
    //   - vulnerable_version_range: a semver range (e.g. "< 1.82.0")
    // The old field patched_versions was a range string; it may still appear
    // in some responses, so we check both.
    let patchedVersions: string | null = null;
    let vulnerableRange: string | null = null;
    const vulns = obj.vulnerabilities;
    if (Array.isArray(vulns)) {
      const patched: string[] = [];
      const vulnerable: string[] = [];
      for (const vuln of vulns) {
        if (typeof vuln !== "object" || vuln === null || Array.isArray(vuln)) continue;
        const v = vuln as Record<string, unknown>;
        // REST API: first_patched_version is a version string (e.g. "1.82.0")
        const fpv = v.first_patched_version;
        if (typeof fpv === "string" && fpv.length > 0) {
          patched.push(`>=${fpv}`);
        }
        // Legacy/fallback: patched_versions is a semver range (e.g. ">=1.2.3")
        if (patched.length === 0) {
          const pv = v.patched_versions;
          if (typeof pv === "string" && pv.length > 0) {
            patched.push(pv);
          }
        }
        // Vulnerable version range (e.g. "< 1.82.0" or ">= 1.0.0, < 1.82.0")
        const vvr = v.vulnerable_version_range;
        if (typeof vvr === "string" && vvr.length > 0) {
          vulnerable.push(vvr);
        }
      }
      if (patched.length > 0) {
        patchedVersions = patched.join(" || ");
      }
      if (vulnerable.length > 0) {
        vulnerableRange = vulnerable.join(" || ");
      }
    }

    results.push({
      id,
      severity,
      summary: summary.slice(0, 500),
      patchedVersions,
      vulnerableRange,
    });
  }

  return results;
}
