/**
 * Risk assessment for `dependa` update proposals.
 *
 * Split into facts (deterministic, reproducible) and interpretation
 * (model-derived, advisory-only) so that enforcement can treat them
 * differently. A policy that says "auto-propose patch updates" can rely on
 * `facts.updateType === "patch"` without trusting anything the model said.
 * A policy that says "require low risk for minor updates" can consult
 * `interpretation.riskLevel` knowing it came from a model reading evidence.
 *
 * **The model may interpret evidence. It must not invent permission.**
 * RiskInterpretation is enclosed before publication, so a maintainer reading
 * the PR body can see that it came from a model, not from the registry.
 */
import type {
  RiskAssessment,
  RiskFacts,
  RiskInterpretation,
  SecurityAdvisory,
  UpdateProposal,
  UpdateType,
} from "./model.js";
import { distance } from "./semver.js";

/**
 * Compute deterministic risk facts from raw proposal fields.
 *
 * No model. No network. Every field is computed from the version strings
 * and the dependency metadata alone. These are the fields a policy can
 * safely gate on.
 *
 * Takes raw fields rather than an UpdateProposal so it can be called
 * during proposal construction — before the full object exists.
 */
export function computeFacts(fields: {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateType: UpdateType;
  readonly releases: readonly { readonly version: string; readonly releasedAt: Date | null }[];
  readonly securityAdvisory: SecurityAdvisory | null;
  readonly evidence: readonly { readonly kind: string }[];
  readonly isDev: boolean;
}): RiskFacts {
  const dist = distance(fields.currentVersion, fields.targetVersion);

  // Compute days between releases, if both have release dates
  const currentRelease = fields.releases.find((r) => r.version === fields.currentVersion);
  const targetRelease = fields.releases.find((r) => r.version === fields.targetVersion);

  let daysBetweenReleases: number | null = null;
  let currentVersionStale: boolean | null = null;

  const currentDate = currentRelease?.releasedAt;
  const targetDate = targetRelease?.releasedAt;

  if (
    currentDate !== null &&
    currentDate !== undefined &&
    targetDate !== null &&
    targetDate !== undefined
  ) {
    daysBetweenReleases = Math.floor(
      (targetDate.getTime() - currentDate.getTime()) / (24 * 60 * 60 * 1000),
    );

    // Is the current version more than 1 year old?
    const oneYearAgo = new Date(targetDate.getTime() - 365 * 24 * 60 * 60 * 1000);
    currentVersionStale = currentDate < oneYearAgo;
  }

  return {
    updateType: fields.updateType,
    majorDistance: dist?.major ?? 0,
    minorDistance: dist?.minor ?? 0,
    patchDistance: dist?.patch ?? 0,
    daysBetweenReleases,
    currentVersionStale,
    isSecurity: fields.securityAdvisory !== null,
    hasChangelog: fields.evidence.some(
      (e) => e.kind === "changelog" || e.kind === "release-notes" || e.kind === "github-release",
    ),
    isDev: fields.isDev,
  };
}

/**
 * Build a risk assessment with facts only (no model interpretation).
 *
 * Used when the policy does not require model-assisted risk assessment,
 * or when the model is unavailable.
 *
 * Takes raw fields rather than an UpdateProposal so it can be called
 * during proposal construction — before the full object exists.
 */
export function factsOnly(fields: {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateType: UpdateType;
  readonly releases: readonly { readonly version: string; readonly releasedAt: Date | null }[];
  readonly securityAdvisory: SecurityAdvisory | null;
  readonly evidence: readonly { readonly kind: string }[];
  readonly isDev: boolean;
}): RiskAssessment {
  return {
    facts: computeFacts(fields),
    interpretation: null,
  };
}

/**
 * Build a model-assisted risk interpretation prompt.
 *
 * The model receives the evidence (enclosed) and the risk facts, and
 * returns a JSON object with `riskLevel`, `summary`, and `hasBreakingChange`.
 * The model's output is enclosed — it is interpretation, never authority.
 */
export function interpretationPrompt(
  proposal: UpdateProposal,
  facts: RiskFacts,
  enclosedEvidence: string,
  /**
   * The sentence that tells the model what the evidence boundary MEANS.
   *
   * REQUIRED, deliberately. It used to be optional, and a caller dropping the
   * argument at `main.ts:379` left third-party advisory text fenced in a tag
   * with nothing anywhere explaining it — with tsc, eslint, the whole suite,
   * coverage, the mutation table and `eval all` all green. An optional
   * parameter carrying a security guarantee is a footgun the type system was
   * already able to disarm; `""` is still accepted, for the genuine case where
   * there is no evidence to fence, but now it has to be written down.
   */
  enclosedRule: string,
): string {
  const ruleSection = enclosedRule.length > 0 ? [enclosedRule, ""] : [];
  return [
    `You are assessing the risk of updating \`${sanitizeForPrompt(proposal.dependency.name)}\` ` +
      `from \`${sanitizeForPrompt(proposal.currentVersion)}\` to \`${sanitizeForPrompt(proposal.targetVersion)}\`.`,
    "",
    ...ruleSection,
    "Risk facts (deterministic, from version metadata):",
    `- Update type: ${facts.updateType}`,
    `- Major distance: ${String(facts.majorDistance)}`,
    `- Minor distance: ${String(facts.minorDistance)}`,
    `- Patch distance: ${String(facts.patchDistance)}`,
    `- Security update: ${facts.isSecurity ? "true" : "false"}`,
    `- Dev dependency: ${facts.isDev ? "true" : "false"}`,
    `- Has changelog: ${facts.hasChangelog ? "true" : "false"}`,
    facts.daysBetweenReleases !== null
      ? `- Days between releases: ${String(facts.daysBetweenReleases)}`
      : "- Days between releases: unknown",
    facts.currentVersionStale !== null
      ? `- Current version is stale (>1 year): ${facts.currentVersionStale ? "true" : "false"}`
      : "- Current version staleness: unknown",
    "",
    "Evidence:",
    enclosedEvidence,
    "",
    "Based on the evidence and risk facts above, assess the risk of this update.",
    "",
    "Respond with a JSON object with exactly these fields:",
    '- `riskLevel`: one of "low", "moderate", or "high"',
    "- `summary`: a one-sentence explanation of the risk level",
    "- `hasBreakingChange`: true if evidence mentions breaking changes, false if not, null if unclear",
    "",
    "Do not include any other text. Only the JSON object.",
  ].join("\n");
}

/**
 * Parse a model's risk interpretation response.
 *
 * Returns null when the response does not parse — a malformed interpretation
 * is dropped, not best-effort read. The shapes that fail to parse are the
 * ones an injection produced.
 */
/**
 * Sanitize a string for safe interpolation into a model prompt.
 *
 * Removes characters that could be interpreted as prompt instructions
 * (newlines, backticks, and common injection markers). The values
 * originate from registry API responses and are untrusted — a maliciously
 * named package could attempt prompt injection.
 *
 * This is a defense-in-depth layer; the model's output is constrained by
 * parseInterpretation and the enforcement layer does not grant authority
 * based on model output.
 */
function sanitizeForPrompt(value: string): string {
  return value
    .replace(/[\r\n]/g, " ")
    .replace(/`/g, "'")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 200);
}

export function parseInterpretation(response: string): RiskInterpretation | null {
  try {
    const parsed: unknown = JSON.parse(response.trim());

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.riskLevel !== "string" || typeof obj.summary !== "string") {
      return null;
    }

    const riskLevel: string = obj.riskLevel;
    if (riskLevel !== "low" && riskLevel !== "moderate" && riskLevel !== "high") {
      return null;
    }

    const rawBreaking: unknown = obj.hasBreakingChange;
    const hasBreakingChange: boolean | null =
      rawBreaking === true || rawBreaking === false || rawBreaking === null ? rawBreaking : null;

    const summary: string = obj.summary;
    return {
      riskLevel: riskLevel,
      summary: summary.slice(0, 500), // Cap summary length
      hasBreakingChange,
    };
  } catch {
    return null;
  }
}
