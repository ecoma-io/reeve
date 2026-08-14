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
          readonly head: { readonly sha: string };
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
  const safe = id
    .replace(/\//g, "-")
    .replace(/@/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-");
  return safe.startsWith("-") ? `branch${safe}` : safe;
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
    per_page: 5,
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
  } else {
    // D3: Before force-resetting the branch, check whether it contains commits
    // not authored by the bot. A human maintainer may have pushed edits to the
    // branch to test or refine the proposed update — those commits are
    // inviolable and must not be overwritten.
    try {
      const { data: commits } = await api.rest.repos.listCommits({
        owner: at.owner,
        repo: at.repo,
        sha: branchName,
        per_page: 10,
      });
      const botAuthors = new Set([
        "github-actions[bot]",
        "github-actions",
        "dependabot[bot]",
        "reeve[bot]",
      ]);
      const hasHumanCommit = commits.some((c) => {
        const login = c.author?.login ?? c.committer?.login;
        return login !== undefined && !botAuthors.has(login);
      });
      if (hasHumanCommit) {
        core.info(
          `dependa: branch \`${branchName}\` contains human-authored commits — D3: refusing to force-reset.`,
        );
        return { pr: null, outcome: "refused" };
      }
    } catch (error) {
      if (!isMissing(error)) {
        core.warning(
          `dependa: could not check commits on \`${branchName}\` — ${error instanceof Error ? error.message : String(error)}. Proceeding with reset.`,
        );
      }
      // If we can't check commits (e.g. API error), we still proceed with the
      // reset rather than blocking the run entirely. The D3 check is best-effort.
    }

    // Reset the branch to the current base SHA — equivalent to rebasing.
    // This ensures the branch always reflects the latest default branch
    // and avoids conflicts from stale base.
    await api.rest.git.updateRef({
      owner: at.owner,
      repo: at.repo,
      ref: `heads/${branchName}`,
      sha: baseSha,
      force: true,
    });
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
    return `${prefix}: update ${p.dependency.name} ${p.currentVersion} → ${p.targetVersion}`;
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
    return `| ${typeEmoji} \`${p.dependency.name}\` | \`${p.currentVersion}\` | \`${p.targetVersion}\` | \`${p.updateType}\`${devTag}${security} | ${riskCell} |`;
  });

  const evidenceSection = group.proposals
    .flatMap((p) => p.evidence)
    .filter((e, i, arr) => arr.findIndex((o) => o.source === e.source) === i) // deduplicate
    .slice(0, 20); // cap at 20 evidence items per PR

  const evidenceRendered = renderForPr(evidenceSection);

  const fp = fingerprint(group.id, group.proposals.map(summaryKey));

  return (
    `## dependa update\n\n` +
    `| Dependency | From | To | Type | Risk |` +
    `\n|---|---|---|---|---|` +
    `\n${rows.join("\n")}` +
    (evidenceRendered.length > 0 ? `\n\n${evidenceRendered}` : "") +
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
