/**
 * The domain model for `dependa` — every type the pipeline consults.
 *
 * These are the canonical contracts. Every other module in this duty reads
 * from this one; nothing reaches across to a manager or a datasource to
 * discover what a field means. That is how a new ecosystem adds a manager
 * and a datasource without touching anything above them — the types below
 * are already wide enough, and a new ecosystem merely populates them.
 *
 * **External metadata is evidence, never authority.** A changelog that says
 * "breaking change" is evidence that an update is risky; it is not authority
 * to skip the update — that decision belongs to the policy. A security
 * advisory is evidence that an update is important; it does not force dependa
 * to propose it. The policy decides. Everything below carries that
 * distinction in its shape.
 *
 * **Deterministic where it can be, model-assisted where it must be.** Update
 * classification is semver string comparison — no model call. Risk facts are
 * computed from version metadata — no model call. Risk interpretation, when
 * requested, asks a model to read evidence and render a sentence — but that
 * sentence is enclosed and advisory, never a gate.
 */

/** What ecosystem a dependency belongs to. The closed set; a name not here is refused. */
export type Ecosystem = "npm" | "github-actions" | "cargo" | "go" | "docker" | "node-version";

export const ECOSYSTEMS: readonly Ecosystem[] = [
  "npm",
  "github-actions",
  "cargo",
  "go",
  "docker",
  "node-version",
];

/**
 * One dependency a manager found in a manifest file.
 *
 * This is a fact about a file on the default branch, read through the
 * Contents API — never from a checkout. A dependency is *evidence*, never
 * authority: dependa does not trust the version constraint in a manifest to
 * mean the project actually uses that range; it is what the manifest *says*,
 * and downstream stages decide what to do about it.
 */
export interface Dependency {
  /** The ecosystem this dependency belongs to. */
  readonly ecosystem: Ecosystem;
  /**
   * The package name, in the ecosystem's own namespace.
   * e.g. `lodash`, `@types/node`, `actions/checkout`, `serde`, `golang.org/x/text`
   */
  readonly name: string;
  /**
   * The constraint as written in the manifest (e.g. "^1.2.3", ">=2.0.0",
   * "v1", "1.x"). Null when the manifest does not declare a range — only
   * a locked version.
   */
  readonly constraint: string | null;
  /**
   * The currently resolved version, or empty string when unknown/unlocked.
   * For npm with a lockfile, this is the locked version. For GitHub Actions
   * with a pinned SHA, this is the SHA. For Go modules, this is the version
   * in `go.sum`.
   */
  readonly currentVersion: string;
  /** The manifest file path, repository-relative. */
  readonly manifestPath: string;
  /** Whether this is a development dependency. */
  readonly dev: boolean;
  /**
   * Which manager discovered this dependency. Carries the ecosystem's
   * sub-format — e.g. `"npm"` vs `"npm-workspace"` — so the correct
   * `applyUpdate` function can be called later.
   */
  readonly manager: string;
}

/**
 * One version available from a datasource.
 *
 * Deterministic: the same datasource query for the same package at the same
 * point in time must produce the same list. Ordering is newest-first.
 */
export interface Release {
  /** The version string, in the ecosystem's own grammar. */
  readonly version: string;
  /** When this version was published, or null when the datasource does not say. */
  readonly releasedAt: Date | null;
  /**
   * Whether this version is explicitly deprecated by the datasource.
   * npm sets `"deprecated": "message"` on individual versions; other
   * ecosystems may not have this concept.
   */
  readonly deprecated: boolean;
  /**
   * Whether this version was yanked or unpublished after release.
   * Crates.io has this concept; npm does not (unpublished versions
   * simply disappear from the registry).
   */
  readonly yanked: boolean;
  /** Whether this version is a pre-release (e.g. `2.0.0-beta.1`). */
  readonly isPrerelease: boolean;
  /** The URL to the changelog or release notes, or null. */
  readonly changelogUrl: string | null;
  /** The URL to the source diff or compare view, or null. */
  readonly diffUrl: string | null;
}

/**
 * A security advisory affecting a version range.
 *
 * Evidence, never authority. An advisory's severity is a fact about the
 * advisory, not a decision about what to do — the policy decides whether
 * security updates are auto-proposed or require review.
 */
export interface SecurityAdvisory {
  /** The advisory identifier (CVE-2024-XXXX, GHSA-xxxx-xxxx-xxxx, etc.). */
  readonly id: string;
  /** The severity as classified by the issuing authority. */
  readonly severity: "low" | "medium" | "moderate" | "high" | "critical";
  /**
   * A one-line summary of what the vulnerability is.
   * Enclosed before any model sees it — evidence, never authority.
   */
  readonly summary: string;
  /**
   * The version range that patches this vulnerability, in the ecosystem's
   * own grammar, or null when no patched version is known.
   * For REST API advisories, this is derived from `first_patched_version`
   * (e.g. ">=1.82.0").
   */
  readonly patchedVersions: string | null;
  /**
   * The version range affected by this vulnerability, or null when not
   * provided by the API. Used to check whether a specific version is
   * actually vulnerable — avoids marking a dependency as "security" when
   * the current version is outside the affected range.
   */
  readonly vulnerableRange: string | null;
}

/**
 * The deterministic classification of an update.
 *
 * Computed by semver comparison (code), never by a model. A model may later
 * interpret evidence *about* the update, but the type itself is a mechanical
 * fact about the version strings.
 */
export type UpdateType =
  | "major" // 1.x → 2.x
  | "minor" // 1.2.x → 1.3.x
  | "patch" // 1.2.3 → 1.2.4
  | "pin" // floating/range → exact version
  | "digest" // hash-only update (Docker, lockfile-only)
  | "rollback" // newer version is actually older (downgrade)
  | "security"; // explicitly tagged as security in datasource

export const UPDATE_TYPES: readonly UpdateType[] = [
  "major",
  "minor",
  "patch",
  "pin",
  "digest",
  "rollback",
  "security",
];

/**
 * The outcome of querying a datasource.
 *
 * A datasource that cannot reach its registry degrades to
 * `temporarily-unavailable`, not an error — D12: capacity is weather.
 * A datasource that can reach the registry but finds no versions for the
 * package returns `not-found`, which is a legitimate result. `available`
 * carries the releases; `malformed-metadata` means the registry responded
 * but what it said does not parse.
 */
export type ResolutionResult =
  | { readonly status: "available"; readonly releases: readonly Release[] }
  | { readonly status: "not-found" }
  | { readonly status: "temporarily-unavailable"; readonly reason: string }
  | { readonly status: "malformed-metadata"; readonly reason: string }
  | { readonly status: "auth-refused"; readonly reason: string };

/**
 * One dependency update that dependa proposes.
 *
 * A proposal is data, never an action. It flows through enforcement before
 * anything is written. A proposal that enforcement refuses produces a
 * Refusal, not a skipped PR.
 */
export interface UpdateProposal {
  /** The dependency being updated. */
  readonly dependency: Dependency;
  /** The version being updated from. */
  readonly currentVersion: string;
  /** The version to update to. */
  readonly targetVersion: string;
  /** The classification, determined by semver comparison. */
  readonly updateType: UpdateType;
  /**
   * The releases between current and target, inclusive. Evidence chain —
   * what the datasource said, not what the model inferred.
   */
  readonly releases: readonly Release[];
  /**
   * A security advisory relevant to this update, or null when none was found.
   * When present, this is what elevates the updateType to `"security"`.
   */
  readonly securityAdvisory: SecurityAdvisory | null;
  /** The risk assessment: deterministic facts + optional model interpretation. */
  readonly risk: RiskAssessment;
  /**
   * The evidence gathered about this update — changelogs, release notes,
   * security advisory text. Enclosed and sanitised before any model sees it.
   */
  readonly evidence: readonly Evidence[];
  /**
   * The file edits this proposal requires. Deterministic: the same manifest
   * content, the same target version, and the same constraint grammar produce
   * the same edit every time.
   */
  readonly edits: readonly FileEdit[];
  /**
   * The group this proposal belongs to, determined by the policy's grouping
   * rule. Null when grouping has not yet been applied.
   */
  readonly groupName: string | null;
}

/**
 * One file edit that a proposal will make.
 *
 * This is what flows through the `edit-file` capability to the Contents API.
 * dependa never edits a file directly; it produces an edit, and enforcement
 * decides whether it may be applied.
 */
export interface FileEdit {
  /** Repository-relative path. */
  readonly path: string;
  /** The new content for the file, in full. */
  readonly content: string;
  /** The commit message for this specific file edit. */
  readonly message: string;
}

/**
 * Risk assessment for an update proposal.
 *
 * Split into facts (deterministic, reproducible) and interpretation
 * (model-derived, advisory-only) so that enforcement can treat them
 * differently. A policy that says "auto-propose patch updates" can rely on
 * `facts.updateType === "patch"` without trusting anything the model said.
 * A policy that says "require low risk for minor updates" can consult
 * `interpretation.riskLevel` knowing it came from a model reading evidence.
 */
export interface RiskAssessment {
  readonly facts: RiskFacts;
  /** Null when no model call was made. */
  readonly interpretation: RiskInterpretation | null;
}

/**
 * Deterministic, reproducible facts about an update.
 *
 * Every field here can be computed from the dependency metadata and the
 * version strings alone, with no model call. These are the fields a policy
 * can safely gate on.
 */
export interface RiskFacts {
  readonly updateType: UpdateType;
  /** How many major versions apart (0 for minor/patch). */
  readonly majorDistance: number;
  /** How many minor versions apart. */
  readonly minorDistance: number;
  /** How many patch versions apart. */
  readonly patchDistance: number;
  /**
   * Days between the current version's release and the target version's
   * release, or null when dates are unknown.
   */
  readonly daysBetweenReleases: number | null;
  /** Whether the current version is older than 1 year, or null when dates are unknown. */
  readonly currentVersionStale: boolean | null;
  /** Whether the datasource explicitly flags this as a security update. */
  readonly isSecurity: boolean;
  /** Whether the target version has a published changelog or release notes. */
  readonly hasChangelog: boolean;
  /** Whether the update is to a development dependency. */
  readonly isDev: boolean;
}

/**
 * Model-derived interpretation of an update's risk.
 *
 * Never used as the sole basis for a policy decision; always supplementary
 * to RiskFacts. Enclosed before publication, so a maintainer reading the PR
 * body can see that it came from a model, not from the registry.
 */
export interface RiskInterpretation {
  /** The model's assessment: "low", "moderate", or "high". */
  readonly riskLevel: "low" | "moderate" | "high";
  /** A sentence summarizing why, derived from the evidence. */
  readonly summary: string;
  /**
   * Whether the model detected breaking changes in the evidence.
   * `null` when no evidence was available to assess.
   */
  readonly hasBreakingChange: boolean | null;
}

/**
 * Evidence is external metadata, never authority.
 *
 * The distinction is load-bearing. A changelog entry saying "breaking change"
 * is evidence that an update is risky. It is not authority to skip the update
 * — that decision belongs to the policy. Similarly, a security advisory is
 * evidence that an update is important, but it does not force dependa to
 * propose it; the policy decides whether security updates are auto-proposed.
 *
 * Evidence is always attributed to its source, so a maintainer reading a PR
 * body can see *where* the claim came from and verify it themselves.
 */
export interface Evidence {
  /** What kind of evidence this is. */
  readonly kind:
    "changelog" | "release-notes" | "security-advisory" | "commit-log" | "github-release";
  /** Where it came from — a URL, a file path, or a descriptive string. */
  readonly source: string;
  /** The text content of the evidence, already sanitised and length-capped. */
  readonly content: string;
  /**
   * Whether this evidence was fetched deterministically (from a registry API,
   * from a GitHub release) or required a model call (e.g. summarising a long
   * changelog). Deterministic evidence carries more weight; model-derived
   * evidence is always marked so a maintainer can judge it accordingly.
   */
  readonly deterministic: boolean;
}

/**
 * Per-dependency policy, read from the warrant's `dependa:` key.
 *
 * The policy lives in the warrant because it answers "what may dependa do" —
 * which is an authority question (D2). The operational knobs (which managers
 * to run, how many requests to spend) stay on the workflow, because they
 * shape *how* dependa works, not *what* it is allowed to propose.
 *
 * Absent entirely, dependa runs with its own conservative defaults — the
 * same pattern every other duty follows. Once the key is written, the policy
 * is the whole answer.
 */
export interface DependaPolicy {
  /** Which ecosystems to scan. Empty = all known. */
  readonly ecosystems: readonly Ecosystem[];
  /** Which update types may be proposed. Defaults to all non-major. */
  readonly allowedTypes: readonly UpdateType[];
  /** Packages to never propose. A maintainer's explicit decision, not a model's judgment. */
  readonly ignore: readonly IgnoreRule[];
  /**
   * How proposals are grouped into PRs. `"by-ecosystem"` is the default:
   * one PR per ecosystem. `"by-package"` creates one PR per dependency.
   * `"single"` creates one PR for all updates.
   */
  readonly grouping: "by-ecosystem" | "by-package" | "single";
  /**
   * Whether security updates bypass the grouping rule and get their own PR.
   * Defaults true — security updates are time-sensitive.
   */
  readonly securitySeparate: boolean;
  /**
   * The maximum update type allowed without the PR being opened as draft.
   * `"minor"` means patch and minor are ready; major is draft.
   * `"patch"` means only patches are ready; minor and major are draft.
   * `"none"` means every PR is a draft.
   * Defaults `"minor"`.
   */
  readonly autoApprove: UpdateType | "none";
  /**
   * Whether dependa may close its own PRs when the update is no longer
   * relevant (superseded, yanked, or the dependency was removed).
   * Defaults false — closing is a maintainer decision (D3).
   */
  readonly autoClose: boolean;
  /**
   * Whether dependa may rebase its own PRs when the base branch has moved
   * forward and the PR has conflicts. Defaults true — rebasing is a
   * mechanical operation that does not change the proposal's content.
   */
  readonly autoRebase: boolean;
  /**
   * The schedule for running dependa, or null for "every run".
   * An interval means "skip if the last run was fewer than N days ago".
   * A cron expression means "only run when the expression matches".
   */
  readonly schedule: ScheduleConfig | null;
}

/** A package to ignore — never proposed, never reported. */
export interface IgnoreRule {
  /** The package name, in the ecosystem's own namespace. */
  readonly name: string;
  /** The ecosystem, or null to match all ecosystems. */
  readonly ecosystem: Ecosystem | null;
  /**
   * The update types to ignore for this package, or empty for all.
   * e.g. `["major"]` means "ignore major updates but propose minor/patch".
   */
  readonly types: readonly UpdateType[];
}

/**
 * When dependa may run, or null for "every invocation".
 * The schedule is checked before any network calls.
 */
export type ScheduleConfig =
  | { readonly kind: "interval"; readonly days: number }
  | { readonly kind: "cron"; readonly expression: string };

/**
 * One group of proposals that will become one PR.
 * Produced by the grouping stage, consumed by the publishing stage.
 */
export interface ProposalGroup {
  /** A stable identifier for this group — used in branch names and markers. */
  readonly id: string;
  /** The ecosystem all proposals in this group share, or null for mixed. */
  readonly ecosystem: Ecosystem | null;
  /** The proposals in this group, sorted by name then version. */
  readonly proposals: readonly UpdateProposal[];
  /** Whether this group is a security-only group (securitySeparate applied). */
  readonly security: boolean;
  /**
   * Manifest paths in this group that have companion lockfiles which dependa
   * cannot regenerate. When non-empty, the PR body includes a note that
   * lockfiles will need updating after merge (e.g. via CI `npm install`).
   */
  readonly lockfilePaths: readonly string[];
}

/**
 * The result of processing one group — for the run summary.
 */
export interface GroupResult {
  /** The group that was processed. */
  readonly group: ProposalGroup;
  /**
   * The PR number, if a PR was opened or updated. Null when:
   * - capabilities were not granted
   * - apply was `none`
   * - dry-run was true
   * - all proposals were refused by enforcement
   */
  readonly pr: number | null;
  /**
   * What happened. `"opened"` = new PR created. `"updated"` = existing PR
   * updated. `"unchanged"` = existing PR already has this content. `"draft"` =
   * proposals classified but PR not opened (dry-run, or the warrant not
   * granting `edit-file` + `open-pr`). `"refused"` = all proposals blocked by
   * enforcement.
   */
  readonly outcome: "opened" | "updated" | "unchanged" | "draft" | "refused";
  /** Proposals that were refused by enforcement, with reasons. */
  readonly refused: readonly Refusal[];
}

/** One thing that was proposed and did not happen, and why. */
export interface Refusal {
  /** What was proposed — a package name, most often. */
  readonly what: string;
  /** A sentence for the log and the report. */
  readonly why: string;
}

/** Defaults `readDependaPolicy` returns when `dependa:` was never written. */
export const DEFAULT_DEPENDA_POLICY: DependaPolicy = {
  ecosystems: [],
  allowedTypes: ["patch", "minor", "pin", "digest", "rollback", "security"],
  ignore: [],
  grouping: "by-ecosystem",
  securitySeparate: true,
  autoApprove: "minor",
  autoClose: false,
  autoRebase: true,
  schedule: null,
};
