/**
 * Conformance types for the dependa vs Renovate dogfood evaluation.
 *
 * These types define the machine-readable comparison format. Every discrepancy
 * between what Renovate finds and what dependa finds is captured, classified,
 * and stored so it can be tracked over time, reproduced in tests, and resolved.
 *
 * **Renovate remains the production authority.** Dependa runs in shadow mode
 * (apply: none) and its findings are observations, not actions. The comparison
 * exists to expose where dependa is wrong, incomplete, or different — and to
 * turn those observations into tests, fixes, and architectural knowledge.
 *
 * The conformance model answers:
 * - What did Renovate find?
 * - What did dependa find?
 * - Why did they differ?
 * - Is the difference intentional, a limitation, or a bug?
 */

// ─── Discrepancy classification ────────────────────────────────────────────

/**
 * Why two findings differ.
 *
 * Every discrepancy must carry exactly one classification. The classification
 * is never assumed — it is determined by investigation, and it can change as
 * understanding improves. Hiding discrepancies or reclassifying them to make
 * the tools appear equivalent is explicitly forbidden.
 */
export type DiscrepancyClassification =
  /** Both tools found the same dependency, same target, same classification. */
  | "MATCH"
  /** A known architectural difference — dependa does things differently by design. */
  | "INTENTIONAL_DIFFERENCE"
  /** Dependa lacks the capability to discover or handle this case. */
  | "DEPENDA_MISSING_CAPABILITY"
  /** Dependa should have found this but did not, or found the wrong answer. */
  | "DEPENDA_BUG"
  /** Renovate's behaviour differs from what might be expected. Not a dependa issue. */
  | "RENOVATE_DIFFERENCE"
  /** Not enough information to classify the discrepancy. */
  | "INSUFFICIENT_EVIDENCE";

export const DISCREPANCY_CLASSIFICATIONS: readonly DiscrepancyClassification[] = [
  "MATCH",
  "INTENTIONAL_DIFFERENCE",
  "DEPENDA_MISSING_CAPABILITY",
  "DEPENDA_BUG",
  "RENOVATE_DIFFERENCE",
  "INSUFFICIENT_EVIDENCE",
];

// ─── Comparison levels ─────────────────────────────────────────────────────

/**
 * The six comparison levels.
 *
 * A comprehensive comparison does not stop at "did both find the same version?"
 * It compares across discovery, selection, classification, grouping,
 * mutation, and security — because a difference at any level matters.
 *
 * Note: `candidate-resolution` was considered but cannot be compared with
 * current data (neither extractor resolves candidate lists). It is omitted
 * until the extractors can produce that data.
 */
export type ComparisonLevel =
  | "discovery" // Was the dependency detected?
  | "version-selection" // Did both select the same target?
  | "update-classification" // patch/minor/major/pin/digest/security
  | "grouping" // Did both group dependencies similarly?
  | "mutation" // Would the same files change?
  | "security"; // Did both detect the same security condition?

export const COMPARISON_LEVELS: readonly ComparisonLevel[] = [
  "discovery",
  "version-selection",
  "update-classification",
  "grouping",
  "mutation",
  "security",
];

// ─── Per-dependency comparison ─────────────────────────────────────────────

/**
 * A single dependency's comparison record.
 *
 * This is the atomic unit of the conformance dataset. One record per
 * dependency per ecosystem — the key that links Renovate and dependa
 * findings is `(ecosystem, name)`.
 */
export interface DependencyComparison {
  /** The ecosystem: npm, github-actions, cargo, go, docker. */
  readonly ecosystem: string;
  /** The dependency name in the ecosystem's namespace. */
  readonly name: string;
  /** The manifest file path, if known. */
  readonly manifestPath: string | null;

  // ── Current state (what the manifest says) ──

  /** The constraint as written in the manifest. */
  readonly constraint: string | null;
  /** The current resolved version (from lockfile or pin). */
  readonly currentVersion: string | null;

  // ── Renovate findings ──

  /** What Renovate proposes as the target version. */
  readonly renovateTargetVersion: string | null;
  /** Renovate's classification: major, minor, patch, pin, digest, rollback, security. */
  readonly renovateUpdateType: string | null;
  /** Renovate's group name, if any. */
  readonly renovateGroup: string | null;
  /** Files Renovate would change. */
  readonly renovateFiles: readonly string[];
  /** Whether Renovate flagged this as security. */
  readonly renovateSecurity: boolean;
  /** Whether Renovate found this dependency at all. */
  readonly renovateDiscovered: boolean;

  // ── Dependa findings ──

  /** What dependa proposes as the target version. */
  readonly dependaTargetVersion: string | null;
  /** Dependa's classification. */
  readonly dependaUpdateType: string | null;
  /** Dependa's group name. */
  readonly dependaGroup: string | null;
  /** Files dependa would change. */
  readonly dependaFiles: readonly string[];
  /** Whether dependa flagged this as security. */
  readonly dependaSecurity: boolean;
  /** Whether dependa found this dependency at all. */
  readonly dependaDiscovered: boolean;

  // ── Classification ──

  /** The comparison level where the first discrepancy was found. */
  readonly level: ComparisonLevel | null;
  /** How the discrepancy is classified. MATCH when no discrepancy. */
  readonly classification: DiscrepancyClassification;
  /** A human-readable explanation of why the tools differ. */
  readonly reason: string | null;
}

// ─── Conformance dataset ───────────────────────────────────────────────────

/**
 * A complete conformance dataset from one comparison run.
 *
 * Stored as JSONL (one comparison record per line) for easy processing
 * in tests, CI, and reports.
 */
export interface ConformanceDataset {
  /** When this dataset was produced (ISO 8601). */
  readonly timestamp: string;
  /** The repository that was compared. */
  readonly repository: string;
  /** The base ref (commit SHA or branch) used for the comparison. */
  readonly baseRef: string;
  /** Dependa version or commit SHA. */
  readonly dependaVersion: string;
  /** Renovate version or "app" when using the GitHub App. */
  readonly renovateVersion: string;
  /** The comparison records. */
  readonly comparisons: readonly DependencyComparison[];
}

// ─── Conformance metrics ───────────────────────────────────────────────────

/**
 * Summary metrics from a conformance dataset.
 *
 * A single percentage is not enough. A missed critical security update
 * is more important than dozens of harmless version differences.
 */
export interface ConformanceMetrics {
  /** Total dependency candidates across both tools. */
  readonly totalCandidates: number;
  /** Candidates only Renovate found. */
  readonly renovateOnly: number;
  /** Candidates only dependa found. */
  readonly dependaOnly: number;
  /** Candidates both found with matching target. */
  readonly matching: number;

  // ── By classification ──

  readonly intentionalDifferences: number;
  readonly dependaBugs: number;
  readonly dependaMissingCapabilities: number;
  readonly renovateDifferences: number;
  readonly insufficientEvidence: number;

  // ── By level ──

  readonly discoveryDiscrepancies: number;
  readonly versionSelectionDiscrepancies: number;
  readonly updateClassificationDiscrepancies: number;
  readonly groupingDiscrepancies: number;
  readonly mutationDiscrepancies: number;
  readonly securityDiscrepancies: number;

  // ── Parity ratios ──

  /** Recall: of everything Renovate found, how much did dependa also find? */
  readonly discoveryRecall: number;
  /** Of candidates both found, what fraction selected the same target? */
  readonly targetVersionParity: number;
  /** Of candidates both found, what fraction classified the same way? */
  readonly updateTypeParity: number;
  /** Of security findings, what fraction did dependa also flag? */
  readonly securityParity: number;
  /** Of grouped findings, what fraction grouped the same way? */
  readonly groupingParity: number;

  // ── False signals ──

  /** Dependa found something Renovate did not (potential false positive). */
  readonly falsePositives: number;
  /** Renovate found something dependa did not (potential false negative). */
  readonly falseNegatives: number;
}

// ─── Conformance report ────────────────────────────────────────────────────

/**
 * A human-readable report from a conformance run.
 *
 * Answers: total, Renovate-only, dependa-only, matching, classifications,
 * security discrepancies, and highest-value discrepancies first.
 */
export interface ConformanceReport {
  readonly dataset: ConformanceDataset;
  readonly metrics: ConformanceMetrics;
  /** The highest-value discrepancies — security first, then bugs, then gaps. */
  readonly highestValueDiscrepancies: readonly DependencyComparison[];
}

// ─── Renovate finding (from Renovate's output/PRs) ────────────────────────

/**
 * A single finding from Renovate.
 *
 * Extracted from Renovate's JSON output or from its PR history.
 * Renovate is the baseline/oracle, not absolute truth.
 */
export interface RenovateFinding {
  readonly ecosystem: string;
  readonly name: string;
  readonly constraint: string | null;
  readonly currentVersion: string | null;
  readonly targetVersion: string | null;
  readonly updateType: string | null;
  readonly group: string | null;
  readonly files: readonly string[];
  readonly security: boolean;
  readonly manager: string;
  readonly datasource: string;
  /** Whether Renovate would actually create/update a PR (respecting schedule, automerge, etc.). */
  readonly wouldPr: boolean;
}

// ─── Dependa finding (from dependa's output) ───────────────────────────────

/**
 * A single finding from dependa.
 *
 * Extracted from dependa's shadow/dry-run output.
 * Dependa runs in apply: none mode — observations, not actions.
 */
export interface DependaFinding {
  readonly ecosystem: string;
  readonly name: string;
  readonly constraint: string | null;
  readonly currentVersion: string | null;
  readonly targetVersion: string | null;
  readonly updateType: string | null;
  readonly group: string | null;
  readonly files: readonly string[];
  readonly security: boolean;
  readonly manager: string;
  /** Whether dependa discovered this dependency. */
  readonly discovered: boolean;
  /** Whether dependa's policy would allow or refuse this proposal. */
  readonly policyAction: "allow" | "propose" | "refuse" | null;
  /** The proposal's risk level, if computed. */
  readonly riskLevel: string | null;
}
