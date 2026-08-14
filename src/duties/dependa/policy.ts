/**
 * The policy engine — what `dependa` is allowed to propose.
 *
 * Deterministic. No model. The policy reads from the warrant's `dependa:`
 * key and matches proposals against rules, producing a `PolicyAction`
 * (allow / propose / review / refuse). The action determines what happens
 * to the PR: `allow` opens it as ready, `propose` opens it as draft,
 * `review` opens it as draft with a review request, `refuse` drops it.
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
import * as core from "@actions/core";

import type {
  DependaPolicy,
  Ecosystem,
  IgnoreRule,
  ProposalGroup,
  UpdateProposal,
  UpdateType,
} from "./model.js";
import { DEFAULT_DEPENDA_POLICY } from "./model.js";

/**
 * What a policy says about a proposal.
 *
 * `allow` — the PR is opened as ready for merge.
 * `propose` — the PR is opened as draft (maintainer must review).
 * `refuse` — the proposal is dropped entirely.
 */
export type PolicyAction = "allow" | "propose" | "refuse";

/**
 * The result of matching a proposal against the policy.
 */
export interface PolicyVerdict {
  readonly action: PolicyAction;
  /** The rule that matched, or null when the default was applied. */
  readonly matchedRule: string | null;
  /** Whether the proposal was ignored by an ignore rule. */
  readonly ignored: boolean;
}

/**
 * Resolve the effective policy from the warrant and the workflow inputs.
 *
 * When the warrant has a `dependa:` key, it is the whole answer. When it
 * does not, the defaults apply. The workflow's `ecosystems` input can
 * further narrow the policy's ecosystem list, but it cannot widen it.
 */
export function resolvePolicy(
  warrantPolicy: DependaPolicy | null,
  workflowEcosystems: readonly Ecosystem[],
): DependaPolicy {
  const base = warrantPolicy ?? DEFAULT_DEPENDA_POLICY;

  // If the workflow specifies ecosystems, intersect with the policy's list
  if (workflowEcosystems.length > 0 && base.ecosystems.length > 0) {
    const narrowed = workflowEcosystems.filter((e) => base.ecosystems.includes(e));
    if (narrowed.length === 0) {
      core.warning(
        "dependa: workflow `ecosystems` and warrant `ecosystems` have no overlap — " +
          "no ecosystems will be scanned.",
      );
    }
    return { ...base, ecosystems: narrowed };
  }

  // If only the workflow specifies ecosystems, use those
  if (workflowEcosystems.length > 0 && base.ecosystems.length === 0) {
    return { ...base, ecosystems: workflowEcosystems };
  }

  return base;
}

/**
 * Evaluate a proposal against the policy.
 *
 * Deterministic. No model. The evaluation proceeds in order:
 * 1. Check ignore rules — if matched, the proposal is dropped.
 * 2. Check allowed types — if the update type is not allowed, refuse.
 * 3. Determine the action based on `autoApprove` — if the update type is
 *    at or below the auto-approve level, allow; otherwise propose.
 *
 * The result is a PolicyVerdict that flows into enforcement.
 */
export function evaluate(proposal: UpdateProposal, policy: DependaPolicy): PolicyVerdict {
  // 1. Ignore rules — matched by name, ecosystem, and update type
  for (const rule of policy.ignore) {
    if (matchesIgnoreRule(proposal, rule)) {
      return {
        action: "refuse",
        matchedRule: `ignore: ${rule.name}`,
        ignored: true,
      };
    }
  }

  // 2. Allowed types — if the update type is not in the policy's list, refuse
  if (!policy.allowedTypes.includes(proposal.updateType)) {
    return {
      action: "refuse",
      matchedRule: `allowed-types: ${policy.allowedTypes.join(", ")}`,
      ignored: false,
    };
  }

  // 3. Determine action based on autoApprove
  const action = autoApproveAction(proposal.updateType, policy.autoApprove);

  return {
    action,
    matchedRule: null,
    ignored: false,
  };
}

/**
 * Whether an ignore rule matches a proposal.
 *
 * A rule matches when:
 * - The rule's `name` matches the proposal's dependency name (exact or glob)
 * - The rule's `ecosystem` is null or matches the proposal's ecosystem
 * - The rule's `types` is empty or includes the proposal's update type
 */
function matchesIgnoreRule(proposal: UpdateProposal, rule: IgnoreRule): boolean {
  // Name match — support simple glob patterns
  if (!matchesGlob(proposal.dependency.name, rule.name)) return false;

  // Ecosystem match
  if (rule.ecosystem !== null && rule.ecosystem !== proposal.dependency.ecosystem) return false;

  // Update type match — empty types means "all types"
  if (rule.types.length > 0 && !rule.types.includes(proposal.updateType)) return false;

  return true;
}

/**
 * Simple glob matching for package names.
 *
 * Supports `*` (any segment) and `?` (single char). No `**` — package
 * names don't have directories. A pattern without wildcards is an exact
 * match.
 *
 * **ReDoS protection:** patterns longer than 256 characters are rejected,
 * and consecutive wildcards (`**`, `*?`, `?*`) are collapsed to a single
 * `.*` to prevent catastrophic backtracking.
 */
function matchesGlob(name: string, pattern: string): boolean {
  if (pattern.length > 256) {
    core.warning(
      `dependa: ignore pattern exceeds 256 characters — skipping: ${pattern.slice(0, 50)}…`,
    );
    return false;
  }

  if (!pattern.includes("*") && !pattern.includes("?")) {
    return name === pattern;
  }

  // Convert glob to regex
  const regex = globToRegex(pattern);
  return regex.test(name);
}

/** Convert a simple glob pattern to a RegExp. Collapses consecutive wildcards. */
function globToRegex(pattern: string): RegExp {
  // Collapse consecutive wildcards to prevent ReDoS — `**` → `*`, `*?` → `*`, etc.
  const collapsed = pattern.replace(/[*?]+/g, (seq) => {
    // Any mix of * and ? is equivalent to a single .* — ? alone stays as .
    if (seq.includes("*")) return "*";
    return seq; // all ?s — keep each as .
  });

  const escaped = collapsed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Determine the policy action based on the update type and auto-approve setting.
 *
 * `autoApprove: "minor"` means patch and minor are allowed; major is proposed.
 * `autoApprove: "patch"` means only patches are allowed; minor and major are proposed.
 * `autoApprove: "none"` means everything is proposed (all PRs are drafts).
 */
function autoApproveAction(updateType: UpdateType, autoApprove: UpdateType | "none"): PolicyAction {
  // Special cases: pin, digest, rollback, security are always allowed —
  // they bypass autoApprove because they are either mechanical (pin, digest),
  // a correction (rollback), or urgent (security).
  if (updateType === "security") return "allow";
  if (updateType === "pin" || updateType === "digest" || updateType === "rollback") return "allow";

  if (autoApprove === "none") return "propose";

  const hierarchy: readonly UpdateType[] = ["patch", "minor", "major"];
  const autoIndex = hierarchy.indexOf(autoApprove);
  const typeIndex = hierarchy.indexOf(updateType);

  // If the update type is at or below the auto-approve level, allow
  if (typeIndex >= 0 && typeIndex <= autoIndex) return "allow";

  return "propose";
}

/**
 * Group proposals into PR groups based on the policy.
 *
 * Deterministic: same proposals, same policy, same groups.
 */
export function group(
  proposals: readonly UpdateProposal[],
  policy: DependaPolicy,
): readonly ProposalGroup[] {
  if (proposals.length === 0) return [];

  // Apply policy evaluation first — refuse proposals that the policy blocks
  const admitted = proposals.filter((p) => {
    const verdict = evaluate(p, policy);
    return verdict.action !== "refuse";
  });

  if (admitted.length === 0) return [];

  const groups: ProposalGroup[] = [];

  // Extract security proposals into their own group if securitySeparate
  if (policy.securitySeparate) {
    const security = admitted.filter((p) => p.updateType === "security");
    const nonSecurity = admitted.filter((p) => p.updateType !== "security");

    if (security.length > 0) {
      groups.push({
        id: "security",
        ecosystem: null,
        proposals: sorted(security),
        security: true,
      });
    }

    if (nonSecurity.length === 0) return groups;
    return [...groups, ...groupByPolicy(nonSecurity, policy)];
  }

  return groupByPolicy(admitted, policy);
}

/**
 * Group proposals by the policy's grouping rule.
 */
function groupByPolicy(
  proposals: readonly UpdateProposal[],
  policy: DependaPolicy,
): readonly ProposalGroup[] {
  switch (policy.grouping) {
    case "single":
      return [
        {
          id: "all",
          ecosystem: null,
          proposals: sorted(proposals),
          security: false,
        },
      ];

    case "by-package":
      return proposals.map((p) => ({
        id: packageId(p),
        ecosystem: p.dependency.ecosystem,
        proposals: [p],
        security: false,
      }));

    case "by-ecosystem": {
      const byEco = new Map<Ecosystem, UpdateProposal[]>();
      for (const p of proposals) {
        const existing = byEco.get(p.dependency.ecosystem);
        if (existing !== undefined) {
          existing.push(p);
        } else {
          byEco.set(p.dependency.ecosystem, [p]);
        }
      }
      return Array.from(byEco.entries()).map(([ecosystem, props]) => ({
        id: ecosystem,
        ecosystem,
        proposals: sorted(props),
        security: false,
      }));
    }
  }
}

/** Stable group ID for a single-package group. */
function packageId(proposal: UpdateProposal): string {
  // Sanitise for use in branch names — replace / with -
  return `${proposal.dependency.ecosystem}-${proposal.dependency.name.replace(/\//g, "-")}`;
}

/** Sort proposals by name, then by version (stable sort). */
function sorted(proposals: readonly UpdateProposal[]): readonly UpdateProposal[] {
  return [...proposals].sort((a, b) => {
    const nameCmp = a.dependency.name.localeCompare(b.dependency.name);
    if (nameCmp !== 0) return nameCmp;
    return a.targetVersion.localeCompare(b.targetVersion);
  });
}
