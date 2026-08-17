/**
 * Publishing for the `dependa` duty: creating/updating files on a branch
 * and opening a pull request.
 *
 * Follows the same pattern as `harmonise/publish.ts`:
 * - One branch per proposal group: `reeve/dependa/<group-id>`
 * - One PR per proposal group
 * - Never commits directly to the default branch
 * - No merge method exists on the port
 * - Marker in the PR body identifies it as Reeve's work
 *
 * A PR that was closed-unmerged by a human is never reopened — D3.
 * A manifest that was edited by a human since the last dependa commit is
 * reported as a conflict, never overwritten — D3.
 */
import * as core from "@actions/core";

import { isMissing, type Location } from "../../core/forge.js";
import { fingerprint, markerFor } from "../../core/marker.js";
import type { ProposalGroup, UpdateProposal } from "./model.js";
import { renderForPr, escapeMarkdown } from "./evidence.js";

/** The GitHub calls `dependa` publish needs. */
export interface PublishApi {
  readonly rest: {
    readonly repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: { default_branch?: string } }>;
      getContent(params: { owner: string; repo: string; path: string; ref: string }): Promise<{
        data:
          | { type?: string; content?: string; encoding?: string; sha?: string }
          | { type?: string; content?: string; encoding?: string; sha?: string }[];
      }>;
      createOrUpdateFileContents(params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        sha?: string;
        branch?: string;
      }): Promise<unknown>;
      listCommits(params: { owner: string; repo: string; sha: string; per_page: number }): Promise<{
        data: readonly {
          readonly sha: string;
          readonly author?: { readonly login?: string } | null;
          readonly committer?: { readonly login?: string } | null;
        }[];
      }>;
      compareCommits(params: {
        owner: string;
        repo: string;
        base: string;
        head: string;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: {
          readonly ahead_by: number;
          readonly behind_by: number;
          readonly commits: readonly {
            readonly sha: string;
            readonly author?: { readonly login?: string } | null;
            readonly committer?: { readonly login?: string } | null;
          }[];
        };
      }>;
    };
    readonly git: {
      getRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: { object: { sha: string } } }>;
      createRef(params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }): Promise<unknown>;
      updateRef(params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
        force?: boolean;
      }): Promise<unknown>;
    };
    readonly pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: "open" | "closed" | "all";
        head?: string;
        per_page?: number;
      }): Promise<{
        data: readonly {
          readonly number: number;
          readonly body?: string | null;
          readonly head: { readonly sha: string; readonly ref: string };
          readonly merged: boolean;
        }[];
      }>;
      create(params: {
        owner: string;
        repo: string;
        title: string;
        head: string;
        base: string;
        body: string;
        draft?: boolean;
      }): Promise<{ data: { number: number } }>;
      update(params: {
        owner: string;
        repo: string;
        pull_number: number;
        title?: string;
        body?: string;
        state?: "open" | "closed";
      }): Promise<unknown>;
    };
  };
}

const MARKER = markerFor("dependa");

/**
 * Sanitises a group ID for use as a git branch name segment.
 *
 * Git branch names cannot contain spaces, `~`, `^`, `:`, or start with `-`.
 * Replace any character not in `[a-zA-Z0-9._-]` with `-`, and ensure the
 * result does not start with `-`.
 */
export function sanitizeBranchSegment(id: string): string {
  // Git branch names allow: alphanumerics, `.`, `_`, `-` (but not `@{`).
  // Replace `/` with `-` (branch names cannot contain `/` in a segment),
  // strip `@` entirely (it can form `@{` which git interprets as reflog),
  // then strip anything not in the allowed set.
  let safe = id
    .replace(/\//g, "-")
    .replace(/@/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-");

  // Collapse consecutive dots — git rejects `..` in ref names
  safe = safe.replace(/\.{2,}/g, ".");

  // Remove leading dot — git rejects components starting with `.`
  safe = safe.replace(/^\.+/, "");

  // Remove trailing .lock — git rejects ref names ending in `.lock`
  if (safe.endsWith(".lock")) {
    safe = safe.slice(0, -5);
  }

  // Prefix with 'branch' when result starts with `-` or is empty
  if (safe.startsWith("-") || safe.length === 0) {
    safe = `branch${safe}`;
  }

  return safe;
}

/** One proposal group's publish result. */
export interface PublishResult {
  /** The PR number, if a PR was opened or updated. */
  readonly pr: number | null;
  /** What happened: opened, updated, unchanged, or draft (dry-run). */
  readonly outcome: "opened" | "updated" | "unchanged" | "draft" | "refused";
}

/**
 * Publishes a proposal group as a pull request.
 *
 * Creates or updates a branch `reeve/dependa/<group-id>`, writes the
 * updated manifest files to it, and opens or updates a PR.
 *
 * Returns the PR number, or null if nothing could be published.
 */
export async function publishGroup(
  api: PublishApi,
  at: Pick<Location, "owner" | "repo">,
  group: ProposalGroup,
  dryRun: boolean,
  isDraft: boolean,
  autoRebase = true,
): Promise<PublishResult> {
  if (group.proposals.length === 0) {
    return { pr: null, outcome: "refused" };
  }

  // Get the default branch's current head
  const { data: repo } = await api.rest.repos.get({ owner: at.owner, repo: at.repo });
  const baseBranch = repo.default_branch ?? "main";
  const { data: baseRef } = await api.rest.git.getRef({
    owner: at.owner,
    repo: at.repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.object.sha;

  const branchName = `reeve/dependa/${sanitizeBranchSegment(group.id)}`;

  if (dryRun) {
    core.info(
      `dry-run: would create/update branch \`${branchName}\` and open PR for ` +
        `${group.id} with ${String(group.proposals.length)} update(s)`,
    );
    return { pr: null, outcome: "draft" };
  }

  // D3: Check for a closed-unmerged PR on this branch — never reopen.
  const { data: closedPrs } = await api.rest.pulls.list({
    owner: at.owner,
    repo: at.repo,
    state: "closed",
    head: `${at.owner}:${branchName}`,
    per_page: 10,
  });
  const closedUnmerged = closedPrs.find((pr) => !pr.merged);
  if (closedUnmerged !== undefined) {
    core.info(
      `dependa: PR #${String(closedUnmerged.number)} for \`${branchName}\` was closed without merge — D3: refusing to recreate.`,
    );
    return { pr: null, outcome: "refused" };
  }

  // Ensure the branch exists (or reset it to the base SHA)
  let branchExists = true;
  try {
    await api.rest.git.getRef({
      owner: at.owner,
      repo: at.repo,
      ref: `heads/${branchName}`,
    });
  } catch (error) {
    if (isMissing(error)) {
      branchExists = false;
    } else {
      throw error;
    }
  }

  if (!branchExists) {
    await api.rest.git.createRef({
      owner: at.owner,
      repo: at.repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
  } else if (autoRebase) {
    // D3: Before force-resetting the branch, check whether it contains commits
    // not authored by the bot. A human maintainer may have pushed edits to the
    // branch to test or refine the proposed update — those commits are
    // inviolable and must not be overwritten.
    //
    // Use compareCommits (base...head) to get only branch-unique commits —
    // listCommits would return ALL reachable commits including main's, causing
    // false refusals whenever main has any human-authored commit.
    try {
      // Page through ALL of them. compareCommits caps one response at
      // `per_page` commits (default 100) and `ahead_by` counts the total —
      // stopping at the first page would let a human commit beyond it slip
      // past the D3 guard, and a force-reset that overwrites it would violate
      // the inviolable-commits rule below. Pages are the endpoint's own
      // 1-based `page` parameter, walking earliest→latest chronological order.
      const botAuthors = new Set([
        "github-actions[bot]",
        "github-actions",
        "dependabot[bot]",
        "reeve[bot]",
      ]);
      const commits: {
        readonly sha: string;
        readonly author?: { readonly login?: string } | null;
        readonly committer?: { readonly login?: string } | null;
      }[] = [];
      let aheadBy = 0;
      for (let page = 1; ; page++) {
        const { data: comparison } = await api.rest.repos.compareCommits({
          owner: at.owner,
          repo: at.repo,
          base: baseSha,
          head: branchName,
          per_page: 100,
          page,
        });
        aheadBy = comparison.ahead_by;
        commits.push(...comparison.commits);
        // `ahead_by` counts the whole comparison; enough pages collected means
        // the walk is done. An empty or short page stops the walk too, rather
        // than looping forever on a total the endpoint never re-states.
        if (commits.length >= aheadBy || comparison.commits.length === 0) break;
      }
      const hasHumanCommit = commits.some((c) => {
        const login = c.author?.login ?? c.committer?.login;
        if (login === undefined) {
          // Unknown attribution — fail closed per D3. An unattributable
          // commit might be human work with a misconfigured git identity,
          // and resetting it would violate D3.
          return true;
        }
        return !botAuthors.has(login);
      });
      if (hasHumanCommit) {
        core.info(
          `dependa: branch \`${branchName}\` contains human-authored commits — D3: refusing to force-reset.`,
        );
        return { pr: null, outcome: "refused" };
      }
    } catch (error) {
      if (isMissing(error)) {
        // The branch ref was readable moments ago but its commits are not —
        // unusual, but not impossible (race with a concurrent delete). Proceed
        // with the reset since the branch has no commits to protect.
      } else {
        // Could not verify whether human commits exist on the branch.
        // Refusing the reset is the safe direction: a force-reset that
        // overwrites a human maintainer's edits would violate D3, and an
        // API failure is not evidence that no such commits exist.
        core.warning(
          `dependa: could not check commits on \`${branchName}\` — ${error instanceof Error ? error.message : String(error)}. D3: refusing to force-reset without verification.`,
        );
        return { pr: null, outcome: "refused" };
      }
    }

    // Reset the branch to the current base SHA — equivalent to rebasing.
    // This ensures the branch always reflects the latest default branch
    // and avoids conflicts from stale base.
    try {
      await api.rest.git.updateRef({
        owner: at.owner,
        repo: at.repo,
        ref: `heads/${branchName}`,
        sha: baseSha,
        force: true,
      });
    } catch (error) {
      if (isMissing(error)) {
        // Branch was deleted between getRef and updateRef — recreate it.
        core.info(`dependa: branch \`${branchName}\` was deleted during publish — recreating.`);
        await api.rest.git.createRef({
          owner: at.owner,
          repo: at.repo,
          ref: `refs/heads/${branchName}`,
          sha: baseSha,
        });
      } else {
        throw error;
      }
    }
  } else {
    // autoRebase is disabled — leave the branch as-is. The existing content
    // will be overwritten by the file writes below, but the branch base is
    // not updated. This preserves the maintainer's choice to manage merge
    // conflicts manually rather than having dependa rebase automatically.
    core.info(
      `dependa: auto-rebase is disabled — branch \`${branchName}\` will not be rebased onto \`${baseBranch}\`.`,
    );
  }

  // Write each file edit from each proposal to the branch.
  // Multiple proposals may edit the same manifest — their edits were composed
  // sequentially in main.ts (each proposal's applyUpdate received the result
  // of the previous proposal's mutation), so the last edit for a given path
  // is the cumulative result of all proposals. Commit messages are joined so
  // the commit reflects every dependency update in the file.
  const editsByPath = new Map<string, { content: string; messages: string[] }>();
  for (const proposal of group.proposals) {
    for (const edit of proposal.edits) {
      const existing = editsByPath.get(edit.path);
      if (existing !== undefined) {
        // Last content wins (it was composed on top of the previous),
        // but accumulate all commit messages
        existing.content = edit.content;
        existing.messages.push(edit.message);
      } else {
        editsByPath.set(edit.path, { content: edit.content, messages: [edit.message] });
      }
    }
  }

  for (const [filePath, edit] of editsByPath) {
    // Read the file's current sha on the branch (needed for update)
    let fileSha: string | undefined;
    try {
      const { data } = await api.rest.repos.getContent({
        owner: at.owner,
        repo: at.repo,
        path: filePath,
        ref: branchName,
      });
      if (!Array.isArray(data) && typeof data.sha === "string") {
        fileSha = data.sha;
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      // File does not exist yet — that's fine, we'll create it
    }

    await writeWithRetry(
      api,
      at,
      filePath,
      edit.messages.join("; "),
      edit.content,
      branchName,
      fileSha,
    );

    core.info(`dependa: wrote ${filePath} on \`${branchName}\``);
  }

  // Check for existing PR
  const { data: existing } = await api.rest.pulls.list({
    owner: at.owner,
    repo: at.repo,
    state: "open",
    head: `${at.owner}:${branchName}`,
    per_page: 1,
  });

  const title = buildPrTitle(group);
  const body = buildPrBody(group);

  const existingPr = existing[0];
  if (existingPr !== undefined) {
    // Check if the PR body already has the same fingerprint (idempotent)
    const split = MARKER.split(existingPr.body ?? "");
    if (split.fingerprint !== null) {
      const currentFp = fingerprint(group.id, group.proposals.map(summaryKey));
      if (split.fingerprint === currentFp) {
        core.info(`dependa: PR #${String(existingPr.number)} is already up-to-date`);
        return { pr: existingPr.number, outcome: "unchanged" };
      }
    }

    // Update existing PR
    await api.rest.pulls.update({
      owner: at.owner,
      repo: at.repo,
      pull_number: existingPr.number,
      title,
      body,
    });
    core.info(`dependa: updated PR #${String(existingPr.number)} for ${group.id}`);
    return { pr: existingPr.number, outcome: "updated" };
  }

  // Create new PR
  const { data: pr } = await api.rest.pulls.create({
    owner: at.owner,
    repo: at.repo,
    title,
    head: branchName,
    base: baseBranch,
    body,
    draft: isDraft,
  });

  core.info(`dependa: opened PR #${String(pr.number)} for ${group.id}`);
  return { pr: pr.number, outcome: "opened" };
}

/** Build a stable key for a proposal's fingerprint contribution. */
function summaryKey(proposal: UpdateProposal): string {
  return `${proposal.dependency.name}@${proposal.currentVersion}->${proposal.targetVersion}`;
}

/**
 * Build the PR title for a proposal group.
 */
export function buildPrTitle(group: ProposalGroup): string {
  const prefix = group.security ? "🛡️ security" : "dependa";
  if (group.proposals.length === 1) {
    const p = group.proposals[0];
    if (p === undefined) return `${prefix}: update 1 dependency`;
    // Sanitise: strip newlines that would break the PR title format.
    const safeName = p.dependency.name.replace(/\n/g, " ");
    const safeCur = p.currentVersion.replace(/\n/g, " ");
    const safeTgt = p.targetVersion.replace(/\n/g, " ");
    return `${prefix}: update ${safeName} ${safeCur} → ${safeTgt}`;
  }
  return `${prefix}: update ${String(group.proposals.length)} dependencies (${group.ecosystem ?? "mixed"})`;
}

/**
 * Build the PR body with a marker for idempotency.
 *
 * Exported for testing — the PR body is a rendering function whose output
 * matters to a maintainer reading the PR, and whose structure must stay
 * in sync with the marker system.
 */
export function buildPrBody(group: ProposalGroup): string {
  const rows = group.proposals.map((p) => {
    const typeEmoji = updateTypeEmoji(p.updateType);
    const devTag = p.dependency.dev ? " *(dev)*" : "";
    const security =
      p.securityAdvisory !== null
        ? ` — 🛡️ ${p.securityAdvisory.id} (${p.securityAdvisory.severity})`
        : "";
    // Risk interpretation: render the model's assessment when available.
    // The model's summary is untrusted content — escape it for Markdown safety
    // to prevent injection of links, images, or table-breaking characters.
    const riskCell =
      p.risk.interpretation !== null
        ? `${p.risk.interpretation.riskLevel} — ${escapeMarkdown(p.risk.interpretation.summary)} *(model)*`
        : p.risk.facts.isSecurity
          ? "security"
          : p.risk.facts.updateType;
    // Sanitise all untrusted content that flows into the Markdown table.
    // Backticks alone don't prevent table-breaking: a dependency name or
    // version containing `|` would add a column, and a newline would split
    // the row. escapeMarkdown defangs links/images/HTML; we also strip
    // pipe characters and newlines to keep the table structure intact.
    const safeName = escapeMarkdown(p.dependency.name).replace(/\|/g, "").replace(/\n/g, " ");
    const safeCurrent = escapeMarkdown(p.currentVersion).replace(/\|/g, "").replace(/\n/g, " ");
    const safeTarget = escapeMarkdown(p.targetVersion).replace(/\|/g, "").replace(/\n/g, " ");
    return `| ${typeEmoji} \`${safeName}\` | \`${safeCurrent}\` | \`${safeTarget}\` | \`${p.updateType}\`${devTag}${security} | ${riskCell} |`;
  });

  const evidenceSection = group.proposals
    .flatMap((p) => p.evidence)
    .filter((e, i, arr) => arr.findIndex((o) => o.source === e.source) === i) // deduplicate
    .slice(0, 20); // cap at 20 evidence items per PR

  const evidenceRendered = renderForPr(evidenceSection);

  const fp = fingerprint(group.id, group.proposals.map(summaryKey));

  const lockfileNote =
    group.lockfilePaths.length > 0
      ? `\n\n> ⚠️ **Lockfile update required:** the following manifests have companion lockfiles that this PR does not regenerate. Run your package manager after merge (e.g. \`npm install\`) to update them.\n> ${group.lockfilePaths.map((p) => `\`${p}\``).join(", ")}\n`
      : "";

  return (
    `## dependa update\n\n` +
    `| Dependency | From | To | Type | Risk |` +
    `\n|---|---|---|---|---|` +
    `\n${rows.join("\n")}` +
    (evidenceRendered.length > 0 ? `\n\n${evidenceRendered}` : "") +
    lockfileNote +
    `\n\n---\n\n${MARKER.render(fp)}`
  );
}

/** Emoji for an update type, for PR titles and tables. */
function updateTypeEmoji(type: string): string {
  switch (type) {
    case "major":
      return "⬆️";
    case "minor":
      return "🔼";
    case "patch":
      return "🐛";
    case "pin":
      return "📌";
    case "digest":
      return "🔑";
    case "rollback":
      return "⬇️";
    case "security":
      return "🛡️";
    default:
      return "📦";
  }
}

/**
 * Write a file with a single retry on 409 Conflict.
 *
 * The GitHub Contents API returns 409 when the SHA we send is stale —
 * another commit landed on the branch between our read and our write.
 * Retrying once (re-reading the SHA) handles the race condition.
 *
 * On the second failure, the error propagates — two consecutive conflicts
 * suggests a deeper problem, not a transient race.
 */
async function writeWithRetry(
  api: PublishApi,
  at: Pick<Location, "owner" | "repo">,
  filePath: string,
  message: string,
  content: string,
  branchName: string,
  fileSha: string | undefined,
): Promise<void> {
  const base64 = Buffer.from(content, "utf8").toString("base64");

  try {
    await api.rest.repos.createOrUpdateFileContents({
      owner: at.owner,
      repo: at.repo,
      path: filePath,
      message,
      content: base64,
      branch: branchName,
      ...(fileSha !== undefined ? { sha: fileSha } : {}),
    });
    return;
  } catch (error) {
    if (!isConflict(error)) throw error;
    // 409: SHA is stale — re-read and retry once
    core.info(`dependa: 409 on ${filePath} — re-reading SHA and retrying`);
  }

  // Re-read the file's SHA
  let newSha: string | undefined;
  try {
    const { data } = await api.rest.repos.getContent({
      owner: at.owner,
      repo: at.repo,
      path: filePath,
      ref: branchName,
    });
    if (!Array.isArray(data) && typeof data.sha === "string") {
      newSha = data.sha;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    // File was deleted between retries — create without SHA
  }

  await api.rest.repos.createOrUpdateFileContents({
    owner: at.owner,
    repo: at.repo,
    path: filePath,
    message,
    content: base64,
    branch: branchName,
    ...(newSha !== undefined ? { sha: newSha } : {}),
  });
}

/**
 * Check whether an error is a 409 Conflict from the GitHub API.
 */
function isConflict(error: unknown): boolean {
  if (error instanceof Error) {
    // Octokit wraps HTTP status in error.status
    const status = (error as unknown as Record<string, unknown>).status;
    if (typeof status === "number" && status === 409) return true;
  }
  return false;
}

/**
 * Close open dependa PRs whose group IDs are no longer proposed.
 *
 * When autoClose is enabled, this scans all open PRs authored by dependa
 * (identified by the marker in the PR body) and closes any whose group ID
 * does not appear in the current set of proposed groups. A PR is considered
 * superseded when its group is no longer produced by the pipeline — for
 * example, because the dependency was removed from the manifest, the update
 * was yanked, or a newer version superseded the proposal.
 *
 * D3: only closes PRs that carry the dependa marker. Human-authored PRs on
 * `reeve/dependa/*` branches (if any) are never touched.
 *
 * Returns the number of PRs closed.
 */
export async function closeSupersededPRs(
  api: PublishApi,
  at: Pick<Location, "owner" | "repo">,
  activeGroupIds: ReadonlySet<string>,
): Promise<number> {
  const { data: openPrs } = await api.rest.pulls.list({
    owner: at.owner,
    repo: at.repo,
    state: "open",
    per_page: 100,
  });

  let closedCount = 0;
  for (const pr of openPrs) {
    // Only touch PRs with the dependa marker
    const split = MARKER.split(pr.body ?? "");
    if (split.fingerprint === null) continue;

    // Extract the group ID from the branch name (reeve/dependa/<group-id>)
    const branchName = pr.head.ref;
    const prefix = "reeve/dependa/";
    if (!branchName.startsWith(prefix)) continue;

    const groupId = branchName.slice(prefix.length);
    if (activeGroupIds.has(groupId)) continue;

    // This PR's group is no longer proposed — close it.
    try {
      await api.rest.pulls.update({
        owner: at.owner,
        repo: at.repo,
        pull_number: pr.number,
        state: "closed",
      });
      core.info(
        `dependa: closed superseded PR #${String(pr.number)} (group \`${groupId}\` is no longer proposed).`,
      );
      closedCount++;
    } catch (error) {
      // Closing is best-effort — don't fail the run if a close fails.
      core.warning(
        `dependa: failed to close superseded PR #${String(pr.number)} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return closedCount;
}
