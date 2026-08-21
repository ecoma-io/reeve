/**
 * Publishing for the `harmonise` duty: creating/updating files on a branch
 * and opening a pull request.
 *
 * Follows the same pattern as `propose.ts`:
 * - One branch per document group: `reeve/harmonise/<document-id>`
 * - One PR per document group
 * - Never commits directly to the default branch
 * - No merge method exists on the port
 * - Marker in the PR body identifies it as Reeve's work
 */
import * as core from "@actions/core";

import { isMissing, type Location } from "../../core/forge.js";
import { fingerprint, markerFor } from "../../core/marker.js";
import type { DocumentGroup } from "./discover.js";
import type { Draft } from "./draft.js";

/** The GitHub calls `harmonise` publish needs. */
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
      }): Promise<{
        data: { content?: { sha?: string } };
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
          /** Whether a closed pull request was closed BY MERGING. */
          readonly merged?: boolean;
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

const MARKER = markerFor("harmonise");

/**
 * Sanitises a document group ID for use as a git branch name segment.
 *
 * Git branch names cannot contain spaces, `~`, `^`, `:`, or start with `-`.
 * Replace any character not in `[a-zA-Z0-9._-]` with `-`, and ensure the
 * result does not start with `-`.
 */
export function sanitizeBranchSegment(id: string): string {
  const safe = id.replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
  return safe.startsWith("-") ? `branch${safe}` : safe;
}

/** One document group's sync result, ready for publishing. */
export interface SyncResult {
  readonly group: DocumentGroup;
  readonly drafts: ReadonlyMap<string, Draft>;
  readonly conflicts: readonly string[];
  /**
   * Locales whose file did not exist before this sync — bootstrap
   * translations, called out in the PR body so a reviewer knows they are
   * reading a machine's first draft rather than an update to human work.
   */
  readonly created: readonly string[];
}

/**
 * Publishes sync results for one document group as a pull request.
 *
 * Creates or updates a branch `reeve/harmonise/<document-id>`, writes the
 * updated locale files to it, and opens or updates a PR.
 *
 * Returns the PR number and the SHA each written locale file now has — the
 * provenance state records the real SHA, so a later human edit of that file is
 * seen as a conflict (D3) rather than being silently re-drafted. Null when
 * nothing could be published (all conflicts, or capacity error).
 */
export async function publishSync(
  api: PublishApi,
  at: Pick<Location, "owner" | "repo">,
  result: SyncResult,
  dryRun: boolean,
): Promise<{ pr: number; shas: ReadonlyMap<string, string> } | null> {
  if (result.drafts.size === 0) return null;

  // Get the default branch's current head
  const { data: repo } = await api.rest.repos.get({ owner: at.owner, repo: at.repo });
  const baseBranch = repo.default_branch ?? "main";
  const { data: baseRef } = await api.rest.git.getRef({
    owner: at.owner,
    repo: at.repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.object.sha;

  const branchName = `reeve/harmonise/${sanitizeBranchSegment(result.group.id)}`;

  if (dryRun) {
    core.info(
      `dry-run: would create/update branch \`${branchName}\` and open PR for ` +
        `${result.group.id} with ${String(result.drafts.size)} locale update(s)`,
    );
    return null;
  }

  // D3 — never reopen what a maintainer closed.
  //
  // A maintainer who closes a sync pull request without merging it has made a
  // decision, and `docs/doctrine/north-star.md:247` is repository-wide about
  // those: Reeve "never reopens or reassigns or closes what a maintainer
  // decided". Without this, the branch is still there, no OPEN pull request is
  // found, and the next run writes the locale files again and opens a new one
  // — re-proposing exactly what was just rejected, on every scheduled run.
  //
  // Merged is not refused: a merged pull request is work accepted, and the
  // next source change earns a fresh sync. The same check, for the same
  // reason, is `dependa/publish.ts:210-224`.
  const { data: closedPrs } = await api.rest.pulls.list({
    owner: at.owner,
    repo: at.repo,
    state: "closed",
    head: `${at.owner}:${branchName}`,
    per_page: 10,
  });
  const closedUnmerged = closedPrs.find((pr) => pr.merged !== true);
  if (closedUnmerged !== undefined) {
    core.info(
      `harmonise: PR #${String(closedUnmerged.number)} for \`${branchName}\` was ` +
        "closed without merge — D3: refusing to recreate it.",
    );
    return null;
  }

  // Locale code → the SHA the file now has on the branch, recorded so the
  // provenance state can name the real revision a sync left behind.
  const shas = new Map<string, string>();

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

  // Write each draft to the branch
  for (const [locale, draft] of result.drafts) {
    const filePath = result.group.files.get(locale);
    if (filePath === undefined) continue;

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

    const written = await api.rest.repos.createOrUpdateFileContents({
      owner: at.owner,
      repo: at.repo,
      path: filePath,
      message: `harmonise: sync ${locale} translation of ${result.group.id}`,
      content: Buffer.from(draft.text, "utf8").toString("base64"),
      branch: branchName,
      ...(fileSha !== undefined ? { sha: fileSha } : {}),
    });
    // The API answers the new blob SHA of the written file. When the shape
    // does not carry one (a proxy, a mock), leave the locale out of `shas` —
    // the caller keeps its prior record, and the next source change simply
    // treats the file as stale rather than as a false conflict.
    const newSha = written.data.content?.sha;
    if (typeof newSha === "string" && newSha.length > 0) shas.set(locale, newSha);

    core.info(`harmonise: wrote ${filePath} on \`${branchName}\``);
  }

  // Check for existing PR
  const { data: existing } = await api.rest.pulls.list({
    owner: at.owner,
    repo: at.repo,
    state: "open",
    head: `${at.owner}:${branchName}`,
    per_page: 1,
  });

  const title = `harmonise: sync ${result.group.id}`;
  const body = buildPrBody(result);

  const existingPr = existing[0];
  if (existingPr !== undefined) {
    // Update existing PR
    await api.rest.pulls.update({
      owner: at.owner,
      repo: at.repo,
      pull_number: existingPr.number,
      title,
      body,
    });
    core.info(`harmonise: updated PR #${String(existingPr.number)} for ${result.group.id}`);
    return { pr: existingPr.number, shas };
  }

  // Create new PR
  const { data: pr } = await api.rest.pulls.create({
    owner: at.owner,
    repo: at.repo,
    title,
    head: branchName,
    base: baseBranch,
    body,
    draft: true,
  });

  core.info(`harmonise: opened PR #${String(pr.number)} for ${result.group.id}`);
  return { pr: pr.number, shas };
}

/**
 * Builds the PR body with a marker for idempotency.
 *
 * Exported for testing — the PR body is a rendering function whose output
 * matters to a maintainer reading the PR, and whose structure must stay
 * in sync with the marker system.
 */
export function buildPrBody(result: SyncResult): string {
  const updated = [...result.drafts.keys()]
    .map((locale) =>
      result.created.includes(locale)
        ? `- \`${locale}\`: **initial translation created** — a machine first draft, needs native-speaker review`
        : `- \`${locale}\`: translation updated`,
    )
    .join("\n");
  const conflictSection =
    result.conflicts.length > 0
      ? `\n\n### Conflicts (not overwritten)\n\n${result.conflicts.map((locale) => `- \`${locale}\`: human edit since last sync`).join("\n")}`
      : "";

  const sourceKeys = [...result.drafts.keys()].sort();
  const fp = fingerprint(result.group.id, sourceKeys);

  return (
    `## harmonise sync\n\n` +
    `Document group: \`${result.group.id}\`\n\n` +
    `### Updated locales\n\n${updated}` +
    conflictSection +
    `\n\n---\n\n${MARKER.render(fp)}`
  );
}
