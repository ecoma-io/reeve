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

  it("pages through ALL compareCommits pages before judging — a human commit beyond page 1 still refuses", async () => {
    // >100 branch-unique commits: the first page (100) is all bot-authored,
    // and the human commit sits on page 2. Stopping at the first page would
    // false-positive the D3 comparison as bot-only and force-reset over a
    // maintainer's commit — the invariant-3 paging gap this regression pins.
    const pages: {
      commits: { sha: string; author: { login: string } | null }[];
      ahead_by: number;
      behind_by: number;
    }[] = [
      {
        ahead_by: 105,
        behind_by: 0,
        commits: Array.from({ length: 100 }, (_, i) => ({
          sha: `bot-${String(i)}`,
          author: { login: "github-actions[bot]" },
        })),
      },
      {
        ahead_by: 105,
        behind_by: 0,
        commits: Array.from({ length: 5 }, (_, i) => ({
          sha: `tail-${String(i)}`,
          author: i === 4 ? { login: "maintainer" } : { login: "github-actions[bot]" },
        })),
      },
    ];
    const remainingPages = [...pages];
    let updateRefCalled = false;
    const base = baseApi();
    base.rest.repos.compareCommits = (params: { page?: number }) => {
      const page = params.page ?? 1;
      const next = remainingPages[page - 1];
      if (next === undefined) throw new Error("should not request beyond the pages provided");
      return Promise.resolve({ data: next });
    };
    base.rest.git.updateRef = () => {
      updateRefCalled = true;
      return Promise.resolve({});
    };

    const result = await publishGroup(base, AT, group(), false, true);

    expect(remainingPages).toHaveLength(2); // both pages were consumed
    expect(updateRefCalled).toBe(false); // force-reset refused
    expect(result.outcome).toBe("refused");
    expect(result.pr).toBeNull();
  });

  it("pages through ALL compareCommits pages and proceeds when every commit is bot-authored", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      sha: `bot-a-${String(i)}`,
      author: { login: "github-actions[bot]" },
    }));
    const page2 = Array.from({ length: 7 }, (_, i) => ({
      sha: `bot-b-${String(i)}`,
      author: { login: "reeve[bot]" },
    }));
    let updateRefCalled = false;
    const base = baseApi();
    base.rest.repos.compareCommits = (params: { page?: number }) => {
      const page = params.page ?? 1;
      if (page === 1)
        return Promise.resolve({ data: { ahead_by: 107, behind_by: 0, commits: page1 } });
      return Promise.resolve({ data: { ahead_by: 107, behind_by: 0, commits: page2 } });
    };
    base.rest.git.updateRef = () => {
      updateRefCalled = true;
      return Promise.resolve({});
    };

    const result = await publishGroup(base, AT, group(), false, true);

    expect(updateRefCalled).toBe(true); // force-reset proceeded
    expect(result.outcome).not.toBe("refused");
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

  it("keeps a scoped package's own pull request, whose branch holds the sanitised id", async () => {
    // The regression this guards. `publishGroup` builds the branch from
    // `sanitizeBranchSegment(group.id)`, so `@types/node` opens
    // `reeve/dependa/branch-types-node` — while the active set holds the group
    // id unsanitised. Comparing the two directly, no scoped group ever matches
    // its own branch, so the run closed the pull request it had just opened as
    // superseded. D3 then refuses to recreate a closed-unmerged proposal, and
    // the dependency is un-updatable for ever after — silently, because both
    // log lines are individually correct.
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
                makePr(50, "reeve/dependa/branch-types-node", markerBody("@types/node")),
                makePr(51, "reeve/dependa/branch-stale-scope", markerBody("@stale/scope")),
              ],
            }),
          create: () => Promise.resolve({ data: { number: 99 } }),
          update: (params) => {
            if (params.state === "closed") closedPrs.push(params.pull_number);
            return Promise.resolve({});
          },
        },
      },
    };

    // The active set carries the id as the run computed it — unsanitised.
    const count = await closeSupersededPRs(api, AT, new Set(["@types/node"]));

    // The scoped group that is still active survives; the one that is not is
    // still closed, so the fix did not simply stop closing anything.
    expect(closedPrs).toEqual([51]);
    expect(count).toBe(1);
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

// ── publishGroup: PR idempotency and the 409-conflict retry ──────────────
//
// Two write paths that decide whether a second run over the same repository
// leaves a second pull request behind, and whether a commit races another
// writer into silence. Neither was driven before this.

describe("publishGroup: not opening a second pull request", () => {
  const AT = { owner: "acme", repo: "widgets" };

  /** Everything the stub was asked to do, so a case can assert on it. */
  interface Recorded {
    readonly createdPrs: { head: string; title: string }[];
    readonly updatedPrs: number[];
    readonly writes: { path: string; sha: string | undefined }[];
    reads: number;
  }

  function apiOf(
    options: {
      /** An open PR already on the branch: its number and body. */
      readonly openPr?: { number: number; body: string };
      /** Statuses `createOrUpdateFileContents` throws, in order, before succeeding. */
      readonly writeFailures?: readonly number[];
      /** The sha `getContent` reports, or undefined for "no such file". */
      readonly fileSha?: string;
    } = {},
  ): { api: PublishApi; recorded: Recorded } {
    const recorded: Recorded = {
      createdPrs: [],
      updatedPrs: [],
      writes: [],
      reads: 0,
    };
    const failures = [...(options.writeFailures ?? [])];

    const api: PublishApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent: () => {
            recorded.reads += 1;
            if (options.fileSha === undefined) {
              return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
            }
            return Promise.resolve({ data: { sha: options.fileSha } });
          },
          createOrUpdateFileContents: (params) => {
            const status = failures.shift();
            if (status !== undefined) {
              return Promise.reject(Object.assign(new Error("Conflict"), { status }));
            }
            recorded.writes.push({ path: params.path, sha: params.sha ?? undefined });
            return Promise.resolve({});
          },
          listCommits: () =>
            Promise.resolve({
              data: [{ sha: "abc", author: { login: "reeve[bot]" }, committer: null }],
            }),
          compareCommits: () =>
            Promise.resolve({
              data: {
                ahead_by: 1,
                behind_by: 0,
                commits: [{ sha: "abc", author: { login: "reeve[bot]" }, committer: null }],
              },
            }),
        },
        git: {
          getRef: () => Promise.resolve({ data: { object: { sha: "branch-sha" } } }),
          createRef: () => Promise.resolve({}),
          updateRef: () => Promise.resolve({}),
        },
        pulls: {
          list: (params) =>
            Promise.resolve({
              data:
                params.state === "open" && options.openPr !== undefined
                  ? [
                      {
                        number: options.openPr.number,
                        body: options.openPr.body,
                        head: { sha: "head-sha", ref: "reeve/dependa/npm" },
                        merged: false,
                      },
                    ]
                  : [],
            }),
          create: (params) => {
            recorded.createdPrs.push({ head: params.head, title: params.title });
            return Promise.resolve({ data: { number: 101 } });
          },
          update: (params) => {
            recorded.updatedPrs.push(params.pull_number);
            return Promise.resolve({});
          },
        },
      },
    };
    return { api, recorded };
  }

  /** The body a previous run of `publishGroup` would have left on the PR. */
  async function bodyFromAPreviousRun(target: ProposalGroup): Promise<string> {
    const { api, recorded } = apiOf();
    await publishGroup(api, AT, target, false, true);
    void recorded;
    return buildPrBody(target);
  }

  it("opens one pull request when the branch carries none", async () => {
    const { api, recorded } = apiOf();

    const result = await publishGroup(api, AT, group(), false, true);

    expect(recorded.createdPrs).toHaveLength(1);
    expect(recorded.updatedPrs).toEqual([]);
    expect(result.outcome).toBe("opened");
    expect(result.pr).toBe(101);
  });

  it("leaves an unchanged pull request completely alone on a second run", async () => {
    // Idempotency, by the fingerprint the previous run stamped into the body.
    // A run that rewrote an identical body would send a notification to every
    // watcher of the repository, once per scheduled run, forever.
    const target = group();
    const { api, recorded } = apiOf({
      openPr: { number: 7, body: await bodyFromAPreviousRun(target) },
    });

    const result = await publishGroup(api, AT, target, false, true);

    expect(result).toEqual({ pr: 7, outcome: "unchanged" });
    expect(recorded.updatedPrs).toEqual([]);
    expect(recorded.createdPrs).toEqual([]);
  });

  it("updates the open pull request when the proposals behind it changed", async () => {
    // Same group id, different target version: the fingerprint moves, so the
    // PR is brought up to date rather than left describing an old proposal.
    const previous = group({ proposals: [proposal({ targetVersion: "4.17.22" })] });
    const now = group({ proposals: [proposal({ targetVersion: "5.0.0" })] });
    const { api, recorded } = apiOf({
      openPr: { number: 7, body: await bodyFromAPreviousRun(previous) },
    });

    const result = await publishGroup(api, AT, now, false, true);

    expect(result).toEqual({ pr: 7, outcome: "updated" });
    expect(recorded.updatedPrs).toEqual([7]);
    expect(recorded.createdPrs).toEqual([]);
  });

  it("updates rather than duplicating when the open PR carries no fingerprint at all", async () => {
    // A body somebody edited by hand has no marker left. That is a reason to
    // rewrite it, never a reason to open a second pull request beside it.
    const { api, recorded } = apiOf({
      openPr: { number: 7, body: "somebody replaced this description" },
    });

    const result = await publishGroup(api, AT, group(), false, true);

    expect(result.outcome).toBe("updated");
    expect(recorded.createdPrs).toEqual([]);
  });
});

describe("publishGroup: a commit that lost a race", () => {
  const AT = { owner: "acme", repo: "widgets" };

  /** A group whose proposal actually edits a manifest, so a commit is made. */
  function editing(): ProposalGroup {
    return group({
      proposals: [
        proposal({
          edits: [
            {
              path: "package.json",
              content: '{"dependencies":{"lodash":"^4.17.22"}}',
              message: "dependa: bump lodash to 4.17.22",
            },
          ],
        }),
      ],
    });
  }

  interface Recorded {
    readonly writes: { path: string; sha: string | undefined }[];
    reads: number;
  }

  function apiOf(options: {
    readonly writeFailures?: readonly number[];
    /** Shas `getContent` reports, in call order. `null` means "no such file". */
    readonly shas?: readonly (string | null)[];
  }): { api: PublishApi; recorded: Recorded } {
    const recorded: Recorded = { writes: [], reads: 0 };
    const failures = [...(options.writeFailures ?? [])];
    const shas = [...(options.shas ?? [])];

    const api: PublishApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent: () => {
            recorded.reads += 1;
            const sha = shas.shift() ?? null;
            if (sha === null) {
              return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
            }
            return Promise.resolve({ data: { sha } });
          },
          createOrUpdateFileContents: (params) => {
            const status = failures.shift();
            if (status !== undefined) {
              return Promise.reject(Object.assign(new Error("Conflict"), { status }));
            }
            recorded.writes.push({ path: params.path, sha: params.sha ?? undefined });
            return Promise.resolve({});
          },
          listCommits: () =>
            Promise.resolve({
              data: [{ sha: "abc", author: { login: "reeve[bot]" }, committer: null }],
            }),
          compareCommits: () =>
            Promise.resolve({
              data: {
                ahead_by: 1,
                behind_by: 0,
                commits: [{ sha: "abc", author: { login: "reeve[bot]" }, committer: null }],
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
          create: () => Promise.resolve({ data: { number: 101 } }),
          update: () => Promise.resolve({}),
        },
      },
    };
    return { api, recorded };
  }

  it("re-reads the file's sha and retries once after a 409", async () => {
    // A 409 means another writer moved the file between the read and the
    // write. Giving up would silently drop the manifest edit; retrying with a
    // stale sha would 409 again forever. Re-read, then write once.
    const { api, recorded } = apiOf({ writeFailures: [409], shas: ["stale-sha", "fresh-sha"] });

    const result = await publishGroup(api, AT, editing(), false, true);

    expect(recorded.writes).toHaveLength(1);
    expect(recorded.writes[0]?.sha).toBe("fresh-sha");
    expect(result.outcome).toBe("opened");
  });

  it("creates the file without a sha when the re-read finds it gone", async () => {
    // The file was deleted between the failed write and the retry. A `sha`
    // naming a blob that no longer exists would 422; omitting it creates.
    const { api, recorded } = apiOf({ writeFailures: [409], shas: ["stale-sha", null] });

    await publishGroup(api, AT, editing(), false, true);

    expect(recorded.writes).toHaveLength(1);
    expect(recorded.writes[0]?.sha).toBeUndefined();
  });

  it("propagates a write failure that is not a conflict rather than retrying it", async () => {
    // Retrying a 403 or a 422 would spend a second request confirming the
    // same refusal, and swallowing it would report a commit that never landed.
    const { api } = apiOf({ writeFailures: [422], shas: ["stale-sha"] });

    await expect(publishGroup(api, AT, editing(), false, true)).rejects.toThrow();
  });

  it("does not retry a second time when the retry itself conflicts", async () => {
    // Once. A loop here would hammer a contended branch for the run's whole
    // budget, and the caller has to be told the write did not land.
    const { api } = apiOf({ writeFailures: [409, 409], shas: ["stale-sha", "fresh-sha"] });

    await expect(publishGroup(api, AT, editing(), false, true)).rejects.toThrow();
  });
});
