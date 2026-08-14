/**
 * Shared infrastructure for writing state files to a branch and opening a
 * pull request — the pattern both `harmonise` (provenance) and `triage`
 * (corrections) use when `state-branch` is configured.
 *
 * This module provides the git and PR mechanics. Each duty supplies its own
 * branch name, file list, PR title, and PR body — the same separation
 * `publishSync` (harmonise) and `writeProposal` (triage/propose) already
 * follow, extracted here because the branch/PR operations are identical.
 *
 * **No merge method exists on {@link StateBranchApi}, ever.** "Can this
 * merge anything?" is answered by reading one interface, the same doctrine
 * `Effects` and `ProposalsApi` already enforce.
 */
import * as core from "@actions/core";

import { isCapacityError, isMissing, type Location } from "./forge.js";

/**
 * The GitHub calls state-branch publishing needs.
 *
 * Declared structurally and locally — the same pattern `PublishApi` and
 * `ProposalsApi` already follow — so a test can build one by hand and a
 * reviewer can see exactly what is reachable through it.
 */
export interface StateBranchApi {
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
      /**
       * Moves an existing ref to a new commit — a ref *move*, never a merge.
       * Used to reset the state branch back to the default branch head when
       * no open PR exists, the same pattern `propose.ts` uses to keep the
       * branch a clean staging area rather than a diverging feature branch.
       */
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

/** One file to write to the state branch. */
export interface StateFile {
  readonly path: string;
  readonly content: string;
  readonly message: string;
}

/**
 * Ensures the state branch exists and points at the default branch's current
 * head, creating it when it does not exist yet and resetting it when no open
 * PR is found (so the branch stays a clean staging area rather than diverging
 * from what it proposes to merge into).
 *
 * Returns the default branch name and its head SHA.
 */
export async function ensureBranch(
  api: StateBranchApi,
  at: Pick<Location, "owner" | "repo">,
  branchName: string,
): Promise<{ readonly defaultBranch: string; readonly baseSha: string } | null> {
  try {
    // Get the default branch's current head
    const { data: repo } = await api.rest.repos.get({ owner: at.owner, repo: at.repo });
    const defaultBranch = repo.default_branch ?? "main";
    const { data: baseRef } = await api.rest.git.getRef({
      owner: at.owner,
      repo: at.repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseSha = baseRef.object.sha;

    // Check if the state branch exists
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
      // Create the branch from the default branch head
      await api.rest.git.createRef({
        owner: at.owner,
        repo: at.repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      });
      core.info(`state-branch: created \`${branchName}\` from \`${defaultBranch}\``);
    } else {
      // Check for an existing open PR — if none, reset the branch to keep it
      // a clean staging area (same reasoning as propose.ts's resetBranch)
      const { data: prs } = await api.rest.pulls.list({
        owner: at.owner,
        repo: at.repo,
        state: "open",
        head: `${at.owner}:${branchName}`,
        per_page: 1,
      });

      if (prs.length === 0) {
        // No open PR — reset the branch to the default branch head
        await api.rest.git.updateRef({
          owner: at.owner,
          repo: at.repo,
          ref: `heads/${branchName}`,
          sha: baseSha,
          force: true,
        });
        core.info(
          `state-branch: reset \`${branchName}\` to \`${defaultBranch}\` head (no open PR)`,
        );
      }
    }

    return { defaultBranch, baseSha };
  } catch (error) {
    if (isCapacityError(error)) {
      core.warning(
        `state-branch: could not ensure branch \`${branchName}\` — capacity error. State may be stale.`,
      );
      return null;
    }
    throw error;
  }
}

/**
 * Publishes state files to a branch and opens or updates a draft pull request.
 *
 * Follows the same pattern as `publishSync` (harmonise) and `writeProposal`
 * (triage/propose):
 * - Ensures the branch exists and is up to date with the default branch
 * - Writes each file to the branch
 * - Finds or creates a draft PR
 *
 * Returns the PR number, or null if dry-run or nothing could be published.
 */
export async function publishState(
  api: StateBranchApi,
  at: Pick<Location, "owner" | "repo">,
  branchName: string,
  files: readonly StateFile[],
  prTitle: string,
  prBody: string,
  dryRun: boolean,
): Promise<{ pr: number } | null> {
  if (files.length === 0) return null;

  if (dryRun) {
    core.info(
      `dry-run: would write ${String(files.length)} file(s) to \`${branchName}\` and open PR`,
    );
    return null;
  }

  try {
    // Ensure the branch exists and is current
    const branch = await ensureBranch(api, at, branchName);
    if (branch === null) return null;
    const { defaultBranch } = branch;

    // Write each file to the branch
    for (const file of files) {
      // Read the file's current SHA on the branch (needed for update)
      let fileSha: string | undefined;
      try {
        const { data } = await api.rest.repos.getContent({
          owner: at.owner,
          repo: at.repo,
          path: file.path,
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
        path: file.path,
        message: file.message,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch: branchName,
        ...(fileSha !== undefined ? { sha: fileSha } : {}),
      });

      core.info(`state-branch: wrote ${file.path} on \`${branchName}\``);
    }

    // Check for an existing open PR on this branch
    const { data: existing } = await api.rest.pulls.list({
      owner: at.owner,
      repo: at.repo,
      state: "open",
      head: `${at.owner}:${branchName}`,
      per_page: 1,
    });

    const existingPr = existing[0];
    if (existingPr !== undefined) {
      // Update existing PR
      await api.rest.pulls.update({
        owner: at.owner,
        repo: at.repo,
        pull_number: existingPr.number,
        title: prTitle,
        body: prBody,
      });
      core.info(`state-branch: updated PR #${String(existingPr.number)}`);
      return { pr: existingPr.number };
    }

    // Create new draft PR
    const { data: pr } = await api.rest.pulls.create({
      owner: at.owner,
      repo: at.repo,
      title: prTitle,
      head: branchName,
      base: defaultBranch,
      body: prBody,
      draft: true,
    });

    core.info(`state-branch: opened PR #${String(pr.number)}`);
    return { pr: pr.number };
  } catch (error) {
    if (isCapacityError(error)) {
      core.warning(
        `state-branch: could not publish to \`${branchName}\` — capacity error. Files were not written.`,
      );
      return null;
    }
    throw error;
  }
}

/**
 * Opens or updates a draft PR on a state branch, after files have already been
 * written to it.
 *
 * Unlike {@link publishState}, this does not write any files — it assumes the
 * branch already exists and carries the commits from a prior write pass (e.g.
 *  `writeCorrection` writing corrections through the Contents API with
 * `branch`). This function only finds or creates the PR that wraps those
 * commits for maintainer review.
 *
 * Returns the PR number, or null if dry-run.
 */
export async function publishStatePr(
  api: StateBranchApi,
  at: Pick<Location, "owner" | "repo">,
  branchName: string,
  prTitle: string,
  prBody: string,
  dryRun: boolean,
): Promise<{ pr: number } | null> {
  if (dryRun) {
    core.info(`dry-run: would open PR on \`${branchName}\``);
    return null;
  }

  try {
    // Resolve the default branch name for the PR base
    const { data: repo } = await api.rest.repos.get({ owner: at.owner, repo: at.repo });
    const defaultBranch = repo.default_branch ?? "main";

    // Check for an existing open PR on this branch
    const { data: existing } = await api.rest.pulls.list({
      owner: at.owner,
      repo: at.repo,
      state: "open",
      head: `${at.owner}:${branchName}`,
      per_page: 1,
    });

    const existingPr = existing[0];
    if (existingPr !== undefined) {
      await api.rest.pulls.update({
        owner: at.owner,
        repo: at.repo,
        pull_number: existingPr.number,
        title: prTitle,
        body: prBody,
      });
      core.info(`state-branch: updated PR #${String(existingPr.number)}`);
      return { pr: existingPr.number };
    }

    // Create new draft PR
    const { data: pr } = await api.rest.pulls.create({
      owner: at.owner,
      repo: at.repo,
      title: prTitle,
      head: branchName,
      base: defaultBranch,
      body: prBody,
      draft: true,
    });

    core.info(`state-branch: opened PR #${String(pr.number)}`);
    return { pr: pr.number };
  } catch (error) {
    if (isCapacityError(error)) {
      core.warning(`state-branch: could not open PR on \`${branchName}\` — capacity error.`);
      return null;
    }
    throw error;
  }
}
