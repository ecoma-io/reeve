/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. The pipeline:
 *
 *   1. Read the warrant — or, missing one at the default path, build the
 *      implicit warrant. Resolve the dependa policy.
 *   1a. A written `duties:` block that does not name `dependa` is
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

import { isCapacityError, type Location, readContentsFile } from "../../core/forge.js";
import { createMeter } from "../../core/meter.js";
import { assembleClient, createWeather, rotateModels, settleAuth } from "../../core/provider.js";
import { warnIfStarved, failIfProtocolExhausted, writeRunSummary } from "../../core/summary.js";
import { openAuthority, type Authority, type Warrant } from "../../core/warrant.js";

import { budgetExhausted, createBudget } from "./budget.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";
import { createCratesDatasource } from "./datasources/crates.js";
import { createDockerRegistryDatasource } from "./datasources/docker-registry.js";
import { createGithubTagsDatasource } from "./datasources/github-tags.js";
import { createGoProxyDatasource } from "./datasources/go-proxy.js";
import { createNpmDatasource } from "./datasources/npm.js";
import { DatasourceRegistry } from "./datasources/registry.js";
import { queryAdvisories } from "./datasources/security-advisory.js";
import type { Datasource } from "./datasources/types.js";
import { gather as gatherEvidence, encloseEvidence } from "./evidence.js";
import { readSettings, type Settings } from "./inputs.js";
import type {
  FileEdit,
  GroupResult,
  ProposalGroup,
  Refusal,
  Release,
  ScheduleConfig,
  SecurityAdvisory,
  UpdateProposal,
  UpdateType,
} from "./model.js";
import { createCargoManager } from "./managers/cargo.js";
import { createDockerManager } from "./managers/docker.js";
import { createGithubActionsManager } from "./managers/github-actions.js";
import { createGoManager } from "./managers/go.js";
import { createNpmManager } from "./managers/npm.js";
import { discoverAll, ManagerRegistry } from "./managers/registry.js";
import type { Manager, ManagerId } from "./managers/types.js";
import { resolvePolicy, evaluate, group as groupProposals } from "./policy.js";
import { closeSupersededPRs, publishGroup, type PublishApi } from "./publish.js";
import { factsOnly, interpretationPrompt, parseInterpretation } from "./risk.js";
import { classify, candidateVersions, compare, isSha, parse, satisfies } from "./semver.js";
import { summarize, renderSummary } from "./summary.js";
import { validateEdits, validationRefusals } from "./validation.js";

/**
 * Filter releases to only those between the current version and the target
 * version (exclusive of current, inclusive of target).
 *
 * Releases outside this range are irrelevant to the update proposal — they
 * don't appear in the PR body evidence table, and the model shouldn't waste
 * context reading about versions this update doesn't touch.
 *
 * When either version cannot be parsed, returns the full list unfiltered —
 * a non-semver version (e.g. a Git SHA) means semver comparison doesn't
 * apply, and returning everything is safer than returning nothing.
 */
function filterReleases(
  releases: readonly Release[],
  currentVersion: string,
  targetVersion: string,
): readonly Release[] {
  const cur = parse(currentVersion);
  const tgt = parse(targetVersion);
  if (cur === null || tgt === null) return releases;
  return releases.filter((r) => {
    const v = parse(r.version);
    if (v === null) return false;
    return compare(v, cur) > 0 && compare(v, tgt) <= 0;
  });
}

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

    const permitted = authority.warrant.granted("dependa", DEFAULT_CAPABILITIES);

    settings = { ...base, permitted };

    // Resolve policy from warrant
    const warrantPolicy = authority.warrant.dependa ?? null;
    const policy = resolvePolicy(warrantPolicy, base.ecosystems);

    if (policy.allowedTypes.length === 0) {
      core.notice("dependa: no update types are allowed by the policy — nothing to propose.");
      settleAuth(weather);
      return;
    }

    // 1b. SCHEDULE — enforce the policy's schedule, if any.
    // Checked before any network calls (except the API call to read the last run).
    if (policy.schedule !== null) {
      const shouldRun = checkSchedule(policy.schedule, api, context.repo);
      if (!(await shouldRun)) {
        core.info("dependa: schedule indicates this run should be skipped.");
        settleAuth(weather);
        return;
      }
    }

    // 2. DISCOVER — scan repository file tree
    const managers = createManagerRegistry();
    const datasources = createDatasourceRegistry(base.token);

    const allFiles = await listRepositoryFiles(api, context.repo, base.paths);
    const activations = managers.select(allFiles);

    if (activations.length === 0) {
      core.info("dependa: no recognised dependency manifests found.");
      settleAuth(weather);
      return;
    }

    // Cache manifest content so applyUpdate can re-use it later
    const manifestContentCache = new Map<string, string>();
    // Track discovered manifest paths — only these are valid edit targets
    const discoveredManifestPaths = new Set<string>();

    const readFile = async (path: string): Promise<string | null> => {
      const cached = manifestContentCache.get(path);
      if (cached !== undefined) return cached;
      try {
        const contents = await readContentsFile(api, context.repo, path);
        const text = contents?.text ?? null;
        if (text !== null) manifestContentCache.set(path, text);
        return text;
      } catch {
        return null;
      }
    };

    const managerResults = await discoverAll(activations, readFile);
    let allDependencies = managerResults.flatMap((r) => r.dependencies);

    // Populate the set of discovered manifest paths — only these are valid
    // edit targets. The edit-path allowlist prevents proposals from writing
    // to arbitrary files that were never discovered as dependency manifests.
    for (const activation of activations) {
      for (const manifestPath of activation.manifests) {
        discoveredManifestPaths.add(manifestPath);
      }
    }

    if (allDependencies.length === 0) {
      core.info("dependa: no dependencies found in any manifest.");
      settleAuth(weather);
      return;
    }

    // Narrow by policy ecosystems — when the policy specifies ecosystems,
    // only those ecosystems are processed. An empty list means all.
    if (policy.ecosystems.length > 0) {
      const allowed = new Set(policy.ecosystems);
      const before = allDependencies.length;
      allDependencies = allDependencies.filter((d) => allowed.has(d.ecosystem));
      const removed = before - allDependencies.length;
      if (removed > 0) {
        core.info(
          `dependa: policy narrows ecosystems to [${policy.ecosystems.join(", ")}] — ${String(removed)} dependencies filtered out.`,
        );
      }
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
        // D12: non-capacity errors from datasources are transient weather,
        // not authority failures. Log and continue — one broken package should
        // not fail the entire run.
        core.warning(
          `dependa: datasource error for \`${dep.name}\` on ${dep.ecosystem}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      if (result.status !== "available") {
        if (result.status === "not-found") {
          core.info(`dependa: \`${dep.name}\` not found on the ${dep.ecosystem} registry`);
        } else if (result.status === "temporarily-unavailable") {
          core.warning(
            `dependa: ${dep.ecosystem} registry temporarily unavailable for \`${dep.name}\`: ${result.reason}`,
          );
        } else if (result.status === "auth-refused") {
          // The run's own token is the problem, not weather — fail red the
          // same way doctor does, with a hint that points at token scope.
          throw new Error(`dependa: ${result.reason}. Check the token's scope.`);
        } else {
          core.warning(
            `dependa: malformed metadata for \`${dep.name}\` on ${dep.ecosystem}: ${result.reason}`,
          );
        }
        continue;
      }

      // 4. CLASSIFY — deterministic semver comparison
      // Use candidateVersions to discover both within-constraint and
      // latest-available (major) updates, producing up to two proposals.
      const versions = result.releases.map((r) => r.version);
      const candidates = candidateVersions(versions, dep.constraint);

      // 5a. SECURITY — query advisory database once per dependency.
      // Security classification comes from explicit evidence only — never
      // from heuristics like the `deprecated` flag on an npm version.
      // A failed advisory query degrades gracefully (no security evidence) per D12.
      let advisories: readonly SecurityAdvisory[] = [];
      try {
        advisories = await queryAdvisories(base.token, dep.ecosystem, dep.name);
      } catch (error) {
        // The run's own token being refused is configuration, not weather —
        // fail red exactly as the datasource `auth-refused` path does. Any
        // other failure degrades to a warning per D12.
        if (error instanceof Error && error.name === "AuthRefused") {
          throw error;
        }
        core.warning(
          `dependa: could not query advisories for \`${dep.name}\` — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      for (const targetVersion of candidates) {
        if (targetVersion === dep.currentVersion) continue;

        // Determine update type with pin/digest awareness.
        // Security is checked PER CANDIDATE: a candidate is "security" only when
        // an advisory exists AND the current version is vulnerable AND the
        // target version resolves or mitigates it. This avoids marking major
        // updates as "security" when the vulnerability is already patched at
        // the target, or when the update doesn't address the vulnerability.
        const securityAdvisory = findSecurityAdvisoryFor(
          advisories,
          dep.currentVersion,
          targetVersion,
        );
        const isSecurity = securityAdvisory !== null;
        let updateType: UpdateType | null;

        // Digest update: current version is a SHA, target is a different SHA
        if (isSha(dep.currentVersion) && isSha(targetVersion)) {
          updateType = "digest";
        } else if (
          // Pin: constraint was floating (* / latest / null) and we're setting
          // an explicit version — the update is a pin, not a semver bump.
          (dep.constraint === null || dep.constraint === "*" || dep.constraint === "latest") &&
          dep.currentVersion === "" &&
          !isSecurity
        ) {
          updateType = "pin";
        } else {
          updateType = classify(dep.currentVersion, targetVersion, isSecurity);
        }

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
        const relevantReleases = filterReleases(result.releases, dep.currentVersion, targetVersion);
        const evidence = gatherEvidence(relevantReleases, securityAdvisory, new Map());

        // 6. RISK — deterministic facts, optional model interpretation
        // Pass the FULL releases list (not filtered) so computeFacts can find
        // the current version's release date for daysBetweenReleases and
        // currentVersionStale. filterReleases excludes the current version
        // (it returns (current, target]) which is correct for evidence but
        // would make date-based facts always null.
        const riskFacts = factsOnly({
          currentVersion: dep.currentVersion,
          targetVersion,
          updateType,
          releases: result.releases,
          securityAdvisory,
          evidence,
          isDev: dep.dev,
        });

        // 7. MODEL RISK INTERPRETATION — when drafts > 0 and models available
        let risk = riskFacts;
        if (settings.drafts > 0 && settings.models.length > 0) {
          const enclosed = encloseEvidence(evidence);
          const prompt = interpretationPrompt(
            {
              dependency: dep,
              currentVersion: dep.currentVersion,
              targetVersion,
              updateType,
              releases: relevantReleases,
              securityAdvisory,
              risk: riskFacts,
              evidence,
              edits: [],
              groupName: null,
            },
            riskFacts.facts,
            enclosed?.block ?? "",
            enclosed?.rule,
          );

          const rotation = await rotateModels(
            settings.models,
            (model) => client.stages.risk.complete(model, [{ role: "user", content: prompt }]),
            weather,
          );

          if (rotation.success) {
            const interpretation = parseInterpretation(rotation.success.content);
            if (interpretation !== null) {
              risk = { facts: riskFacts.facts, interpretation };
            }
          } else {
            failIfProtocolExhausted(settings.models, rotation.failures);
          }
        }

        // Compute file edits via the manager's applyUpdate.
        // Always compute against the ORIGINAL manifest content (not accumulated).
        // Per-group recomposition happens after grouping so that proposals in
        // different groups never contaminate each other and ignore rules are
        // evaluated before any edit is composed into a final file state.
        const edits: FileEdit[] = [];
        const manager = managers.get(dep.manager as ManagerId);
        const manifestContent = manifestContentCache.get(dep.manifestPath);
        if (manager !== undefined && manifestContent !== undefined) {
          const updatedContent = manager.applyUpdate(manifestContent, {
            dependency: dep,
            currentVersion: dep.currentVersion,
            targetVersion,
            updateType,
            releases: relevantReleases,
            securityAdvisory,
            risk,
            evidence,
            edits: [],
            groupName: null,
          });
          if (updatedContent !== null) {
            edits.push({
              path: dep.manifestPath,
              content: updatedContent,
              message: `dependa: update ${dep.name} ${dep.currentVersion} → ${targetVersion}`,
            });
          }
        }

        const proposal: UpdateProposal = {
          dependency: dep,
          currentVersion: dep.currentVersion,
          targetVersion,
          updateType,
          releases: relevantReleases,
          securityAdvisory,
          risk,
          evidence,
          edits,
          groupName: null,
        };

        // Skip proposals with no file edits — they would produce a no-op PR
        if (edits.length > 0) {
          proposals.push(proposal);
        } else {
          core.info(
            `dependa: no edits produced for \`${dep.name}\` ${dep.currentVersion} → ${targetVersion} — skipping`,
          );
        }
      }
    }

    if (proposals.length === 0) {
      core.info("dependa: no update proposals after classification and policy filtering.");
      settleAuth(weather);
      return;
    }

    // Warn when lockfile updates would be needed but cannot be generated.
    // dependa updates manifest constraints but does not regenerate lockfiles —
    // that requires running the package manager, which dependa cannot do.
    // The manifest-only update is still valid; the lockfile update is expected
    // to happen when the PR is merged and CI runs install.
    const lockfileManifestPaths = new Set<string>();
    for (const result of managerResults) {
      if (result.partial) {
        lockfileManifestPaths.add(result.manifestPath);
      }
    }
    if (lockfileManifestPaths.size > 0) {
      core.info(
        `dependa: ${String(lockfileManifestPaths.size)} manifest(s) had lockfiles — ` +
          "manifest constraints will be updated but lockfiles are not regenerated. " +
          "CI should run install after merge to update lockfiles.",
      );
    }

    // 8. GROUP — group proposals by policy
    const groups = groupProposals(proposals, policy, [...lockfileManifestPaths]);

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

      // 9b. RECOMPOSE — replay applyUpdate in group order so multiple edits
      // to the same manifest are composed cumulatively. Each proposal's edit
      // was computed against the ORIGINAL manifest content (step 4) so that
      // ignore-rule evaluation and grouping happen before any edit touches a
      // file. Recomposition here is the ONLY place where sequential edits are
      // combined; without it, the last edit would overwrite earlier ones and
      // only one dependency per file would survive.
      const recomposedEditsByPath = new Map<string, string>();
      for (const p of admitted) {
        for (const edit of p.edits) {
          const baseContent =
            recomposedEditsByPath.get(edit.path) ?? manifestContentCache.get(edit.path);
          if (baseContent === undefined) continue;
          const manager = managers.get(p.dependency.manager as ManagerId);
          if (manager === undefined) continue;
          const nextContent = manager.applyUpdate(baseContent, {
            ...p,
            edits: [],
            groupName: null,
          });
          if (nextContent !== null) {
            recomposedEditsByPath.set(edit.path, nextContent);
          }
        }
      }
      // Replace each proposal's edits with the cumulative final content.
      const recomposedProposals: UpdateProposal[] = admitted.map((p) => ({
        ...p,
        edits: p.edits.map((e) => {
          const finalContent = recomposedEditsByPath.get(e.path);
          return finalContent !== undefined ? { ...e, content: finalContent } : e;
        }),
      }));
      Object.assign(admittedGroup, { proposals: recomposedProposals });

      // 9c. VALIDATE — every edit must survive a round-trip check.
      // A failed validation prevents publication — this is a safety gate.
      const allEdits = admitted.flatMap((p) => p.edits);
      if (allEdits.length > 0) {
        const validation = validateEdits(allEdits, discoveredManifestPaths);
        if (!validation.valid) {
          const vRefusals = validationRefusals(validation.failed);
          core.warning(
            `dependa: ${String(validation.failed.length)} edit(s) in group \`${admittedGroup.id}\` failed validation.`,
          );
          refused.push(...vRefusals);

          // Drop proposals whose edits failed validation
          const failedPaths = new Set(validation.failed.map((f) => f.edit.path));
          const validated = admitted.filter((p) => !p.edits.some((e) => failedPaths.has(e.path)));
          if (validated.length === 0) {
            groupResults.push({ group: admittedGroup, pr: null, outcome: "refused", refused });
            continue;
          }
          const validatedGroup: ProposalGroup = { ...group, proposals: validated };
          // Overwrite admittedGroup with the validated subset
          Object.assign(admittedGroup, validatedGroup);
        }
      }

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
        const result = await publishGroup(
          publishApi,
          context.repo,
          admittedGroup,
          false,
          isDraft,
          policy.autoRebase,
        );
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

    // 11. AUTO-CLOSE — close superseded PRs when policy allows it.
    // Only runs after all groups have been published so we know the full set
    // of active group IDs. Groups that were refused or drafted still count as
    // "active" — their PRs should stay open (the proposal exists, just wasn't
    // published this run). Only groups that were never proposed at all (e.g.
    // dependency removed from manifest) trigger a close.
    if (policy.autoClose && mayPublish) {
      const activeGroupIds = new Set(groupResults.map((r) => r.group.id));
      try {
        const publishApi = api as unknown as PublishApi;
        const closedCount = await closeSupersededPRs(publishApi, context.repo, activeGroupIds);
        if (closedCount > 0) {
          core.info(`dependa: auto-closed ${String(closedCount)} superseded PR(s).`);
        }
      } catch (error) {
        // Auto-close is best-effort — don't fail the run if it errors.
        core.warning(
          `dependa: auto-close failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    settleAuth(weather);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (authority !== null) {
      const rosterStarved =
        settings !== null ? warnIfStarved(settings.models, weather, false) : false;
      const budgetSpent = budget.denied;

      // Set outputs — always set them when authority was resolved, even on
      // early-return paths (e.g. capabilities not granted). Consumers parse
      // these as JSON; an empty string would fail JSON.parse, so every exit
      // path must produce valid JSON arrays and booleans.
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
      const summary = summarize(groupResults, weather, settings?.models ?? [], budgetSpent);
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
    `\`${warrant.path}\`'s \`duties:\` block does not name \`dependa\`; once that block ` +
    "exists it is the whole answer, so add `dependa: [edit-file, open-pr]` to it " +
    "(or remove the block to return to defaults)."
  );
}

/**
 * Find the most relevant security advisory for a dependency at its current
 * version. An advisory is relevant when the current version falls within
 * its affected range — i.e., the advisory describes a vulnerability that
 * the current version has not yet patched.
 *
 * Returns the highest-severity relevant advisory, or null when none apply.
 * A failed advisory query degrades gracefully (no security evidence), per D12.
 */
/**
 * Find the most severe advisory that makes this update a security fix.
 *
 * A candidate is classified as "security" when:
 * 1. An advisory exists for the dependency.
 * 2. The CURRENT version is vulnerable (or we cannot determine it's safe).
 * 3. The TARGET version resolves or mitigates the vulnerability (is patched,
 *    or falls outside the vulnerable range).
 *
 * This avoids marking updates as "security" when:
 * - The current version is already patched (not vulnerable).
 * - The target version does not resolve the vulnerability (still vulnerable).
 *
 * When vulnerableRange and patchedVersions are both unavailable, an advisory
 * matching the package is treated as relevant — conservative safety.
 */
function findSecurityAdvisoryFor(
  advisories: readonly SecurityAdvisory[],
  currentVersion: string,
  targetVersion: string,
): SecurityAdvisory | null {
  if (advisories.length === 0) return null;

  const severityRank: ReadonlyMap<string, number> = new Map([
    ["critical", 4],
    ["high", 3],
    ["medium", 2],
    ["moderate", 2],
    ["low", 1],
  ]);

  let best: SecurityAdvisory | null = null;
  let bestRank = 0;

  for (const adv of advisories) {
    // Check whether the current version is affected by this advisory
    const currentAffected = isVersionAffectedBy(adv, currentVersion);
    // false → definitely not vulnerable, skip this advisory
    if (currentAffected === false) continue;

    // Check whether the target version resolves the vulnerability
    const targetPatched = isVersionPatchedBy(adv, targetVersion);
    // false → target is still vulnerable, this update doesn't fix it
    if (targetPatched === false) continue;

    // At this point: current is (possibly) affected AND target is (possibly) patched.
    // This advisory qualifies as a security reason for this update.
    const rank = severityRank.get(adv.severity) ?? 0;
    if (rank > bestRank) {
      best = adv;
      bestRank = rank;
    }
  }

  return best;
}

/**
 * Whether a version is affected by an advisory.
 *
 * Returns true/false/null based on available evidence. When no ranges are
 * provided, returns null (unknown) — the caller decides how to handle
 * uncertainty.
 */
function isVersionAffectedBy(advisory: SecurityAdvisory, version: string): boolean | null {
  const parsed = parse(version);
  if (parsed === null) return null;

  // Prefer explicit vulnerable_range
  if (advisory.vulnerableRange !== null) {
    const result = satisfies(parsed, advisory.vulnerableRange);
    if (result === true) return true;
    if (result === false) return false;
    // null means unparseable range — fall through to patched check
  }

  // If only patchedVersions is known: affected iff NOT patched
  if (advisory.patchedVersions !== null) {
    const patched = satisfies(parsed, advisory.patchedVersions);
    if (patched === true) return false;
    if (patched === false) return true;
  }

  // No determinable ranges — unknown
  return null;
}

/**
 * Whether a version is patched / outside the vulnerable range.
 *
 * Returns true/false/null. When no ranges are provided, returns null.
 */
function isVersionPatchedBy(advisory: SecurityAdvisory, version: string): boolean | null {
  const parsed = parse(version);
  if (parsed === null) return null;

  // If patchedVersions is known, check directly
  if (advisory.patchedVersions !== null) {
    const result = satisfies(parsed, advisory.patchedVersions);
    if (result === true) return true;
    if (result === false) return false;
  }

  // If only vulnerable_range is known: patched iff NOT in vulnerable range
  if (advisory.vulnerableRange !== null) {
    const affected = satisfies(parsed, advisory.vulnerableRange);
    if (affected === true) return false;
    if (affected === false) return true;
  }

  return null;
}

/**
 * List all files in the repository (default branch), optionally filtered by
 * the `paths` input. When `paths` is non-empty, only files whose path starts
 * with one of the given prefixes are returned.
 *
 * Uses the git tree API, same approach as `atlas.ts`.
 */
async function listRepositoryFiles(
  api: ReturnType<typeof getOctokit>,
  at: Pick<Location, "owner" | "repo">,
  paths: readonly string[],
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
        if (
          paths.length > 0 &&
          !paths.some((p) => item.path === p || item.path.startsWith(`${p}/`))
        ) {
          continue;
        }
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

// ── Cron matching (extracted for testability) ───────────────────────────────

/** Named-month aliases (case-insensitive). */
const CRON_MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Named-day-of-week aliases (case-insensitive). */
const CRON_DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Resolve a cron token to its numeric equivalent using an alias table. */
function resolveCronAlias(token: string, aliases: Record<string, number>): string {
  const lower = token.toLowerCase();
  if (lower in aliases) return String(aliases[lower]);
  return token;
}

/**
 * Check whether a single cron field matches the given value.
 * Supports: *, exact match, ranges (1-5), steps (star/2, 1-15/3),
 * comma lists (1,3,5), and named months/days via the aliases map.
 */
export function cronFieldMatches(
  field: string,
  value: number,
  max: number,
  aliases: Record<string, number> = {},
): boolean {
  // Resolve any named alias at the top level (e.g. "MON" → "1")
  const resolved = resolveCronAlias(field, aliases);
  if (resolved === "*") return true;
  if (resolved === String(value)) return true;
  // Handle comma-separated lists: "1,3,5" or "MON,WED,FRI"
  if (resolved.includes(",")) {
    return resolved.split(",").some((p) => cronFieldMatches(p.trim(), value, max, aliases));
  }
  // Handle steps: star/2, "1-15/3", "MON-FRI/2"
  if (resolved.includes("/")) {
    const slashParts = resolved.split("/");
    const range = slashParts[0] ?? "*";
    const stepStr = slashParts[1] ?? "1";
    const step = Number(stepStr);
    if (!Number.isSafeInteger(step) || step <= 0) return false;
    let lo = 0;
    let hi = max;
    if (range === "*") {
      // star/N — step from 0 to max
    } else if (range.includes("-")) {
      const rangeParts = range.split("-").map((s) => Number(resolveCronAlias(s, aliases)));
      lo = rangeParts[0] ?? 0;
      hi = rangeParts[1] ?? max;
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return false;
    } else {
      const start = Number(range);
      if (!Number.isSafeInteger(start)) return false;
      lo = start;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  }
  // Handle ranges: "1-5", "MON-FRI"
  if (resolved.includes("-")) {
    const rangeParts = resolved.split("-").map((s) => Number(resolveCronAlias(s, aliases)));
    const lo = rangeParts[0] ?? 0;
    const hi = rangeParts[1] ?? 0;
    return value >= lo && value <= hi;
  }
  return false;
}

/**
 * Check whether a 5-field cron expression matches the given date.
 * Returns true if the expression matches, false otherwise.
 * Returns true (degrades gracefully) for malformed expressions.
 */
export function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return true; // degrade gracefully

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  const minuteMatch = cronFieldMatches(minute, date.getMinutes(), 59);
  const hourMatch = cronFieldMatches(hour, date.getHours(), 23);
  // Month check (1-indexed in cron, 0-indexed in JS)
  const monthMatch = cronFieldMatches(month, date.getMonth() + 1, 12, CRON_MONTH_NAMES);
  // Day-of-month check
  const domMatch = cronFieldMatches(dom, date.getDate(), 31);
  // Day-of-week check (0 = Sunday in cron, 0 = Sunday in JS)
  const dowMatch = cronFieldMatches(dow, date.getDay(), 6, CRON_DOW_NAMES);

  // Standard cron DOM/DOW semantics:
  // - Both unrestricted (*) → always true
  // - Only DOM restricted → use domMatch only
  // - Only DOW restricted → use dowMatch only
  // - Both restricted → either match is sufficient (OR)
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const dayMatch =
    !domRestricted && !dowRestricted
      ? true
      : domRestricted && !dowRestricted
        ? domMatch
        : !domRestricted && dowRestricted
          ? dowMatch
          : domMatch || dowMatch;

  return minuteMatch && hourMatch && monthMatch && dayMatch;
}

/**
 * Check whether dependa should run according to the schedule.
 *
 * For interval schedules: find the most recent dependa PR update and check
 * if enough days have passed. When no previous PR exists, the schedule is
 * satisfied (first run is always allowed).
 *
 * For cron schedules: evaluate the cron expression against the current time.
 * A cron schedule means "only run when the expression matches" — this is a
 * simplified check: the expression's minute and hour must match the current
 * time, and day-of-month/day-of-week must also match.
 *
 * Degrades gracefully on API errors — a failed schedule check allows the run.
 */
async function checkSchedule(
  schedule: ScheduleConfig,
  api: ReturnType<typeof getOctokit>,
  at: Pick<Location, "owner" | "repo">,
): Promise<boolean> {
  if (schedule.kind === "interval") {
    try {
      // Find the most recent dependa PR to determine when dependa last ran.
      // We check open and recently-closed PRs on dependa branches.
      const { data: prs } = await api.rest.pulls.list({
        owner: at.owner,
        repo: at.repo,
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: 10,
      });

      // Find the most recent dependa PR
      const dependaPr = prs.find((pr) => pr.head.ref.startsWith("reeve/dependa/"));
      if (dependaPr === undefined) return true; // No previous run — allow

      // Use created_at instead of updated_at — updated_at advances on any
      // PR interaction (comments, labels, etc.), which would incorrectly
      // reset the interval timer. created_at reflects when the PR was opened.
      const lastCreated = new Date(dependaPr.created_at);
      const now = new Date();
      const daysSince = (now.getTime() - lastCreated.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSince < schedule.days) {
        core.info(
          `dependa: last run was ${daysSince.toFixed(1)} days ago — ` +
            `schedule requires at least ${String(schedule.days)} days. Skipping.`,
        );
        return false;
      }
      return true;
    } catch (error) {
      if (isCapacityError(error)) {
        core.warning("dependa: could not check schedule — capacity error. Allowing run.");
        return true;
      }
      core.warning(
        `dependa: could not check schedule — ${error instanceof Error ? error.message : String(error)}. Allowing run.`,
      );
      return true;
    }
  }

  // Cron schedule: simplified check — match minute, hour, day-of-month, day-of-week
  // After the interval branch above, schedule.kind is narrowed to "cron".
  const now = new Date();
  if (!cronMatches(schedule.expression, now)) {
    core.info(
      `dependa: cron schedule "${schedule.expression}" does not match current time. Skipping.`,
    );
    return false;
  }

  return true;
}

/**
 * Create the manager registry with all built-in managers.
 */
function createManagerRegistry(): ManagerRegistry {
  const managers: Manager[] = [
    createNpmManager(),
    createCargoManager(),
    createGoManager(),
    createDockerManager(),
    createGithubActionsManager(),
  ];
  return new ManagerRegistry(managers);
}

/**
 * Create the datasource registry with all built-in datasources.
 */
function createDatasourceRegistry(token: string): DatasourceRegistry {
  const datasources: Datasource[] = [
    createNpmDatasource(),
    createCratesDatasource(),
    createGoProxyDatasource(),
    createDockerRegistryDatasource(),
    createGithubTagsDatasource(token),
  ];
  return new DatasourceRegistry(datasources);
}

// Run on import — same pattern as every other duty
void run();
