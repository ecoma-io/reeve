/**
 * Intent-contract tests — the intent matrix's B3 dry-run and D3/authority rows,
 * exercised through the REAL dependa publish gate.
 *
 * `publish.test.ts` pins the API-call outcomes, but never the `dryRun` branch:
 * it returns "draft" before any ref is touched, and the caller's `mayPublish`
 * (`main.ts:488`) is exactly `canEdit && canOpenPr && !dryRun` — three
 * authorities that all must hold before a single mutation is attempted.
 *
 * The dry-run test proves the mutation budget is untouched on a dry run: every
 * call that would change the repository is represented by a test double that
 * fails hard if invoked. Any future "dry run but actually publish" regression
 * flips a call and red-fails here.
 */

import { describe, expect, it, vi } from "vitest";

import type { ProposalGroup } from "./model.js";
import { publishGroup, type PublishApi } from "./publish.js";

const AT = { owner: "acme", repo: "widgets" };

/** The base API that `publish.test.ts` already proves the real path needs. */
function baseApi(): PublishApi {
  return {
    rest: {
      repos: {
        get: () => Promise.resolve({ data: { default_branch: "main" } }),
        getContent: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
        createOrUpdateFileContents: () => Promise.resolve({}),
        listCommits: () =>
          Promise.resolve({
            data: [{ sha: "abc", author: { login: "github-actions[bot]" }, committer: null }],
          }),
        compareCommits: () =>
          Promise.resolve({
            data: {
              ahead_by: 1,
              behind_by: 0,
              commits: [{ sha: "abc", author: { login: "github-actions[bot]" }, committer: null }],
            },
          }),
      },
      git: {
        getRef: () => Promise.resolve({ data: { object: { sha: "branch-sha" } } }),
        createRef: () => Promise.resolve({}),
        updateRef: () => Promise.resolve({}),
      },
      pulls: {
        list: () => Promise.resolve({ data: [] }),
        create: () => Promise.resolve({ data: { number: 1 } }),
        update: () => Promise.resolve({}),
      },
    },
  };
}

function proposal(): ProposalGroup["proposals"][number] {
  return {
    dependency: {
      ecosystem: "npm",
      name: "lodash",
      constraint: "^4.0.0",
      currentVersion: "4.17.21",
      manifestPath: "package.json",
      dev: false,
      manager: "npm",
    },
    currentVersion: "4.17.21",
    targetVersion: "4.17.22",
    updateType: "patch",
    releases: [],
    securityAdvisory: null,
    risk: {
      facts: {
        updateType: "patch",
        majorDistance: 0,
        minorDistance: 0,
        patchDistance: 1,
        daysBetweenReleases: null,
        currentVersionStale: null,
        isSecurity: false,
        hasChangelog: false,
        isDev: false,
      },
      interpretation: null,
    },
    evidence: [],
    edits: [],
    groupName: null,
  };
}

function group(): ProposalGroup {
  return {
    id: "npm",
    ecosystem: "npm",
    proposals: [proposal()],
    security: false,
    lockfilePaths: [],
  };
}

describe("B3 — dry-run is a property of the publish gate, not a style of the report", () => {
  it("reports `draft` and touches no mutation while the run is a dry run", async () => {
    const api = baseApi();
    const mutations = {
      reposCreateUpdate: vi.spyOn(api.rest.repos, "createOrUpdateFileContents"),
      gitCreateRef: vi.spyOn(api.rest.git, "createRef"),
      gitUpdateRef: vi.spyOn(api.rest.git, "updateRef"),
      pullsCreate: vi.spyOn(api.rest.pulls, "create"),
      pullsUpdate: vi.spyOn(api.rest.pulls, "update"),
    };

    const result = await publishGroup(api, AT, group(), true, false);

    expect(result.outcome).toBe("draft");
    expect(result.pr).toBeNull();
    for (const [name, mutation] of Object.entries(mutations)) {
      expect(mutation, `${name} must not be called on a dry run`).not.toHaveBeenCalled();
    }
  });

  it("the real run reaches at least the pull-request create — dry-run is what stopped it", async () => {
    const api = baseApi();
    const createPr = vi.spyOn(api.rest.pulls, "create");

    await publishGroup(api, AT, group(), false, false);

    expect(createPr).toHaveBeenCalled();
  });
});
