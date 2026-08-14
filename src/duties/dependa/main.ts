/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. The pipeline:
 *
 *   1. Read the warrant — or, missing one at the default path, build the
 *      implicit warrant. Resolve the dependa policy.
 *   1a. A written `capabilities:` block that does not name `dependa` is
 *      checked here, once — the duty does nothing, and the run is green.
 *   2. Discover dependency manifests by scanning the file tree.
 *   3. Parse each manifest with its ecosystem's manager.
 *   4. For each dependency, query the datasource for available versions.
 *   5. Classify the update (deterministic semver comparison).
 *   6. Gather evidence (changelogs, release notes, security advisories).
 *   7. Compute risk facts (deterministic) + optional model interpretation.
 *   8. Group proposals by policy (by-ecosystem, by-package, or single).
 *   9. Evaluate each proposal against the policy (allow/propose/refuse).
 *  10. Enforce capabilities — `edit-file` + `open-pr` must both be granted.
 *  11. Publish: commit edits to a branch, open/update a draft PR.
 *
 * **A dependency that fails does not fail the run.** Only a broken
 * configuration is `setFailed` — everything else is a warning.
 *
 * **Idempotent.** If no dependency has a newer version, or all updates
 * are already proposed in an existing PR, the run does nothing. This is D9.
 *
 * **Human work is inviolable.** A manifest edited by a human since the
 * last dependa commit is reported as a conflict, never overwritten. D3.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { narrowWarned } from "../../core/enforce.js";
import { isCapacityError, type Location, readContentsFile } from "../../core/forge.js";
import { createMeter } from "../../core/meter.js";
import { assembleClient, createWeather, settleAuth } from "../../core/provider.js";
import { warnIfStarved, writeRunSummary } from "../../core/summary.js";
import { openAuthority, type Authority, type Warrant } from "../../core/warrant.js";

import { budgetExhausted, createBudget } from "./budget.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";
import { readSettings, type Settings } from "./inputs.js";
import type { GroupResult, ProposalGroup, Refusal, UpdateProposal } from "./model.js";
import { discoverAll, ManagerRegistry } from "./managers/registry.js";
import type { Manager } from "./managers/types.js";
import { DatasourceRegistry } from "./datasources/registry.js";
import type { Datasource } from "./datasources/types.js";
import { resolvePolicy, evaluate, group as groupProposals } from "./policy.js";
import { publishGroup, type PublishApi } from "./publish.js";
import { factsOnly } from "./risk.js";
import { classify, highestSatisfying } from "./semver.js";
import { summarize, renderSummary } from "./summary.js";

export async function run(): Promise<void> {
  const meter = createMeter();
  const budget = createBudget();
  let weather = createWeather();
  let settings: Settings | null = null;
  let authority: Authority | null = null;
  const groupResults: GroupResult[] = [];

  try {
    const base = readSettings();
    const client = assembleClient(base, meter, ["risk"] as const, [[]]);
    weather = client.weather;
    const api = getOctokit(base.token);

    // 1. AUTHORITY
    const opened = await openAuthority(base.warrant, api, context.repo, "dependa");
    authority = opened.authority;

    if (authority.warrant.unnamed("dependa")) {
      core.notice(notGranted(authority.warrant));
      settleAuth(weather);
      return;
    }

    const { permitted } = narrowWarned(
      authority.warrant.granted("dependa", DEFAULT_CAPABILITIES),
      base.apply,
      "dependa",
      base.warrant,
    );

    settings = { ...base, permitted };

    // Resolve policy from warrant
    const warrantPolicy = authority.warrant.dependa ?? null;
    const policy = resolvePolicy(warrantPolicy, base.ecosystems);

    if (policy.allowedTypes.length === 0) {
      core.notice("dependa: no update types are allowed by the policy — nothing to propose.");
      settleAuth(weather);
      return;
    }

    // 2. DISCOVER — scan repository file tree
    const managers = createManagerRegistry();
    const datasources = createDatasourceRegistry(base.token);

    const allFiles = await listRepositoryFiles(api, context.repo);
    const activations = managers.select(allFiles);

    if (activations.length === 0) {
      core.info("dependa: no recognised dependency manifests found.");
      settleAuth(weather);
      return;
    }

    const readFile = async (path: string): Promise<string | null> => {
      try {
        const contents = await readContentsFile(api, context.repo, path);
        return contents?.text ?? null;
      } catch {
        return null;
      }
    };

    const managerResults = await discoverAll(activations, readFile);
    const allDependencies = managerResults.flatMap((r) => r.dependencies);

    if (allDependencies.length === 0) {
      core.info("dependa: no dependencies found in any manifest.");
      settleAuth(weather);
      return;
    }

    core.info(
      `dependa: found ${String(allDependencies.length)} dependencies across ${String(activations.length)} manifest(s)`,
    );

    // 3-7. For each dependency, resolve, classify, gather evidence, assess risk
    const proposals: UpdateProposal[] = [];

    for (const dep of allDependencies) {
      if (budgetExhausted(settings.maxRequests, meter, budget)) break;

      // 3. RESOLVE — query the datasource
      const datasource = datasources.forEcosystem(dep.ecosystem);
      if (datasource === undefined) {
        core.info(
          `dependa: no datasource for ecosystem \`${dep.ecosystem}\` — skipping ${dep.name}`,
        );
        continue;
      }

      let result;
      try {
        result = await datasource.resolve(dep.name);
      } catch (error) {
        if (isCapacityError(error)) {
          core.warning(`dependa: datasource for \`${dep.name}\` had a capacity error — skipping.`);
          continue;
        }
        throw error;
      }

      if (result.status !== "available") {
        if (result.status === "not-found") {
          core.info(`dependa: \`${dep.name}\` not found on the ${dep.ecosystem} registry`);
        } else if (result.status === "temporarily-unavailable") {
          core.warning(
            `dependa: ${dep.ecosystem} registry temporarily unavailable for \`${dep.name}\`: ${result.reason}`,
          );
        } else {
          core.warning(
            `dependa: malformed metadata for \`${dep.name}\` on ${dep.ecosystem}: ${result.reason}`,
          );
        }
        continue;
      }

      // 4. CLASSIFY — deterministic semver comparison
      const targetVersion = highestSatisfying(
        result.releases.map((r) => r.version),
        dep.constraint,
      );

      if (targetVersion === null || targetVersion === dep.currentVersion) {
        // No newer version that satisfies the constraint, or already on latest
        continue;
      }

      // Determine if this is a security update
      const isSecurity = result.releases.some((r) => r.version === targetVersion && r.deprecated);

      const updateType = classify(dep.currentVersion, targetVersion, isSecurity);
      if (updateType === null) {
        core.info(
          `dependa: could not classify update for \`${dep.name}\` from ${dep.currentVersion} to ${targetVersion}`,
        );
        continue;
      }

      // Check policy: is this update type allowed?
      if (!policy.allowedTypes.includes(updateType)) {
        continue;
      }

      // 5. EVIDENCE — gather releases between current and target
      const relevantReleases = result.releases;

      // Build the proposal with deterministic risk facts
      const proposal: UpdateProposal = {
        dependency: dep,
        currentVersion: dep.currentVersion,
        targetVersion,
        updateType,
        releases: relevantReleases,
        securityAdvisory: null, // TODO: integrate with GitHub Advisory DB
        risk: factsOnly({
          currentVersion: dep.currentVersion,
          targetVersion,
          updateType,
          releases: relevantReleases,
          securityAdvisory: null,
          evidence: [],
          isDev: dep.dev,
        }),
        evidence: [], // TODO: fetch changelogs and release notes
        edits: [], // TODO: compute file edits via manager.applyUpdate
        groupName: null,
      };

      proposals.push(proposal);
    }

    if (proposals.length === 0) {
      core.info("dependa: no update proposals after classification and policy filtering.");
      settleAuth(weather);
      return;
    }

    // 8. GROUP — group proposals by policy
    const groups = groupProposals(proposals, policy);

    if (groups.length === 0) {
      core.info("dependa: all proposals were refused by the policy.");
      settleAuth(weather);
      return;
    }

    // 9-11. ENFORCE, EFFECT, OBSERVE
    const canEdit = settings.permitted.includes("edit-file");
    const canOpenPr = settings.permitted.includes("open-pr");
    const mayPublish = canEdit && canOpenPr && !settings.dryRun;

    for (const group of groups) {
      if (budgetExhausted(settings.maxRequests, meter, budget)) {
        core.warning(
          "`max-requests` was reached, so remaining proposal groups were not attempted this run.",
        );
        break;
      }

      // 9. POLICY — evaluate each proposal
      const refused: Refusal[] = [];
      const admitted = group.proposals.filter((p) => {
        const verdict = evaluate(p, policy);
        if (verdict.action === "refuse") {
          refused.push({
            what: p.dependency.name,
            why: verdict.matchedRule ?? "policy refused this update",
          });
          return false;
        }
        return true;
      });

      if (admitted.length === 0) {
        groupResults.push({ group, pr: null, outcome: "refused", refused });
        continue;
      }

      const admittedGroup: ProposalGroup = { ...group, proposals: admitted };

      // 10. PUBLISH
      if (!mayPublish) {
        // Draft mode: proposals classified but not written
        groupResults.push({ group: admittedGroup, pr: null, outcome: "draft", refused });
        continue;
      }

      // Determine whether the PR should be a draft
      const maxAutoApprove = policy.autoApprove;
      const isDraft = admittedGroup.proposals.every((p) => {
        if (maxAutoApprove === "none") return true;
        const hierarchy: readonly string[] = ["patch", "minor", "major"];
        const autoIndex = hierarchy.indexOf(maxAutoApprove);
        const typeIndex = hierarchy.indexOf(p.updateType);
        // Security, pin, digest, rollback are auto-approved
        if (!hierarchy.includes(p.updateType)) return false;
        return typeIndex > autoIndex;
      });

      try {
        const publishApi = api as unknown as PublishApi;
        const result = await publishGroup(publishApi, context.repo, admittedGroup, false, isDraft);
        groupResults.push({
          group: admittedGroup,
          pr: result.pr,
          outcome: result.outcome,
          refused,
        });
      } catch (error) {
        if (isCapacityError(error)) {
          core.warning(
            `dependa: could not publish group \`${admittedGroup.id}\` — capacity error.`,
          );
          groupResults.push({ group: admittedGroup, pr: null, outcome: "draft", refused });
        } else {
          throw error;
        }
      }
    }

    settleAuth(weather);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (settings !== null && authority !== null) {
      const rosterStarved = warnIfStarved(settings.models, weather, false);
      const budgetSpent = budget.denied;

      // Set outputs
      const proposed = groupResults.filter((r) => r.outcome !== "refused").map((r) => r.group.id);
      const refused = groupResults.filter((r) => r.outcome === "refused").map((r) => r.group.id);
      const prs = groupResults
        .filter((r) => r.pr !== null)
        .map((r) => ({ group: r.group.id, pr: r.pr }));

      core.setOutput("proposed", JSON.stringify(proposed));
      core.setOutput("refused", JSON.stringify(refused));
      core.setOutput(
        "security",
        JSON.stringify(groupResults.filter((r) => r.group.security).map((r) => r.group.id)),
      );
      core.setOutput("pull-requests", JSON.stringify(prs));
      core.setOutput("starved", String(rosterStarved));
      core.setOutput("budget-exhausted", String(budgetSpent));

      // Write job summary
      const summary = summarize(groupResults, weather, settings.models, budgetSpent);
      await writeRunSummary(renderSummary(summary), weather);
    }
  }
}

/**
 * The outcome of a run this duty was never going to be allowed to act on.
 * Green — enumerating who may act is a maintainer's decision.
 */
function notGranted(warrant: Warrant): string {
  return (
    `\`${warrant.path}\`'s \`capabilities:\` block does not name \`dependa\`; once that block ` +
    "exists it is the whole answer, so add `dependa: [edit-file, open-pr]` to it " +
    "(or remove the block to return to defaults)."
  );
}

/**
 * List all files in the repository (default branch).
 *
 * Uses the git tree API, same approach as `atlas.ts`.
 */
async function listRepositoryFiles(
  api: ReturnType<typeof getOctokit>,
  at: Pick<Location, "owner" | "repo">,
): Promise<readonly string[]> {
  const files: string[] = [];

  try {
    const { data: repo } = await api.rest.repos.get({ owner: at.owner, repo: at.repo });
    const branch = repo.default_branch;

    // Use the recursive tree endpoint
    const { data: tree } = await api.rest.git.getTree({
      owner: at.owner,
      repo: at.repo,
      tree_sha: branch,
      recursive: "true",
    });

    for (const item of tree.tree) {
      if (item.type === "blob") {
        files.push(item.path);
      }
    }
  } catch (error) {
    if (isCapacityError(error)) {
      core.warning("dependa: could not list repository files — capacity error.");
    } else {
      throw error;
    }
  }

  return files;
}

/**
 * Create the manager registry with all built-in managers.
 *
 * TODO: add actual manager implementations as they are built.
 * For now, this returns an empty registry so the pipeline can be tested.
 */
function createManagerRegistry(): ManagerRegistry {
  const managers: Manager[] = [];
  // Managers will be registered here as they are implemented
  // e.g., managers.push(new NpmManager());
  return new ManagerRegistry(managers);
}

/**
 * Create the datasource registry with all built-in datasources.
 *
 * TODO: add actual datasource implementations as they are built.
 * For now, this returns an empty registry so the pipeline can be tested.
 */
function createDatasourceRegistry(_token: string): DatasourceRegistry {
  const datasources: Datasource[] = [];
  // Datasources will be registered here as they are implemented
  // e.g., datasources.push(new NpmDatasource(token));
  return new DatasourceRegistry(datasources);
}

// Run on import — same pattern as every other duty
void run();
