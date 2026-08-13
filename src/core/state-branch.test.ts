import { describe, expect, it, vi } from "vitest";

import { ensureBranch, publishState, publishStatePr, type StateBranchApi } from "./state-branch.js";

const AT = { owner: "ecoma-io", repo: "reeve" };

/**
 * A 404-shaped rejection — the same shape `isMissing` recognises, built the
 * same way `forge.test.ts` builds its own.
 */
function notFound(): Promise<never> {
  return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
}

// ---------------------------------------------------------------------------
// ensureBranch
// ---------------------------------------------------------------------------

describe("ensureBranch", () => {
  /**
   * A hand-built `StateBranchApi` whose every call is observable through the
   * returned spies — the same pattern `propose.test.ts` follows, minus the
   * ref-aware branch state (ensureBranch does not read or write file content).
   */
  function apiOf(opts: {
    readonly defaultBranch?: string;
    readonly branchExists?: boolean;
    readonly openPrs?: readonly { readonly number: number }[];
  }) {
    const defaultBranch = opts.defaultBranch ?? "main";
    const branchExists = opts.branchExists ?? false;

    const reposGet = vi.fn(() => Promise.resolve({ data: { default_branch: defaultBranch } }));
    const gitGetRef = vi.fn((params: { ref: string }) => {
      const name = params.ref.replace(/^heads\//, "");
      if (name === defaultBranch) {
        return Promise.resolve({ data: { object: { sha: "base-sha" } } });
      }
      if (branchExists && name === "reeve/state") {
        return Promise.resolve({ data: { object: { sha: "branch-sha" } } });
      }
      return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
    });
    const createRef = vi.fn(() => Promise.resolve(undefined));
    const updateRef = vi.fn(() => Promise.resolve(undefined));
    const pullsList = vi.fn(() =>
      Promise.resolve({
        data: (opts.openPrs ?? []).map((p) => ({ number: p.number, body: "" })),
      }),
    );

    const api: StateBranchApi = {
      rest: {
        repos: {
          get: reposGet,
          getContent: vi.fn(notFound),
          createOrUpdateFileContents: vi.fn(() => Promise.resolve(undefined)),
        },
        git: { getRef: gitGetRef, createRef, updateRef },
        pulls: { list: pullsList, create: vi.fn(), update: vi.fn() },
      },
    };

    return { api, reposGet, gitGetRef, createRef, updateRef, pullsList };
  }

  it("creates the branch when it does not exist yet", async () => {
    const { api, createRef, updateRef } = apiOf({ branchExists: false });

    const result = await ensureBranch(api, AT, "reeve/state");

    expect(result).toEqual({ defaultBranch: "main", baseSha: "base-sha" });
    expect(createRef).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      ref: "refs/heads/reeve/state",
      sha: "base-sha",
    });
    expect(updateRef).not.toHaveBeenCalled();
  });

  it("resets the branch to the default branch head when no open PR exists", async () => {
    const { api, updateRef, createRef, pullsList } = apiOf({
      branchExists: true,
      openPrs: [],
    });

    const result = await ensureBranch(api, AT, "reeve/state");

    expect(result).toEqual({ defaultBranch: "main", baseSha: "base-sha" });
    expect(pullsList).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      state: "open",
      head: "ecoma-io:reeve/state",
      per_page: 1,
    });
    expect(updateRef).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      ref: "heads/reeve/state",
      sha: "base-sha",
      force: true,
    });
    expect(createRef).not.toHaveBeenCalled();
  });

  it("does not reset the branch when an open PR exists", async () => {
    const { api, updateRef } = apiOf({
      branchExists: true,
      openPrs: [{ number: 42 }],
    });

    const result = await ensureBranch(api, AT, "reeve/state");

    expect(result).toEqual({ defaultBranch: "main", baseSha: "base-sha" });
    expect(updateRef).not.toHaveBeenCalled();
  });

  it("uses the repository's configured default branch name", async () => {
    const { api, gitGetRef } = apiOf({ defaultBranch: "develop" });

    await ensureBranch(api, AT, "reeve/state");

    expect(gitGetRef).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      ref: "heads/develop",
    });
  });

  it("falls back to 'main' when GitHub does not report a default branch", async () => {
    const reposGet = vi.fn(() => Promise.resolve({ data: {} }));
    const gitGetRef = vi.fn((params: { ref: string }) => {
      if (params.ref === "heads/main") {
        return Promise.resolve({ data: { object: { sha: "main-sha" } } });
      }
      return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
    });

    const api: StateBranchApi = {
      rest: {
        repos: {
          get: reposGet,
          getContent: vi.fn(notFound),
          createOrUpdateFileContents: vi.fn(() => Promise.resolve(undefined)),
        },
        git: { getRef: gitGetRef, createRef: vi.fn(), updateRef: vi.fn() },
        pulls: {
          list: vi.fn(() => Promise.resolve({ data: [] })),
          create: vi.fn(),
          update: vi.fn(),
        },
      },
    };

    const result = await ensureBranch(api, AT, "reeve/state");
    expect(result.defaultBranch).toBe("main");
  });

  it("lets a non-404 error from getRef propagate, rather than treating it as missing", async () => {
    const gitGetRef = vi.fn(() =>
      Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 })),
    );

    const api: StateBranchApi = {
      rest: {
        repos: {
          get: vi.fn(() => Promise.resolve({ data: { default_branch: "main" } })),
          getContent: vi.fn(notFound),
          createOrUpdateFileContents: vi.fn(),
        },
        git: { getRef: gitGetRef, createRef: vi.fn(), updateRef: vi.fn() },
        pulls: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
      },
    };

    // The first getRef call (for the default branch) will also 403 — but that
    // is the one that should propagate, not the branch-existence check.
    await expect(ensureBranch(api, AT, "reeve/state")).rejects.toThrow("Forbidden");
  });
});

// ---------------------------------------------------------------------------
// publishState
// ---------------------------------------------------------------------------

describe("publishState", () => {
  /**
   * A richer fake than `ensureBranch`'s: one that tracks file writes and PR
   * operations, so `publishState`'s full orchestration is observable end to
   * end. Follows the same recorder pattern `propose.test.ts` uses.
   */
  interface Recorder {
    writes: {
      readonly path: string;
      readonly content: string;
      readonly sha?: string;
      readonly branch?: string;
    }[];
    createdPr: {
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
      readonly draft?: boolean;
    } | null;
    updatedPr: { readonly number: number; readonly title?: string; readonly body?: string } | null;
    createdRef: boolean;
    updateRefCalls: { readonly ref: string; readonly sha: string; readonly force: boolean }[];
  }

  const BRANCH = "reeve/state";

  function makeApi(opts: {
    readonly defaultBranch?: string;
    readonly branchExists?: boolean;
    /** Per-file SHA map: path → SHA on the branch. Files not in this map are 404. */
    readonly fileShas?: ReadonlyMap<string, string>;
    readonly openPrs?: readonly { readonly number: number; readonly body?: string }[];
  }): { readonly api: StateBranchApi; readonly recorder: Recorder } {
    const recorder: Recorder = {
      writes: [],
      createdPr: null,
      updatedPr: null,
      createdRef: false,
      updateRefCalls: [],
    };
    const defaultBranch = opts.defaultBranch ?? "main";
    const branchExists = opts.branchExists ?? false;
    const fileShas = opts.fileShas ?? new Map<string, string>();

    const branches = new Set<string>([defaultBranch]);
    if (branchExists) branches.add(BRANCH);

    const api: StateBranchApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: defaultBranch } }),
          getContent: (params: { owner: string; repo: string; path: string; ref: string }) => {
            if (params.ref === BRANCH) {
              const sha = fileShas.get(params.path);
              if (sha !== undefined) {
                return Promise.resolve({ data: { sha, type: "file" } });
              }
              return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
            }
            return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
          },
          createOrUpdateFileContents: (params: {
            owner: string;
            repo: string;
            path: string;
            message: string;
            content: string;
            sha?: string;
            branch?: string;
          }) => {
            recorder.writes.push({
              path: params.path,
              content: Buffer.from(params.content, "base64").toString("utf8"),
              ...(params.sha === undefined ? {} : { sha: params.sha }),
              ...(params.branch === undefined ? {} : { branch: params.branch }),
            });
            return Promise.resolve(undefined);
          },
        },
        git: {
          getRef: (params) => {
            const name = params.ref.replace(/^heads\//, "");
            if (branches.has(name)) {
              return Promise.resolve({ data: { object: { sha: `${name}-sha` } } });
            }
            return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
          },
          createRef: (params) => {
            const name = params.ref.replace(/^refs\/heads\//, "");
            branches.add(name);
            recorder.createdRef = true;
            return Promise.resolve(undefined);
          },
          updateRef: (params) => {
            const name = params.ref.replace(/^heads\//, "");
            recorder.updateRefCalls.push({
              ref: name,
              sha: params.sha,
              force: params.force ?? false,
            });
            return Promise.resolve(undefined);
          },
        },
        pulls: {
          list: () =>
            Promise.resolve({
              data: (opts.openPrs ?? []).map((p) => ({
                number: p.number,
                body: p.body ?? "",
              })),
            }),
          create: (params) => {
            recorder.createdPr = {
              title: params.title,
              body: params.body,
              head: params.head,
              base: params.base,
              ...(params.draft === undefined ? {} : { draft: params.draft }),
            };
            return Promise.resolve({ data: { number: 99 } });
          },
          update: (params) => {
            recorder.updatedPr = {
              number: params.pull_number,
              ...(params.title === undefined ? {} : { title: params.title }),
              ...(params.body === undefined ? {} : { body: params.body }),
            };
            return Promise.resolve(undefined);
          },
        },
      },
    };

    return { api, recorder };
  }

  it("returns null when there are no files to publish", async () => {
    const { api, recorder } = makeApi({ branchExists: false });

    const result = await publishState(api, AT, BRANCH, [], "title", "body", false);

    expect(result).toBeNull();
    expect(recorder.writes).toEqual([]);
  });

  it("returns null on a dry run without writing anything", async () => {
    const { api, recorder } = makeApi({ branchExists: false });
    const files = [{ path: "state.json", content: "{}", message: "update state" }];

    const result = await publishState(api, AT, BRANCH, files, "title", "body", true);

    expect(result).toBeNull();
    expect(recorder.writes).toEqual([]);
    expect(recorder.createdRef).toBe(false);
  });

  it("creates the branch, writes files, and opens a draft PR when the branch is new", async () => {
    const { api, recorder } = makeApi({ branchExists: false });
    const files = [
      { path: ".reeve/state.json", content: '{"id":"docs/guide"}', message: "update provenance" },
    ];

    const result = await publishState(api, AT, BRANCH, files, "harmonise: state", "PR body", false);

    expect(result).toEqual({ pr: 99 });
    expect(recorder.createdRef).toBe(true);
    expect(recorder.writes).toHaveLength(1);
    expect(recorder.writes[0]).toEqual({
      path: ".reeve/state.json",
      content: '{"id":"docs/guide"}',
      branch: BRANCH,
    });
    // New file — no SHA sent
    expect(recorder.writes[0]?.sha).toBeUndefined();
    expect(recorder.createdPr).toEqual({
      title: "harmonise: state",
      body: "PR body",
      head: BRANCH,
      base: "main",
      draft: true,
    });
    expect(recorder.updatedPr).toBeNull();
  });

  it("sends the file's SHA when the file already exists on the branch", async () => {
    const fileShas = new Map([[".reeve/state.json", "existing-sha"]]);
    const { api, recorder } = makeApi({ branchExists: true, fileShas, openPrs: [{ number: 7 }] });
    const files = [
      { path: ".reeve/state.json", content: '{"id":"docs/guide"}', message: "update provenance" },
    ];

    await publishState(api, AT, BRANCH, files, "title", "body", false);

    expect(recorder.writes[0]?.sha).toBe("existing-sha");
  });

  it("writes multiple files to the branch", async () => {
    const { api, recorder } = makeApi({ branchExists: false });
    const files = [
      { path: "a.json", content: "a", message: "write a" },
      { path: "b.json", content: "b", message: "write b" },
    ];

    await publishState(api, AT, BRANCH, files, "title", "body", false);

    expect(recorder.writes).toHaveLength(2);
    expect(recorder.writes.map((w) => w.path)).toEqual(["a.json", "b.json"]);
    expect(recorder.writes.map((w) => w.content)).toEqual(["a", "b"]);
  });

  it("updates an existing PR instead of creating a new one", async () => {
    const { api, recorder } = makeApi({
      branchExists: true,
      openPrs: [{ number: 42, body: "old body" }],
    });
    const files = [{ path: "state.json", content: "{}", message: "update" }];

    const result = await publishState(api, AT, BRANCH, files, "new title", "new body", false);

    expect(result).toEqual({ pr: 42 });
    expect(recorder.updatedPr).toEqual({ number: 42, title: "new title", body: "new body" });
    expect(recorder.createdPr).toBeNull();
  });

  it("resets an existing branch with no open PR before writing", async () => {
    const { api, recorder } = makeApi({ branchExists: true, openPrs: [] });
    const files = [{ path: "state.json", content: "{}", message: "update" }];

    await publishState(api, AT, BRANCH, files, "title", "body", false);

    // ensureBranch should have reset the branch before publishState wrote files
    expect(recorder.updateRefCalls).toHaveLength(1);
    expect(recorder.updateRefCalls[0]).toEqual({
      ref: BRANCH,
      sha: "main-sha",
      force: true,
    });
  });

  it("base64-encodes file content the way the GitHub Contents API expects", async () => {
    const { api, recorder } = makeApi({ branchExists: false });
    const content = '{"locales":["en","vi"]}';
    const files = [{ path: "state.json", content, message: "update" }];

    await publishState(api, AT, BRANCH, files, "title", "body", false);

    // The recorder decodes from base64, so content should match the original
    expect(recorder.writes[0]?.content).toBe(content);
  });

  it("lets a non-404 error from getContent propagate when reading file SHA", async () => {
    const getContent = vi.fn(() =>
      Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 })),
    );
    const api: StateBranchApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent,
          createOrUpdateFileContents: vi.fn(() => Promise.resolve(undefined)),
        },
        git: {
          getRef: () => Promise.resolve({ data: { object: { sha: "sha" } } }),
          createRef: vi.fn(),
          updateRef: vi.fn(),
        },
        pulls: {
          list: vi.fn(() => Promise.resolve({ data: [] })),
          create: vi.fn(),
          update: vi.fn(),
        },
      },
    };
    const files = [{ path: "state.json", content: "{}", message: "update" }];

    await expect(publishState(api, AT, BRANCH, files, "title", "body", false)).rejects.toThrow(
      "Forbidden",
    );
  });
});

// ---------------------------------------------------------------------------
// publishStatePr
// ---------------------------------------------------------------------------

describe("publishStatePr", () => {
  const BRANCH = "reeve/state";

  /**
   * A minimal fake for the PR-only path — `publishStatePr` does not write
   * files or create branches, so only repos.get, pulls.list/create/update
   * are exercised.
   */
  function makeApi(opts: {
    readonly defaultBranch?: string;
    readonly openPrs?: readonly { readonly number: number; readonly body?: string }[];
  }) {
    const defaultBranch = opts.defaultBranch ?? "main";
    const prs = opts.openPrs ?? [];

    const createdPrs: {
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
      readonly draft?: boolean;
    }[] = [];
    const updatedPrs: {
      readonly number: number;
      readonly title?: string;
      readonly body?: string;
    }[] = [];

    const api: StateBranchApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: defaultBranch } }),
          getContent: vi.fn(notFound),
          createOrUpdateFileContents: vi.fn(() => Promise.resolve(undefined)),
        },
        git: {
          getRef: vi.fn(notFound),
          createRef: vi.fn(),
          updateRef: vi.fn(),
        },
        pulls: {
          list: () =>
            Promise.resolve({
              data: prs.map((p) => ({ number: p.number, body: p.body ?? "" })),
            }),
          create: (params) => {
            createdPrs.push({
              title: params.title,
              body: params.body,
              head: params.head,
              base: params.base,
              ...(params.draft === undefined ? {} : { draft: params.draft }),
            });
            return Promise.resolve({ data: { number: 99 } });
          },
          update: (params) => {
            updatedPrs.push({
              number: params.pull_number,
              ...(params.title === undefined ? {} : { title: params.title }),
              ...(params.body === undefined ? {} : { body: params.body }),
            });
            return Promise.resolve(undefined);
          },
        },
      },
    };

    return { api, createdPrs, updatedPrs };
  }

  it("returns null on a dry run without creating a PR", async () => {
    const { api, createdPrs } = makeApi({});

    const result = await publishStatePr(api, AT, BRANCH, "title", "body", true);

    expect(result).toBeNull();
    expect(createdPrs).toHaveLength(0);
  });

  it("creates a draft PR when no open PR exists", async () => {
    const { api, createdPrs, updatedPrs } = makeApi({ openPrs: [] });

    const result = await publishStatePr(api, AT, BRANCH, "triage: corrections", "PR body", false);

    expect(result).toEqual({ pr: 99 });
    expect(createdPrs).toHaveLength(1);
    expect(createdPrs[0]).toEqual({
      title: "triage: corrections",
      body: "PR body",
      head: BRANCH,
      base: "main",
      draft: true,
    });
    expect(updatedPrs).toHaveLength(0);
  });

  it("updates an existing PR instead of creating a new one", async () => {
    const { api, createdPrs, updatedPrs } = makeApi({
      openPrs: [{ number: 42, body: "old body" }],
    });

    const result = await publishStatePr(api, AT, BRANCH, "new title", "new body", false);

    expect(result).toEqual({ pr: 42 });
    expect(updatedPrs).toHaveLength(1);
    expect(updatedPrs[0]).toEqual({ number: 42, title: "new title", body: "new body" });
    expect(createdPrs).toHaveLength(0);
  });

  it("uses the repository's configured default branch as the PR base", async () => {
    const { api, createdPrs } = makeApi({ defaultBranch: "develop" });

    await publishStatePr(api, AT, BRANCH, "title", "body", false);

    expect(createdPrs[0]?.base).toBe("develop");
  });
});
