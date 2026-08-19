/**
 * The comparison engine — takes Renovate and dependa findings and produces
 * classified discrepancies.
 *
 * The engine compares at six levels:
 * 1. Discovery — was the dependency detected?
 * 2. Version selection — did both select the same target?
 * 3. Update classification — patch/minor/major/pin/digest/security
 * 4. Grouping — did both group similarly?
 * 5. Mutation — would the same files change?
 * 6. Security — did both detect the same condition?
 *
 * The first level where a difference is found determines the comparison level.
 * The classification is then determined by investigation rules.
 *
 * **Renovate is the baseline, not absolute truth.** When both tools disagree,
 * the discrepancy is recorded, not hidden. Whether it is a bug, a missing
 * capability, or an intentional difference is determined by the classification
 * rules below — not by which tool "looks more correct."
 */

import type {
  ComparisonLevel,
  ConformanceDataset,
  ConformanceMetrics,
  ConformanceReport,
  DependencyComparison,
  DependaFinding,
  DiscrepancyClassification,
  RenovateFinding,
} from "./types.js";

/**
 * Compare Renovate and dependa findings for one repository.
 *
 * Both arrays are keyed by (ecosystem, name, manifestPath). A dependency
 * found by only one tool gets a partial comparison with the other side as
 * null. Using manifestPath as part of the composite key avoids silently
 * deduplicating the same package across different workspace manifests.
 */
export function compare(
  renovateFindings: readonly RenovateFinding[],
  dependaFindings: readonly DependaFinding[],
  context: { repository: string; baseRef: string; dependaVersion: string; renovateVersion: string },
): ConformanceDataset {
  const renovateByKey = indexByCompositeKey(renovateFindings);
  const dependaByKey = indexByCompositeKey(dependaFindings);

  const allKeys = new Set([...renovateByKey.keys(), ...dependaByKey.keys()]);
  const comparisons: DependencyComparison[] = [];

  for (const key of allKeys) {
    const r = renovateByKey.get(key) ?? null;
    const d = dependaByKey.get(key) ?? null;

    comparisons.push(compareOne(r, d));
  }

  // Sort: discrepancies first, then by ecosystem/name
  comparisons.sort((a, b) => {
    if (a.classification !== b.classification) {
      // Security and bugs first
      const priority: Record<string, number> = {
        DEPENDA_BUG: 0,
        INSUFFICIENT_EVIDENCE: 1,
        DEPENDA_MISSING_CAPABILITY: 2,
        RENOVATE_DIFFERENCE: 3,
        INTENTIONAL_DIFFERENCE: 4,
        MATCH: 5,
      };
      const pa = priority[a.classification] ?? 6;
      const pb = priority[b.classification] ?? 6;
      if (pa !== pb) return pa - pb;
    }
    // Byte order: a locale collation can flip which ecosystem/name sorts first
    // and change the emitted report's row order.
    const ecoCmp = a.ecosystem < b.ecosystem ? -1 : a.ecosystem > b.ecosystem ? 1 : 0;
    if (ecoCmp !== 0) return ecoCmp;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return {
    timestamp: new Date().toISOString(),
    repository: context.repository,
    baseRef: context.baseRef,
    dependaVersion: context.dependaVersion,
    renovateVersion: context.renovateVersion,
    comparisons,
  };
}

/**
 * Index findings by (ecosystem, name, firstManifestPath) composite key.
 *
 * Using manifest path in the key prevents silent deduplication of the same
 * package across different workspace manifests (monorepo support).
 */
function indexByCompositeKey<
  T extends { ecosystem: string; name: string; files: readonly string[] },
>(findings: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const f of findings) {
    const manifest = f.files.length > 0 ? (f.files[0] ?? "") : "";
    const key = `${f.ecosystem}::${f.name}::${manifest}`;
    if (!map.has(key)) {
      map.set(key, f);
    }
  }
  return map;
}

/**
 * Compare a single dependency across both tools.
 */
function compareOne(
  renovate: RenovateFinding | null,
  dependa: DependaFinding | null,
): DependencyComparison {
  const ecosystem = (renovate ?? dependa)?.ecosystem ?? "unknown";
  const name = (renovate ?? dependa)?.name ?? "unknown";
  const constraint = renovate?.constraint ?? dependa?.constraint ?? null;
  const currentVersion = renovate?.currentVersion ?? dependa?.currentVersion ?? null;
  const manifestPath =
    (renovate?.files.length ?? 0) > 0
      ? (renovate?.files[0] ?? null)
      : (dependa?.files.length ?? 0) > 0
        ? (dependa?.files[0] ?? null)
        : null;

  const renovateDiscovered = renovate !== null;
  const dependaDiscovered = dependa !== null;

  const renovateTargetVersion = renovate?.targetVersion ?? null;
  const dependaTargetVersion = dependa?.targetVersion ?? null;

  const renovateUpdateType = renovate?.updateType ?? null;
  const dependaUpdateType = dependa?.updateType ?? null;

  const renovateGroup = renovate?.group ?? null;
  const dependaGroup = dependa?.group ?? null;

  const renovateFiles = renovate?.files ?? [];
  const dependaFiles = dependa?.files ?? [];

  const renovateSecurity = renovate?.security ?? false;
  const dependaSecurity = dependa?.security ?? false;

  // Determine the first discrepancy level and classification
  const { level, classification, reason } = classifyDiscrepancy(renovate, {
    ecosystem,
    name,
    renovateDiscovered,
    dependaDiscovered,
    renovateTargetVersion,
    dependaTargetVersion,
    renovateUpdateType,
    dependaUpdateType,
    renovateGroup,
    dependaGroup,
    renovateFiles,
    dependaFiles,
    renovateSecurity,
    dependaSecurity,
  });

  return {
    ecosystem,
    name,
    manifestPath,
    constraint,
    currentVersion,
    renovateTargetVersion,
    renovateUpdateType,
    renovateGroup,
    renovateFiles,
    renovateSecurity,
    renovateDiscovered,
    dependaTargetVersion,
    dependaUpdateType,
    dependaGroup,
    dependaFiles,
    dependaSecurity,
    dependaDiscovered,
    level,
    classification,
    reason,
  };
}

/**
 * Classify the discrepancy between two findings.
 *
 * Compares at each level in order and returns the first difference found,
 * along with a classification and reason.
 *
 * Level order: discovery → version-selection → update-classification →
 * grouping → mutation → security
 */
function classifyDiscrepancy(
  renovate: RenovateFinding | null,
  facts: {
    ecosystem: string;
    name: string;
    renovateDiscovered: boolean;
    dependaDiscovered: boolean;
    renovateTargetVersion: string | null;
    dependaTargetVersion: string | null;
    renovateUpdateType: string | null;
    dependaUpdateType: string | null;
    renovateGroup: string | null;
    dependaGroup: string | null;
    renovateFiles: readonly string[];
    dependaFiles: readonly string[];
    renovateSecurity: boolean;
    dependaSecurity: boolean;
  },
): {
  level: ComparisonLevel | null;
  classification: DiscrepancyClassification;
  reason: string | null;
} {
  // Level 1: Discovery
  if (facts.renovateDiscovered && !facts.dependaDiscovered) {
    return {
      level: "discovery",
      classification: classifyMissingDiscovery(facts.ecosystem, facts.name, renovate),
      reason: `Renovate discovered ${facts.name} on ${facts.ecosystem}; dependa did not`,
    };
  }

  if (!facts.renovateDiscovered && facts.dependaDiscovered) {
    // Dependa found something Renovate did not — this is not a missing
    // capability on dependa's side. It may be a Renovate gap or a false
    // positive from dependa. Classify accordingly.
    return {
      level: "discovery",
      classification: "RENOVATE_DIFFERENCE",
      reason: `dependa discovered ${facts.name} on ${facts.ecosystem}; Renovate did not`,
    };
  }

  // Both discovered — compare subsequent levels

  // Level 2: Version selection
  if (facts.renovateTargetVersion !== facts.dependaTargetVersion) {
    const rNorm = normalizeVersion(facts.renovateTargetVersion);
    const dNorm = normalizeVersion(facts.dependaTargetVersion);

    if (rNorm !== dNorm) {
      return {
        level: "version-selection",
        classification: classifyVersionDifference(
          facts.renovateTargetVersion,
          facts.dependaTargetVersion,
        ),
        reason: `Renovate selects ${facts.renovateTargetVersion ?? "none"}; dependa selects ${facts.dependaTargetVersion ?? "none"}`,
      };
    }
  }

  // Level 3: Update classification
  if (facts.renovateUpdateType !== facts.dependaUpdateType) {
    const rNorm = normalizeUpdateType(facts.renovateUpdateType);
    const dNorm = normalizeUpdateType(facts.dependaUpdateType);

    if (rNorm !== dNorm) {
      return {
        level: "update-classification",
        classification: classifyUpdateTypeDifference(
          facts.renovateUpdateType,
          facts.dependaUpdateType,
        ),
        reason: `Renovate classifies as ${facts.renovateUpdateType ?? "none"}; dependa classifies as ${facts.dependaUpdateType ?? "none"}`,
      };
    }
  }

  // Level 4: Grouping
  if (facts.renovateGroup !== facts.dependaGroup) {
    return {
      level: "grouping",
      classification: "INTENTIONAL_DIFFERENCE",
      reason: `Renovate groups as "${facts.renovateGroup ?? "none"}"; dependa groups as "${facts.dependaGroup ?? "none"}" — grouping is policy-dependent`,
    };
  }

  // Level 5: Mutation (files)
  const fileDiff = fileDifference(facts.renovateFiles, facts.dependaFiles);
  if (fileDiff !== null) {
    return {
      level: "mutation",
      classification: "INTENTIONAL_DIFFERENCE",
      reason: fileDiff,
    };
  }

  // Level 6: Security
  if (facts.renovateSecurity !== facts.dependaSecurity) {
    return {
      level: "security",
      classification:
        facts.renovateSecurity && !facts.dependaSecurity
          ? "DEPENDA_MISSING_CAPABILITY"
          : "RENOVATE_DIFFERENCE",
      reason:
        facts.renovateSecurity && !facts.dependaSecurity
          ? `Renovate flags ${facts.name} as security; dependa does not`
          : `dependa flags ${facts.name} as security; Renovate does not`,
    };
  }

  // All levels match
  return { level: null, classification: "MATCH", reason: null };
}

/**
 * Classify why dependa missed a discovery.
 */
function classifyMissingDiscovery(
  ecosystem: string,
  name: string,
  renovate: RenovateFinding | null,
): DiscrepancyClassification {
  // Ecosystems dependa does not support
  const unsupportedEcosystems = new Set<string>(); // Currently dependa supports all listed ecosystems
  if (unsupportedEcosystems.has(ecosystem)) {
    return "DEPENDA_MISSING_CAPABILITY";
  }

  // GitHub Actions digest pinning — Renovate does this, dependa may not
  if (ecosystem === "github-actions" && renovate?.updateType === "pinDigest") {
    return "INTENTIONAL_DIFFERENCE";
  }

  // Lockfile maintenance — Renovate has this, dependa does not
  if (name === "lockFileMaintenance") {
    return "INTENTIONAL_DIFFERENCE";
  }

  // Default: treat as a bug until proven otherwise
  return "DEPENDA_BUG";
}

/**
 * Classify a version-selection difference.
 */
function classifyVersionDifference(
  renovateVersion: string | null,
  dependaVersion: string | null,
): DiscrepancyClassification {
  // If one is null and the other is not, it's likely a missing capability
  if (renovateVersion === null || dependaVersion === null) {
    return "DEPENDA_MISSING_CAPABILITY";
  }

  // If Renovate selects a digest/SHA and dependa selects a version tag
  if (isDigestLike(renovateVersion) && !isDigestLike(dependaVersion)) {
    return "INTENTIONAL_DIFFERENCE";
  }

  // Both are version strings but differ — could be constraint handling
  // Default to insufficient evidence; needs human investigation
  return "INSUFFICIENT_EVIDENCE";
}

/**
 * Classify an update-type difference.
 *
 * Called only when normalized types differ (caller already checked).
 */
function classifyUpdateTypeDifference(
  renovateType: string | null,
  dependaType: string | null,
): DiscrepancyClassification {
  if (renovateType === null || dependaType === null) {
    return "INSUFFICIENT_EVIDENCE";
  }

  // "replacement" is a Renovate concept dependa lacks
  if (renovateType === "replacement" || dependaType === "replacement") {
    return "DEPENDA_MISSING_CAPABILITY";
  }

  // Major vs minor classification — semver interpretation difference
  // This often requires investigation
  return "INSUFFICIENT_EVIDENCE";
}

/**
 * Normalize a version string for comparison.
 *
 * Strips leading 'v' prefix (only when followed by a digit), strips
 * semver build metadata (+build suffix), normalizes whitespace.
 */
function normalizeVersion(version: string | null): string | null {
  if (version === null) return null;
  let result = version.trim();
  // Strip leading v/V only when followed by a digit (semver convention)
  if (/^[vV]\d/.test(result)) {
    result = result.slice(1);
  }
  // Strip semver build metadata (+build suffix) per semver spec
  const plusIndex = result.indexOf("+");
  if (plusIndex > 0) {
    result = result.slice(0, plusIndex);
  }
  return result;
}

/**
 * Normalize update type names for comparison.
 *
 * Renovate uses "pinDigest" where dependa uses "digest".
 * Renovate uses "lockFileMaintenance" — no dependa equivalent.
 */
function normalizeUpdateType(type: string | null): string | null {
  if (type === null) return null;
  if (type === "pinDigest") return "digest";
  return type;
}

/**
 * Whether a version string looks like a SHA digest.
 */
function isDigestLike(version: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(version.trim());
}

/**
 * Describe the file-level difference, or null if files match.
 */
function fileDifference(
  renovateFiles: readonly string[],
  dependaFiles: readonly string[],
): string | null {
  const rSet = new Set(renovateFiles);
  const dSet = new Set(dependaFiles);

  const inRenovateOnly = renovateFiles.filter((f) => !dSet.has(f));
  const inDependaOnly = dependaFiles.filter((f) => !rSet.has(f));

  if (inRenovateOnly.length === 0 && inDependaOnly.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (inRenovateOnly.length > 0) {
    parts.push(`Renovate edits: ${inRenovateOnly.join(", ")}`);
  }
  if (inDependaOnly.length > 0) {
    parts.push(`dependa edits: ${inDependaOnly.join(", ")}`);
  }
  return parts.join("; ");
}

// ─── Metrics ───────────────────────────────────────────────────────────────

/**
 * Compute conformance metrics from a dataset.
 */
export function computeMetrics(dataset: ConformanceDataset): ConformanceMetrics {
  const comparisons = dataset.comparisons;
  const total = comparisons.length;

  const renovateOnly = comparisons.filter(
    (c) => c.renovateDiscovered && !c.dependaDiscovered,
  ).length;
  const dependaOnly = comparisons.filter(
    (c) => !c.renovateDiscovered && c.dependaDiscovered,
  ).length;
  const bothDiscovered = comparisons.filter((c) => c.renovateDiscovered && c.dependaDiscovered);
  const matching = comparisons.filter((c) => c.classification === "MATCH").length;

  const byClassification = new Map<DiscrepancyClassification, number>();
  for (const c of comparisons) {
    byClassification.set(c.classification, (byClassification.get(c.classification) ?? 0) + 1);
  }

  const byLevel = new Map<ComparisonLevel, number>();
  for (const c of comparisons) {
    if (c.level !== null) {
      byLevel.set(c.level, (byLevel.get(c.level) ?? 0) + 1);
    }
  }

  // Parity ratios
  const renovateTotal = comparisons.filter((c) => c.renovateDiscovered).length;

  const discoveryRecall = renovateTotal > 0 ? bothDiscovered.length / renovateTotal : 1;

  const sameTarget = bothDiscovered.filter(
    (c) => normalizeVersion(c.renovateTargetVersion) === normalizeVersion(c.dependaTargetVersion),
  ).length;
  const targetVersionParity = bothDiscovered.length > 0 ? sameTarget / bothDiscovered.length : 1;

  const sameType = bothDiscovered.filter(
    (c) => normalizeUpdateType(c.renovateUpdateType) === normalizeUpdateType(c.dependaUpdateType),
  ).length;
  const updateTypeParity = bothDiscovered.length > 0 ? sameType / bothDiscovered.length : 1;

  const securityInRenovate = comparisons.filter((c) => c.renovateSecurity).length;
  const securityBoth = comparisons.filter((c) => c.renovateSecurity && c.dependaSecurity).length;
  const securityParity = securityInRenovate > 0 ? securityBoth / securityInRenovate : 1;

  // Only count packages where both tools have an explicit (non-null) group
  const bothGrouped = bothDiscovered.filter(
    (c) => c.renovateGroup !== null && c.dependaGroup !== null,
  ).length;
  const sameGroup = bothDiscovered.filter(
    (c) =>
      c.renovateGroup !== null && c.dependaGroup !== null && c.renovateGroup === c.dependaGroup,
  ).length;
  const groupingParity = bothGrouped > 0 ? sameGroup / bothGrouped : 1;

  return {
    totalCandidates: total,
    renovateOnly,
    dependaOnly,
    matching,
    intentionalDifferences: byClassification.get("INTENTIONAL_DIFFERENCE") ?? 0,
    dependaBugs: byClassification.get("DEPENDA_BUG") ?? 0,
    dependaMissingCapabilities: byClassification.get("DEPENDA_MISSING_CAPABILITY") ?? 0,
    renovateDifferences: byClassification.get("RENOVATE_DIFFERENCE") ?? 0,
    insufficientEvidence: byClassification.get("INSUFFICIENT_EVIDENCE") ?? 0,
    discoveryDiscrepancies: byLevel.get("discovery") ?? 0,
    versionSelectionDiscrepancies: byLevel.get("version-selection") ?? 0,
    updateClassificationDiscrepancies: byLevel.get("update-classification") ?? 0,
    groupingDiscrepancies: byLevel.get("grouping") ?? 0,
    mutationDiscrepancies: byLevel.get("mutation") ?? 0,
    securityDiscrepancies: byLevel.get("security") ?? 0,
    discoveryRecall: roundTo3(discoveryRecall),
    targetVersionParity: roundTo3(targetVersionParity),
    updateTypeParity: roundTo3(updateTypeParity),
    securityParity: roundTo3(securityParity),
    groupingParity: roundTo3(groupingParity),
    falsePositives: dependaOnly,
    falseNegatives: renovateOnly,
  };
}

function roundTo3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── Report generation ─────────────────────────────────────────────────────

/**
 * Generate a conformance report from a dataset.
 */
export function generateReport(dataset: ConformanceDataset): ConformanceReport {
  const metrics = computeMetrics(dataset);

  // Highest-value discrepancies: security first, then bugs, then missing capabilities
  const highestValue = dataset.comparisons
    .filter((c) => c.classification !== "MATCH")
    .sort((a, b) => {
      // Security discrepancies are highest value
      const aSecurity = a.renovateSecurity || a.dependaSecurity;
      const bSecurity = b.renovateSecurity || b.dependaSecurity;
      if (aSecurity !== bSecurity) {
        return (bSecurity ? 1 : 0) - (aSecurity ? 1 : 0);
      }
      const priority: Record<string, number> = {
        DEPENDA_BUG: 0,
        DEPENDA_MISSING_CAPABILITY: 1,
        INSUFFICIENT_EVIDENCE: 2,
        RENOVATE_DIFFERENCE: 3,
        INTENTIONAL_DIFFERENCE: 4,
      };
      const pa = priority[a.classification] ?? 5;
      const pb = priority[b.classification] ?? 5;
      if (pa !== pb) return pa - pb;
      return 0;
    })
    .slice(0, 20);

  return {
    dataset,
    metrics,
    highestValueDiscrepancies: highestValue,
  };
}

/**
 * Render a conformance report as Markdown.
 */
export function renderReportMarkdown(report: ConformanceReport): string {
  const m = report.metrics;
  const lines: string[] = [];

  lines.push("# Dependa vs Renovate Conformance Report");
  lines.push("");
  lines.push(`**Repository:** ${report.dataset.repository}`);
  lines.push(`**Base ref:** ${report.dataset.baseRef}`);
  lines.push(`**Timestamp:** ${report.dataset.timestamp}`);
  lines.push(`**Dependa:** ${report.dataset.dependaVersion}`);
  lines.push(`**Renovate:** ${report.dataset.renovateVersion}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Total candidates | ${String(m.totalCandidates)} |`);
  lines.push(`| Renovate-only | ${String(m.renovateOnly)} |`);
  lines.push(`| Dependa-only | ${String(m.dependaOnly)} |`);
  lines.push(`| Matching | ${String(m.matching)} |`);
  lines.push(`| Intentional differences | ${String(m.intentionalDifferences)} |`);
  lines.push(`| Dependa bugs | ${String(m.dependaBugs)} |`);
  lines.push(`| Dependa missing capabilities | ${String(m.dependaMissingCapabilities)} |`);
  lines.push(`| Renovate differences | ${String(m.renovateDifferences)} |`);
  lines.push(`| Insufficient evidence | ${String(m.insufficientEvidence)} |`);
  lines.push(`| Security discrepancies | ${String(m.securityDiscrepancies)} |`);
  lines.push("");

  lines.push("## Parity");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Discovery recall | ${String(m.discoveryRecall)} |`);
  lines.push(`| Target version parity | ${String(m.targetVersionParity)} |`);
  lines.push(`| Update type parity | ${String(m.updateTypeParity)} |`);
  lines.push(`| Security parity | ${String(m.securityParity)} |`);
  lines.push(`| Grouping parity | ${String(m.groupingParity)} |`);
  lines.push(`| Potential false positives (dependa-only) | ${String(m.falsePositives)} |`);
  lines.push(`| Potential false negatives (Renovate-only) | ${String(m.falseNegatives)} |`);
  lines.push("");

  if (report.highestValueDiscrepancies.length > 0) {
    lines.push("## Highest-Value Discrepancies");
    lines.push("");
    lines.push("| Ecosystem | Dependency | Level | Classification | Renovate | Dependa | Reason |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const d of report.highestValueDiscrepancies) {
      const rVer = d.renovateTargetVersion ?? "—";
      const dVer = d.dependaTargetVersion ?? "—";
      const reason = (d.reason ?? "—").replace(/\|/g, "\\|");
      const level = d.level ?? "—";
      lines.push(
        `| ${d.ecosystem} | \`${d.name}\` | ${level} | ${d.classification} | ${rVer} | ${dVer} | ${reason} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Disclaimer");
  lines.push("");
  lines.push(
    "Dependa is being evaluated alongside Renovate and is not yet the production replacement. " +
      "Renovate remains the authoritative dependency-maintenance system. " +
      "This report captures observations from a shadow/dry-run comparison.",
  );

  return lines.join("\n");
}

// ─── Serialization ─────────────────────────────────────────────────────────

/** Header shape in JSONL format. */
interface JsonlHeader {
  readonly _type: "conformance-header";
  readonly timestamp: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly dependaVersion: string;
  readonly renovateVersion: string;
}

/**
 * Serialize a conformance dataset as JSONL (one record per line).
 */
export function toJSONL(dataset: ConformanceDataset): string {
  const header: JsonlHeader = {
    timestamp: dataset.timestamp,
    repository: dataset.repository,
    baseRef: dataset.baseRef,
    dependaVersion: dataset.dependaVersion,
    renovateVersion: dataset.renovateVersion,
    _type: "conformance-header",
  };

  const records = dataset.comparisons.map((c) => JSON.stringify(c));
  return [JSON.stringify(header), ...records].join("\n");
}

/** Parsed first line — validated before narrowing to JsonlHeader. */
interface JsonlFirstLine {
  readonly _type?: string;
  readonly timestamp?: string;
  readonly repository?: string;
  readonly baseRef?: string;
  readonly dependaVersion?: string;
  readonly renovateVersion?: string;
}

/**
 * Parse a JSONL conformance dataset.
 */
export function fromJSONL(jsonl: string): ConformanceDataset {
  const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("Empty JSONL dataset");
  }

  const firstLine = lines[0];
  const first = JSON.parse(firstLine ?? "") as JsonlFirstLine;
  if (first._type !== "conformance-header") {
    throw new Error("First line is not a conformance header");
  }

  // After validation, narrow to JsonlHeader
  const header = first as unknown as JsonlHeader;

  const comparisons: DependencyComparison[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parsed = JSON.parse(line ?? "") as DependencyComparison;
    comparisons.push(parsed);
  }

  return {
    timestamp: header.timestamp,
    repository: header.repository,
    baseRef: header.baseRef,
    dependaVersion: header.dependaVersion,
    renovateVersion: header.renovateVersion,
    comparisons,
  };
}
