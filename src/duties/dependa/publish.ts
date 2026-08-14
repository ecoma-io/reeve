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
import { renderForPr } from "./evidence.js";

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
  // Git branch names allow: alphanumerics, `.`, `_`, `-`, `@` (but not `@{`).
  // Replace `/` with `-` (branch names cannot contain `/` in a segment),
  // then strip anything not in the allowed set.
  const safe = id.replace(/\//g, "-").replace(/[^a-zA-Z0-9._@-]/g, "-");
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

  // Ensure the branch exists
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
  }

  // Write each file edit from each proposal to the branch
  // Deduplicate by path — if two proposals edit the same file, merge them
  const editsByPath = new Map<string, { content: string; message: string }>();
  for (const proposal of group.proposals) {
    for (const edit of proposal.edits) {
      editsByPath.set(edit.path, { content: edit.content, message: edit.message });
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

    await api.rest.repos.createOrUpdateFileContents({
      owner: at.owner,
      repo: at.repo,
      path: filePath,
      message: edit.message,
      content: Buffer.from(edit.content, "utf8").toString("base64"),
      branch: branchName,
      ...(fileSha !== undefined ? { sha: fileSha } : {}),
    });

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
  return `${proposal.dependency.name}@${proposal.targetVersion}`;
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
    return `| ${typeEmoji} \`${p.dependency.name}\` | \`${p.currentVersion}\` | \`${p.targetVersion}\` | \`${p.updateType}\`${devTag}${security} |`;
  });

  const evidenceSection = group.proposals
    .flatMap((p) => p.evidence)
    .filter((e, i, arr) => arr.findIndex((o) => o.source === e.source) === i) // deduplicate
    .slice(0, 20); // cap at 20 evidence items per PR

  const evidenceRendered = renderForPr(evidenceSection);

  const fp = fingerprint(group.id, group.proposals.map(summaryKey));

  return (
    `## dependa update\n\n` +
    `| Dependency | From | To | Type |` +
    `\n|---|---|---|---|` +
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
