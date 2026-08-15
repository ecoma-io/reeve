/**
 * Tests for the dependa publish module.
 *
 * The publish module builds PR titles, PR bodies, and sanitises branch
 * segments. These tests verify the rendering functions and the branch
 * segment sanitiser. (The actual API calls are integration-level and
 * require a mock GitHub API.)
 */
import { describe, expect, it } from "vitest";

import type { ProposalGroup, UpdateProposal } from "./model.js";

import {
  buildPrBody,
  buildPrTitle,
  closeSupersededPRs,
  publishGroup,
  sanitizeBranchSegment,
} from "./publish.js";
import type { PublishApi } from "./publish.js";

// ── helpers ──────────────────────────────────────────────────────────────

function proposal(overrides: Partial<UpdateProposal> = {}): UpdateProposal {
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
    ...overrides,
  };
}

function group(overrides: Partial<ProposalGroup> = {}): ProposalGroup {
  return {
    id: "npm",
    ecosystem: "npm",
    proposals: [proposal()],
    security: false,
    lockfilePaths: [],
    ...overrides,
  };
}

// ── sanitizeBranchSegment ───────────────────────────────────────────────

describe("sanitizeBranchSegment", () => {
  it("passes through safe characters", () => {
    expect(sanitizeBranchSegment("npm")).toBe("npm");
    expect(sanitizeBranchSegment("by-ecosystem")).toBe("by-ecosystem");
  });

  it("replaces slashes and at-signs with dashes", () => {
    // @ is replaced with -, / becomes -, leading dash gets "branch" prefix
    expect(sanitizeBranchSegment("@types/node")).toBe("branch-types-node");
  });

  it("replaces unsafe characters with dashes", () => {
    expect(sanitizeBranchSegment("name with spaces")).toBe("name-with-spaces");
  });

  it("prefixes with 'branch' when result starts with dash", () => {
    expect(sanitizeBranchSegment("-leading-dash")).toBe("branch-leading-dash");
  });

  it("collapses double dots (git rejects .. in ref names)", () => {
    expect(sanitizeBranchSegment("v1..v2")).toBe("v1.v2");
    expect(sanitizeBranchSegment("a...b")).toBe("a.b");
  });

  it("strips leading dots (git rejects components starting with .)", () => {
    expect(sanitizeBranchSegment(".git")).toBe("git");
    expect(sanitizeBranchSegment("..hidden")).toBe("hidden");
  });

  it("strips trailing .lock (git rejects ref names ending in .lock)", () => {
    expect(sanitizeBranchSegment("package.lock")).toBe("package");
  });

  it("returns 'branch' for empty input (git rejects empty ref names)", () => {
    expect(sanitizeBranchSegment("")).toBe("branch");
  });
});

// ── buildPrTitle ─────────────────────────────────────────────────────────

describe("buildPrTitle", () => {
  it("builds title for single proposal", () => {
    const g = group();
    const title = buildPrTitle(g);
    expect(title).toBe("dependa: update lodash 4.17.21 → 4.17.22");
  });

  it("builds title for multiple proposals", () => {
    const g = group({
      proposals: [
        proposal({
          dependency: {
            ecosystem: "npm",
            name: "lodash",
            constraint: "^4.0.0",
            currentVersion: "4.17.21",
            manifestPath: "package.json",
            dev: false,
            manager: "npm",
          },
        }),
        proposal({
          dependency: {
            ecosystem: "npm",
            name: "express",
            constraint: "^4.0.0",
            currentVersion: "4.18.0",
            manifestPath: "package.json",
            dev: false,
            manager: "npm",
          },
          targetVersion: "4.19.0",
        }),
      ],
    });

    const title = buildPrTitle(g);
    expect(title).toBe("dependa: update 2 dependencies (npm)");
  });

  it("uses security prefix for security groups", () => {
    const g = group({
      security: true,
      proposals: [proposal({ updateType: "security" })],
    });

    const title = buildPrTitle(g);
    expect(title).toContain("🛡️ security");
  });
});

// ── buildPrBody ──────────────────────────────────────────────────────────

describe("buildPrBody", () => {
  it("includes a Markdown table with dependency info", () => {
    const body = buildPrBody(group());
    expect(body).toContain("## dependa update");
    expect(body).toContain("| Dependency | From | To | Type |");
    expect(body).toContain("lodash");
    expect(body).toContain("4.17.21");
    expect(body).toContain("4.17.22");
  });

  it("includes marker for idempotency", () => {
    const body = buildPrBody(group());
    expect(body).toContain("reeve:dependa");
  });

  it("marks dev dependencies", () => {
    const g = group({
      proposals: [
        proposal({
          dependency: {
            ecosystem: "npm",
            name: "jest",
            constraint: "^29.0.0",
            currentVersion: "29.0.0",
            manifestPath: "package.json",
            dev: true,
            manager: "npm",
          },
        }),
      ],
    });
    const body = buildPrBody(g);
    expect(body).toContain("*(dev)*");
  });

  it("includes security advisory info", () => {
    const g = group({
      proposals: [
        proposal({
          updateType: "security",
          securityAdvisory: {
            id: "CVE-2024-0001",
            severity: "high",
            summary: "RCE",
            patchedVersions: ">=4.18.0",
            vulnerableRange: null,
          },
        }),
      ],
    });
    const body = buildPrBody(g);
    expect(body).toContain("CVE-2024-0001");
    expect(body).toContain("high");
  });

  it("does not include evidence section when no evidence", () => {
    const body = buildPrBody(group());
    expect(body).not.toContain("### Evidence");
  });

  it("includes evidence section when evidence exists", () => {
    const g = group({
      proposals: [
        proposal({
          evidence: [
            {
              kind: "changelog",
              source: "https://example.com/changelog",
              content: "Bug fixes and improvements",
              deterministic: true,
            },
          ],
        }),
      ],
    });
    const body = buildPrBody(g);
    expect(body).toContain("### Evidence");
  });

  it("defangs Markdown table injection from dependency names and versions", () => {
    const g = group({
      proposals: [
        proposal({
          dependency: {
            ecosystem: "npm",
            name: "evil|name\n| injected | row |",
            constraint: "^1.0.0",
            currentVersion: "1.0.0|old",
            manifestPath: "package.json",
            dev: false,
            manager: "npm",
          },
          currentVersion: "1.0.0|old",
          targetVersion: "2.0.0\n| injected |",
        }),
      ],
    });

    const body = buildPrBody(g);
    expect(body).not.toContain("evil|name");
    expect(body).not.toContain("1.0.0|old");
    expect(body).not.toContain("\n| injected |");
    expect(body).toContain("`evilname  injected  row `");
  });
});

// ── publishGroup: D3 force-reset safety ──────────────────────────────────

describe("publishGroup: D3 branch safety", () => {
  const AT = { owner: "acme", repo: "widgets" };

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
                commits: [
                  { sha: "abc", author: { login: "github-actions[bot]" }, committer: null },
                ],
              },
            }),
        },
        git: {
          getRef: () => {
            // Branch exists by default — return a valid ref
            return Promise.resolve({ data: { object: { sha: "branch-sha" } } });
          },
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

  it("refuses force-reset when compareCommits fails with a non-404 API error", async () => {
    const apiError = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const base = baseApi();
    base.rest.repos.compareCommits = () => Promise.reject(apiError);

    const result = await publishGroup(base, AT, group(), false, true);

    expect(result.outcome).toBe("refused");
    expect(result.pr).toBeNull();
  });

  it("proceeds with force-reset when compareCommits returns only bot-authored branch-unique commits", async () => {
    const base = baseApi();
    base.rest.repos.compareCommits = () =>
      Promise.resolve({
        data: {
          ahead_by: 2,
          behind_by: 0,
          commits: [
            { sha: "a1", author: { login: "github-actions[bot]" }, committer: null },
            { sha: "b2", author: { login: "reeve[bot]" }, committer: null },
          ],
        },
      });

    // Should not refuse — bot-only branch-unique commits means safe to reset
    const result = await publishGroup(base, AT, group(), false, true);
    expect(result.outcome).not.toBe("refused");
  });

  it("refuses force-reset when compareCommits finds a human-authored branch-unique commit", async () => {
    const base = baseApi();
    base.rest.repos.compareCommits = () =>
      Promise.resolve({
        data: {
          ahead_by: 2,
          behind_by: 0,
          commits: [
            { sha: "a1", author: { login: "github-actions[bot]" }, committer: null },
            { sha: "b2", author: { login: "maintainer" }, committer: null },
          ],
        },
      });

    const result = await publishGroup(base, AT, group(), false, true);
    expect(result.outcome).toBe("refused");
    expect(result.pr).toBeNull();
  });

  it("refuses force-reset when a branch-unique commit has unknown attribution (fail closed)", async () => {
    const base = baseApi();
    base.rest.repos.compareCommits = () =>
      Promise.resolve({
        data: {
          ahead_by: 1,
          behind_by: 0,
          commits: [{ sha: "x1", author: null, committer: null }],
        },
      });

    const result = await publishGroup(base, AT, group(), false, true);
    expect(result.outcome).toBe("refused");
    expect(result.pr).toBeNull();
  });

  it("proceeds with force-reset when compareCommits shows zero branch-unique commits", async () => {
    const base = baseApi();
    base.rest.repos.compareCommits = () =>
      Promise.resolve({
        data: {
          ahead_by: 0,
          behind_by: 5,
          commits: [],
        },
      });

    const result = await publishGroup(base, AT, group(), false, true);
    expect(result.outcome).not.toBe("refused");
  });

  it("skips force-reset when autoRebase is false and branch exists", async () => {
    let updateRefCalled = false;
    let compareCommitsCalled = false;
    const base = baseApi();
    base.rest.git.updateRef = () => {
      updateRefCalled = true;
      return Promise.resolve({});
    };
    base.rest.repos.compareCommits = () => {
      compareCommitsCalled = true;
      return Promise.resolve({
        data: { ahead_by: 0, behind_by: 0, commits: [] },
      });
    };

    // autoRebase=false (6th arg)
    const result = await publishGroup(base, AT, group(), false, true, false);

    expect(result.outcome).not.toBe("refused");
    expect(compareCommitsCalled).toBe(false);
    expect(updateRefCalled).toBe(false);
  });

  it("force-resets when autoRebase is true (default) and branch exists", async () => {
    let updateRefCalled = false;
    const base = baseApi();
    base.rest.git.updateRef = () => {
      updateRefCalled = true;
      return Promise.resolve({});
    };

    // autoRebase=true (default)
    const result = await publishGroup(base, AT, group(), false, true, true);

    expect(result.outcome).not.toBe("refused");
    expect(updateRefCalled).toBe(true);
  });
});

// ── closeSupersededPRs ────────────────────────────────────────────────────

describe("closeSupersededPRs", () => {
  const AT = { owner: "acme", repo: "widgets" };

  function markerBody(groupId: string): string {
    // Build a body that contains the dependa marker with a valid fingerprint.
    // The marker format is defined by core/marker.js — we use buildPrBody to
    // generate a valid one, then extract just the marker line.
    const g = group({ id: groupId });
    const body = buildPrBody(g);
    return body;
  }

  function makePr(number: number, branchName: string, body: string) {
    return {
      number,
      body,
      head: { sha: "abc123", ref: branchName },
      merged: false,
    };
  }

  it("closes PRs whose group IDs are not in the active set", async () => {
    const closedPrs: number[] = [];
    const api: PublishApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
          createOrUpdateFileContents: () => Promise.resolve({}),
          listCommits: () => Promise.resolve({ data: [] }),
          compareCommits: () =>
            Promise.resolve({ data: { ahead_by: 0, behind_by: 0, commits: [] } }),
        },
        git: {
          getRef: () => Promise.resolve({ data: { object: { sha: "sha" } } }),
          createRef: () => Promise.resolve({}),
          updateRef: () => Promise.resolve({}),
        },
        pulls: {
          list: () =>
            Promise.resolve({
              data: [
                makePr(10, "reeve/dependa/npm", markerBody("npm")),
                makePr(11, "reeve/dependa/cargo", markerBody("cargo")),
                makePr(12, "reeve/dependa/go", markerBody("go")),
              ],
            }),
          create: () => Promise.resolve({ data: { number: 99 } }),
          update: (params) => {
            if (params.state === "closed") {
              closedPrs.push(params.pull_number);
            }
            return Promise.resolve({});
          },
        },
      },
    };

    // Only "npm" is still active — cargo and go should be closed
    const activeIds = new Set(["npm"]);
    const count = await closeSupersededPRs(api, AT, activeIds);

    expect(count).toBe(2);
    expect(closedPrs).toContain(11);
    expect(closedPrs).toContain(12);
    expect(closedPrs).not.toContain(10);
  });

  it("does not close PRs without the dependa marker", async () => {
    const closedPrs: number[] = [];
    const api: PublishApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
          createOrUpdateFileContents: () => Promise.resolve({}),
          listCommits: () => Promise.resolve({ data: [] }),
          compareCommits: () =>
            Promise.resolve({ data: { ahead_by: 0, behind_by: 0, commits: [] } }),
        },
        git: {
          getRef: () => Promise.resolve({ data: { object: { sha: "sha" } } }),
          createRef: () => Promise.resolve({}),
          updateRef: () => Promise.resolve({}),
        },
        pulls: {
          list: () =>
            Promise.resolve({
              data: [
                makePr(20, "feature/my-branch", "This is a human PR"),
                makePr(21, "reeve/dependa/npm", markerBody("npm")),
              ],
            }),
          create: () => Promise.resolve({ data: { number: 99 } }),
          update: (params) => {
            if (params.state === "closed") {
              closedPrs.push(params.pull_number);
            }
            return Promise.resolve({});
          },
        },
      },
    };

    // No groups active — but the human PR should not be touched
    const activeIds = new Set<string>();
    const count = await closeSupersededPRs(api, AT, activeIds);

    expect(count).toBe(1);
    expect(closedPrs).toContain(21);
    expect(closedPrs).not.toContain(20);
  });

  it("returns 0 when all open PRs are still active", async () => {
    const api: PublishApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
          createOrUpdateFileContents: () => Promise.resolve({}),
          listCommits: () => Promise.resolve({ data: [] }),
          compareCommits: () =>
            Promise.resolve({ data: { ahead_by: 0, behind_by: 0, commits: [] } }),
        },
        git: {
          getRef: () => Promise.resolve({ data: { object: { sha: "sha" } } }),
          createRef: () => Promise.resolve({}),
          updateRef: () => Promise.resolve({}),
        },
        pulls: {
          list: () =>
            Promise.resolve({
              data: [makePr(30, "reeve/dependa/npm", markerBody("npm"))],
            }),
          create: () => Promise.resolve({ data: { number: 99 } }),
          update: () => Promise.resolve({}),
        },
      },
    };

    const activeIds = new Set(["npm"]);
    const count = await closeSupersededPRs(api, AT, activeIds);

    expect(count).toBe(0);
  });

  it("handles close API errors gracefully without throwing", async () => {
    const api: PublishApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
          createOrUpdateFileContents: () => Promise.resolve({}),
          listCommits: () => Promise.resolve({ data: [] }),
          compareCommits: () =>
            Promise.resolve({ data: { ahead_by: 0, behind_by: 0, commits: [] } }),
        },
        git: {
          getRef: () => Promise.resolve({ data: { object: { sha: "sha" } } }),
          createRef: () => Promise.resolve({}),
          updateRef: () => Promise.resolve({}),
        },
        pulls: {
          list: () =>
            Promise.resolve({
              data: [makePr(40, "reeve/dependa/stale", markerBody("stale"))],
            }),
          create: () => Promise.resolve({ data: { number: 99 } }),
          update: () => Promise.reject(new Error("API rate limit exceeded")),
        },
      },
    };

    const activeIds = new Set<string>();
    // Should not throw — best-effort close
    const count = await closeSupersededPRs(api, AT, activeIds);
    expect(count).toBe(0);
  });
});
