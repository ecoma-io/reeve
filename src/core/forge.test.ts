import { describe, expect, it, vi } from "vitest";

import {
  createEffects,
  createReply,
  createThread,
  isMissing,
  listCorrectionFiles,
  listOpenThreads,
  listReplies,
  listRepositoryLabels,
  readContentsFile,
  readStanding,
  writeContentsFile,
  UnreadableContentsFile,
  type ContentsApi,
  type GitHubApi,
  type TrackerApi,
} from "./forge.js";

// The client arrives injected, so there is nothing to mock: a hand-built
// Octokit is the whole environment of every port here.

const OFFICIAL = "Ứng dụng bị lỗi khi tôi bấm nút.";
const AT = { owner: "ecoma-io", repo: "reeve", number: 42 };

/**
 * An Octokit client built by hand, recording every call.
 *
 * Shared by all three suites rather than one per suite, because the point of
 * the ports is that they are three views of the same client — a `createReply`
 * that reached for `issues.update` has to be visible as a call on this object
 * and not invisible behind a second stub that has its own.
 */
function apiOf(
  body: string | null | undefined,
  comments: {
    id: number;
    body?: string | null;
    user?: { login?: string; type?: string } | null;
  }[] = [],
) {
  const get = vi.fn(() => Promise.resolve({ data: { body } }));
  const update = vi.fn(() => Promise.resolve({}));
  const listComments = vi.fn(() => Promise.resolve({ data: comments }));
  const updateComment = vi.fn((_params: { body: string }) => Promise.resolve({}));
  return {
    api: { rest: { issues: { get, update, listComments, updateComment } } } as GitHubApi,
    get,
    update,
    listComments,
    updateComment,
  };
}

describe("createThread", () => {
  it("reads the body of the thread it was pointed at", async () => {
    const { api, get } = apiOf(OFFICIAL);
    await expect(createThread(api, AT).read()).resolves.toBe(OFFICIAL);
    expect(get).toHaveBeenCalledWith({ owner: "ecoma-io", repo: "reeve", issue_number: 42 });
  });

  it("reads a thread GitHub sent with no body as an empty one", async () => {
    // GitHub sends `null` for a thread opened with the body left blank.
    await expect(createThread(apiOf(null).api, AT).read()).resolves.toBe("");
    await expect(createThread(apiOf(undefined).api, AT).read()).resolves.toBe("");
  });

  it("writes the body back to the thread by its number", async () => {
    const { api, update } = apiOf(OFFICIAL);
    await createThread(api, AT).write("next");
    expect(update).toHaveBeenCalledWith({
      owner: "ecoma-io",
      repo: "reeve",
      issue_number: 42,
      body: "next",
    });
  });
});

describe("listReplies", () => {
  it("reads the replies of the thread it was pointed at", async () => {
    const { api, listComments } = apiOf(OFFICIAL, [
      { id: 991, body: "Tôi cũng gặp lỗi này.", user: { login: "reporter", type: "User" } },
      { id: 992, body: "Same here.", user: { login: "bot-account", type: "Bot" } },
    ]);

    await expect(listReplies(api, AT)).resolves.toEqual({
      replies: [
        { id: 991, body: "Tôi cũng gặp lỗi này.", login: "reporter", isBot: false },
        { id: 992, body: "Same here.", login: "bot-account", isBot: true },
      ],
      more: false,
    });
    expect(listComments).toHaveBeenCalledWith({
      owner: "ecoma-io",
      repo: "reeve",
      issue_number: 42,
      per_page: 100,
    });
  });

  it("reads a reply GitHub sent with no body as an empty one", async () => {
    const { api } = apiOf(OFFICIAL, [{ id: 991, body: null }]);
    const { replies } = await listReplies(api, AT);
    expect(replies).toEqual([{ id: 991, body: "", login: "", isBot: false }]);
  });

  it("says so when the thread has more replies than one run reads", async () => {
    // A full page means there is probably another, and a run that trimmed
    // quietly would read as having worked a thread it only got through part of.
    // The caller turns this into a warning naming what was left.
    const full = Array.from({ length: 100 }, (_, index) => ({ id: index, body: "Xin chào." }));
    await expect(listReplies(apiOf(OFFICIAL, full).api, AT)).resolves.toMatchObject({ more: true });
  });

  it("claims no more replies when the page came back short", async () => {
    const { api } = apiOf(OFFICIAL, [{ id: 991, body: "Xin chào." }]);
    await expect(listReplies(api, AT)).resolves.toMatchObject({ more: false });
  });

  it("reads a thread nobody has replied to as no replies rather than as a failure", async () => {
    await expect(listReplies(apiOf(OFFICIAL, []).api, AT)).resolves.toEqual({
      replies: [],
      more: false,
    });
  });

  it("reads a `[bot]` login as a bot even when GitHub left `type` untyped", async () => {
    // `github-actions[bot]` acting through a workflow's default token is the
    // account this exists for — GitHub does not always type it, and trusting
    // `type` alone would read it as human.
    const { api } = apiOf(OFFICIAL, [
      { id: 991, body: "Ran the checks.", user: { login: "github-actions[bot]" } },
    ]);
    const { replies } = await listReplies(api, AT);
    expect(replies).toEqual([
      { id: 991, body: "Ran the checks.", login: "github-actions[bot]", isBot: true },
    ]);
  });
});

describe("createReply", () => {
  const reply = { id: 991, body: OFFICIAL, login: "reporter", isBot: false };

  it("answers with the body the listing already read, asking GitHub nothing", async () => {
    // One request for the page rather than one per comment: a forty-reply
    // thread would otherwise spend forty reads before doing any work.
    const { api, get, listComments } = apiOf("something else");
    await expect(createReply(api, AT, reply).read()).resolves.toBe(OFFICIAL);
    expect(get).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
  });

  it("writes the body back to the comment by its id, not to the thread", async () => {
    const { api, update, updateComment } = apiOf(OFFICIAL);
    await createReply(api, AT, reply).write("next");
    expect(updateComment).toHaveBeenCalledWith({
      owner: "ecoma-io",
      repo: "reeve",
      comment_id: 991,
      body: "next",
    });
    // The failure this pins is the one that would be invisible in review and
    // catastrophic in a thread: a reply's block overwriting the thread body.
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * The wider client, built the same way.
 *
 * Separate from `apiOf` because the two ports are separate on purpose: a test
 * that handed the narrow functions this object would stop being able to fail
 * when somebody widened `GitHubApi` back out again.
 */
function trackerOf(
  issue: {
    title?: string;
    body?: string | null;
    state?: string;
    labels?: (string | { name?: string })[];
    user?: { login?: string; type?: string } | null;
  } = {},
  pages: { name: string; description?: string | null }[][] = [[]],
) {
  const get = vi.fn(() => Promise.resolve({ data: issue }));
  const update = vi.fn(() => Promise.resolve({}));
  const addLabels = vi.fn(() => Promise.resolve({}));
  const createComment = vi.fn(() => Promise.resolve({}));
  const addAssignees = vi.fn(() => Promise.resolve({}));
  const listLabelsForRepo = vi.fn((params: { page?: number }) =>
    Promise.resolve({ data: pages[(params.page ?? 1) - 1] ?? [] }),
  );

  return {
    api: {
      rest: {
        issues: {
          get,
          update,
          addLabels,
          createComment,
          addAssignees,
          listLabelsForRepo,
        },
      },
    } as unknown as TrackerApi,
    get,
    update,
    addLabels,
    createComment,
    addAssignees,
    listLabelsForRepo,
  };
}

describe("readStanding", () => {
  it("reads the title, the body, the labels and whether it is closed", async () => {
    const { api, get } = trackerOf({
      title: "Xuất file rỗng",
      body: OFFICIAL,
      state: "open",
      labels: [{ name: "bug" }, { name: "needs reproduction" }],
    });

    await expect(readStanding(api, AT)).resolves.toEqual({
      title: "Xuất file rỗng",
      body: OFFICIAL,
      labels: ["bug", "needs reproduction"],
      closed: false,
      author: { login: "", isBot: false },
    });
    expect(get).toHaveBeenCalledWith({ owner: "ecoma-io", repo: "reeve", issue_number: 42 });
  });

  it("reads who opened the thread, the same way it reads a reply's author", async () => {
    const { api } = trackerOf({ user: { login: "reeve-bot", type: "Bot" } });

    await expect(readStanding(api, AT)).resolves.toMatchObject({
      author: { login: "reeve-bot", isBot: true },
    });
  });

  it("reads a `[bot]` login as a bot even when GitHub left `type` untyped", async () => {
    const { api } = trackerOf({ user: { login: "dependabot[bot]" } });

    await expect(readStanding(api, AT)).resolves.toMatchObject({
      author: { login: "dependabot[bot]", isBot: true },
    });
  });

  it("reads a label GitHub sent as a bare string", async () => {
    // Both shapes are documented. Assuming one and getting the other would make
    // every guardrail believe the thread is unlabelled, which is the direction
    // in which the mistake overrules a maintainer.
    const { api } = trackerOf({ labels: ["bug", "documentation"] });

    await expect(readStanding(api, AT)).resolves.toMatchObject({
      labels: ["bug", "documentation"],
    });
  });

  it("drops a label with no name rather than carrying an empty one", async () => {
    const { api } = trackerOf({ labels: [{ name: "bug" }, {}, ""] });

    await expect(readStanding(api, AT)).resolves.toMatchObject({ labels: ["bug"] });
  });

  it("reads a thread with nothing on it as empty text and no labels", async () => {
    await expect(readStanding(trackerOf({}).api, AT)).resolves.toEqual({
      title: "",
      body: "",
      labels: [],
      closed: false,
      author: { login: "", isBot: false },
    });
  });

  it("reads a closed thread as closed", async () => {
    const { api } = trackerOf({ state: "closed" });

    await expect(readStanding(api, AT)).resolves.toMatchObject({ closed: true });
  });
});

describe("listRepositoryLabels", () => {
  const where = { owner: "ecoma-io", repo: "reeve" };

  it("reads the taxonomy the warrant will be checked against", async () => {
    const { api, listLabelsForRepo } = trackerOf({}, [
      [{ name: "bug", description: "Something broke." }, { name: "performance" }],
    ]);

    await expect(listRepositoryLabels(api, where)).resolves.toEqual([
      { name: "bug", description: "Something broke." },
      { name: "performance", description: null },
    ]);
    expect(listLabelsForRepo).toHaveBeenCalledWith({ ...where, per_page: 100, page: 1 });
  });

  it("reads a label GitHub gave no description as one with none", async () => {
    // `null` and an absent field are both what GitHub can send, and both mean
    // the same thing to whatever builds a taxonomy from these.
    const { api } = trackerOf({}, [[{ name: "bug", description: null }]]);

    await expect(listRepositoryLabels(api, where)).resolves.toEqual([
      { name: "bug", description: null },
    ]);
  });

  it("reads past the first page, so label 101 is not reported as missing", async () => {
    // The failure this exists for: a repository with more labels than one page
    // validating against the first hundred and failing the run over a label
    // that is right there.
    const first = Array.from({ length: 100 }, (_, index) => ({ name: `label-${String(index)}` }));
    const { api, listLabelsForRepo } = trackerOf({}, [first, [{ name: "performance" }]]);

    await expect(listRepositoryLabels(api, where)).resolves.toHaveLength(101);
    expect(listLabelsForRepo).toHaveBeenCalledTimes(2);
  });

  it("stops on a short page rather than asking for one more that is empty", async () => {
    const { api, listLabelsForRepo } = trackerOf({}, [[{ name: "bug" }]]);

    await listRepositoryLabels(api, where);
    expect(listLabelsForRepo).toHaveBeenCalledTimes(1);
  });

  it("stops at the ceiling rather than paging a repository forever", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ name: `label-${String(index)}` }));
    const { api, listLabelsForRepo } = trackerOf(
      {},
      Array.from({ length: 20 }, () => full),
    );

    await expect(listRepositoryLabels(api, where)).resolves.toHaveLength(1000);
    expect(listLabelsForRepo).toHaveBeenCalledTimes(10);
  });

  it("reads a repository with no labels as no labels", async () => {
    await expect(listRepositoryLabels(trackerOf({}, [[]]).api, where)).resolves.toEqual([]);
  });
});

/**
 * An entry the way the listing endpoint sends one — issue and pull request
 * both, since that endpoint returns both and `isPullRequest` is how a caller
 * tells them apart.
 */
function entry(
  number: number,
  createdAt: string,
  over: {
    title?: string | null;
    body?: string | null;
    labels?: (string | { name?: string })[];
    pull_request?: unknown;
  } = {},
) {
  return { number, created_at: createdAt, title: "A thread", body: "Some text", ...over };
}

/** A tracker whose `issues.listForRepo` answers one page per call, in order. */
function sweepOf(pages: ReturnType<typeof entry>[][]) {
  const listForRepo = vi.fn((params: { page?: number }) =>
    Promise.resolve({ data: pages[(params.page ?? 1) - 1] ?? [] }),
  );
  return { api: { rest: { issues: { listForRepo } } } as unknown as TrackerApi, listForRepo };
}

describe("listOpenThreads", () => {
  const where = { owner: "ecoma-io", repo: "reeve" };

  it("asks for open threads newest-created-first, not the tracker's own default", async () => {
    // The tracker's own ordering — and its own `since` — is by `updated_at`,
    // which this duty's own writes move forward. Sorting by creation instead is
    // what makes `since` a true prefix of the listing, checked below.
    const { api, listForRepo } = sweepOf([[entry(3, "2026-03-01T00:00:00Z")]]);

    await listOpenThreads(api, where, null);

    expect(listForRepo).toHaveBeenCalledWith({
      ...where,
      state: "open",
      sort: "created",
      direction: "desc",
      per_page: 100,
      page: 1,
    });
  });

  it("reads a thread's number, text and labels off the listing", async () => {
    const { api } = sweepOf([
      [entry(3, "2026-03-01T00:00:00Z", { title: "Bug", body: "It broke.", labels: ["bug"] })],
    ]);

    await expect(listOpenThreads(api, where, null)).resolves.toEqual([
      {
        number: 3,
        title: "Bug",
        body: "It broke.",
        labels: ["bug"],
        createdAt: new Date("2026-03-01T00:00:00Z"),
        isPullRequest: false,
      },
    ]);
  });

  it("reads labels given as bare names and as objects alike", async () => {
    const { api } = sweepOf([
      [entry(1, "2026-03-01T00:00:00Z", { labels: ["bug", { name: "docs" }, { name: "" }] })],
    ]);

    await expect(listOpenThreads(api, where, null)).resolves.toMatchObject([
      { labels: ["bug", "docs"] },
    ]);
  });

  it("reads a title or body GitHub sent as null as an empty string", async () => {
    const { api } = sweepOf([[entry(1, "2026-03-01T00:00:00Z", { title: null, body: null })]]);

    await expect(listOpenThreads(api, where, null)).resolves.toMatchObject([
      { title: "", body: "" },
    ]);
  });

  it("tells a pull request from an issue by the field only a pull request carries", async () => {
    const { api } = sweepOf([
      [
        entry(1, "2026-03-01T00:00:00Z"),
        entry(2, "2026-03-01T00:00:00Z", { pull_request: { url: "..." } }),
      ],
    ]);

    await expect(listOpenThreads(api, where, null)).resolves.toMatchObject([
      { number: 1, isPullRequest: false },
      { number: 2, isPullRequest: true },
    ]);
  });

  it("reads past the first page when a page came back full", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      entry(200 - index, "2026-03-01T00:00:00Z"),
    );
    const second = [entry(50, "2026-02-01T00:00:00Z")];
    const { api, listForRepo } = sweepOf([first, second]);

    await expect(listOpenThreads(api, where, null)).resolves.toHaveLength(101);
    expect(listForRepo).toHaveBeenCalledTimes(2);
  });

  it("stops on a short page rather than asking for one more that is empty", async () => {
    const { api, listForRepo } = sweepOf([[entry(1, "2026-03-01T00:00:00Z")]]);

    await listOpenThreads(api, where, null);
    expect(listForRepo).toHaveBeenCalledTimes(1);
  });

  it("stops at the ceiling rather than walking a repository's whole history", async () => {
    const full = Array.from({ length: 100 }, (_, index) => entry(index, "2026-03-01T00:00:00Z"));
    const { api, listForRepo } = sweepOf(Array.from({ length: 20 }, () => full));

    await expect(listOpenThreads(api, where, null)).resolves.toHaveLength(1000);
    expect(listForRepo).toHaveBeenCalledTimes(10);
  });

  it("keeps a thread created on the bound and excludes one created before it", async () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const { api } = sweepOf([
      [
        entry(1, "2026-01-01T00:00:00Z"),
        entry(2, "2025-12-31T23:59:59Z"),
        entry(3, "2025-01-01T00:00:00Z"),
      ],
    ]);

    await expect(listOpenThreads(api, where, since)).resolves.toEqual([
      expect.objectContaining({ number: 1 }),
    ]);
  });

  it("stops paging the moment a page's oldest entry falls before `since`", async () => {
    // Newest-first plus a bound on creation makes `since` a true prefix: once
    // one entry is too old, everything the tracker would answer next is too,
    // and reading further pages would only confirm that at the cost of a
    // request nobody needed.
    const since = new Date("2026-02-01T00:00:00Z");
    const first = [entry(2, "2026-03-01T00:00:00Z"), entry(1, "2026-01-01T00:00:00Z")];
    const second = [entry(0, "2025-01-01T00:00:00Z")];
    const { api, listForRepo } = sweepOf([first, second]);

    await expect(listOpenThreads(api, where, since)).resolves.toEqual([
      expect.objectContaining({ number: 2 }),
    ]);
    expect(listForRepo).toHaveBeenCalledTimes(1);
  });

  it("reads a repository with no open threads as none", async () => {
    await expect(listOpenThreads(sweepOf([[]]).api, where, null)).resolves.toEqual([]);
  });
});

describe("createEffects", () => {
  const issue = { owner: "ecoma-io", repo: "reeve", issue_number: 42 };

  it("adds labels, and adds rather than replaces", async () => {
    // `addLabels` and not `setLabels`, which is the whole argument: what a
    // maintainer put on a thread stays there.
    const { api, addLabels } = trackerOf();

    await createEffects(api, AT).addLabels(["bug", "performance"]);
    expect(addLabels).toHaveBeenCalledWith({ ...issue, labels: ["bug", "performance"] });
  });

  it("asks GitHub nothing when there are no labels to add", async () => {
    const { api, addLabels } = trackerOf();

    await createEffects(api, AT).addLabels([]);
    expect(addLabels).not.toHaveBeenCalled();
  });

  it("posts a new comment and never edits an existing one", async () => {
    const { api, createComment } = trackerOf();

    await createEffects(api, AT).comment("Xin chào.");
    expect(createComment).toHaveBeenCalledWith({ ...issue, body: "Xin chào." });
  });

  it("adds assignees, keeping whoever is already assigned", async () => {
    const { api, addAssignees } = trackerOf();

    await createEffects(api, AT).assign(["maintainer"]);
    expect(addAssignees).toHaveBeenCalledWith({ ...issue, assignees: ["maintainer"] });
  });

  it("asks GitHub nothing when there is nobody to assign", async () => {
    const { api, addAssignees } = trackerOf();

    await createEffects(api, AT).assign([]);
    expect(addAssignees).not.toHaveBeenCalled();
  });

  it("closes as not planned, because nothing Reeve closes was completed", async () => {
    // A tracker that records the difference is one a maintainer can audit
    // afterwards; `completed` would put Reeve's guess in the same field a
    // shipped fix goes in.
    const { api, update } = trackerOf();

    await createEffects(api, AT).closeAsNotPlanned();
    expect(update).toHaveBeenCalledWith({ ...issue, state: "closed", state_reason: "not_planned" });
  });
});

/** A hand-built Contents API, the same style as `apiOf` above but over `repos` rather than `issues`. */
function contentsOf(getContent: ReturnType<typeof vi.fn>) {
  const createOrUpdateFileContents = vi.fn((_params: Record<string, unknown>) =>
    Promise.resolve({}),
  );
  return {
    api: { rest: { repos: { getContent, createOrUpdateFileContents } } } as ContentsApi,
    createOrUpdateFileContents,
  };
}

/** The shape GitHub answers a 404 with — the one status `isMissing` treats as "not there yet". */
function notFound(): Promise<never> {
  return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
}

describe("isMissing", () => {
  it("is true only for a 404", () => {
    expect(isMissing({ status: 404 })).toBe(true);
    expect(isMissing({ status: 403 })).toBe(false);
    expect(isMissing({ status: 500 })).toBe(false);
  });

  it("is false for anything that is not a status-bearing object", () => {
    expect(isMissing(null)).toBe(false);
    expect(isMissing("boom")).toBe(false);
    expect(isMissing(new Error("boom"))).toBe(false);
  });
});

describe("listCorrectionFiles", () => {
  it("lists only the `.ndjson` shards, ignoring anything else the directory holds", async () => {
    const getContent = vi.fn(() =>
      Promise.resolve({
        data: [
          { name: "2026-08.ndjson", path: ".reeve/corrections/2026-08.ndjson", sha: "a" },
          { name: "README.md", path: ".reeve/corrections/README.md", sha: "b" },
        ],
      }),
    );
    const { api } = contentsOf(getContent);

    const files = await listCorrectionFiles(api, AT, ".reeve/corrections");
    expect(files).toEqual([{ path: ".reeve/corrections/2026-08.ndjson", sha: "a" }]);
  });

  it("is empty, not a failure, when the store directory does not exist yet", async () => {
    const getContent = vi.fn(notFound);
    const { api } = contentsOf(getContent);

    await expect(listCorrectionFiles(api, AT, ".reeve/corrections")).resolves.toEqual([]);
  });

  it("is empty when the path names a file rather than a directory", async () => {
    const getContent = vi.fn(() =>
      Promise.resolve({ data: { name: "corrections", content: "e30=", encoding: "base64" } }),
    );
    const { api } = contentsOf(getContent);

    await expect(listCorrectionFiles(api, AT, ".reeve/corrections")).resolves.toEqual([]);
  });

  it("lets anything other than a 404 propagate, the way any other authentication problem does", async () => {
    const getContent = vi.fn(() =>
      Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 })),
    );
    const { api } = contentsOf(getContent);

    await expect(listCorrectionFiles(api, AT, ".reeve/corrections")).rejects.toThrow("Forbidden");
  });
});

describe("readContentsFile", () => {
  it("decodes the base64 GitHub answers a file's content with", async () => {
    const text = '{"thread":7}\n';
    const getContent = vi.fn(() =>
      Promise.resolve({
        data: {
          content: Buffer.from(text, "utf8").toString("base64"),
          encoding: "base64",
          sha: "abc",
        },
      }),
    );
    const { api } = contentsOf(getContent);

    await expect(readContentsFile(api, AT, ".reeve/corrections/2026-08.ndjson")).resolves.toEqual({
      text,
      sha: "abc",
    });
  });

  it("is null, not a failure, for a shard that is not there yet", async () => {
    const { api } = contentsOf(vi.fn(notFound));

    await expect(
      readContentsFile(api, AT, ".reeve/corrections/2026-08.ndjson"),
    ).resolves.toBeNull();
  });

  it("is null for a path that answers with a directory listing instead of a file", async () => {
    const getContent = vi.fn(() => Promise.resolve({ data: [{ name: "x" }] }));
    const { api } = contentsOf(getContent);

    await expect(readContentsFile(api, AT, ".reeve/corrections")).resolves.toBeNull();
  });

  it("throws, rather than reading it as a cold start, for a shard too large for the API to inline", async () => {
    // GitHub's own shape for a file over 1 MB: present, with a real `sha`,
    // but `content: ""` and `encoding: "none"` instead of the base64 body —
    // reading that as `null` would look exactly like the shard never
    // existed, and `writeCorrection` would append a duplicate beside history
    // it could not see.
    const getContent = vi.fn(() =>
      Promise.resolve({
        data: {
          content: "",
          encoding: "none",
          sha: "big-sha",
          path: ".reeve/corrections/2026-08.ndjson",
        },
      }),
    );
    const { api } = contentsOf(getContent);

    await expect(readContentsFile(api, AT, ".reeve/corrections/2026-08.ndjson")).rejects.toThrow(
      /\.reeve\/corrections\/2026-08\.ndjson.*1 MB/s,
    );
  });

  it("throws its own error class, naming the path, so a caller can skip past it by kind", async () => {
    // `writeCorrection` catches exactly this class to skip an oversized shard
    // rather than failing the whole write — a generic `Error` would leave it
    // no way to tell this apart from a network failure or a missing scope.
    const getContent = vi.fn(() =>
      Promise.resolve({
        data: { content: "", encoding: "none", sha: "big-sha", path: "shard.ndjson" },
      }),
    );
    const { api } = contentsOf(getContent);

    await expect(readContentsFile(api, AT, "shard.ndjson")).rejects.toMatchObject({
      constructor: UnreadableContentsFile,
      path: "shard.ndjson",
    });
  });
});

describe("writeContentsFile", () => {
  it("base64-encodes the text and sends the sha it was given, to replace a known shard", async () => {
    const { api, createOrUpdateFileContents } = contentsOf(vi.fn(notFound));

    await writeContentsFile(
      api,
      AT,
      ".reeve/corrections/2026-08.ndjson",
      "line\n",
      "memory: record #7",
      "abc",
    );
    expect(createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      path: ".reeve/corrections/2026-08.ndjson",
      message: "memory: record #7",
      content: Buffer.from("line\n", "utf8").toString("base64"),
      sha: "abc",
    });
  });

  it("omits `sha` to create a shard that has never been committed before", async () => {
    const { api, createOrUpdateFileContents } = contentsOf(vi.fn(notFound));

    await writeContentsFile(
      api,
      AT,
      ".reeve/corrections/2026-08.ndjson",
      "line\n",
      "memory: record #7",
      null,
    );
    const call = createOrUpdateFileContents.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("sha");
  });

  it("lets a read-only token's refusal propagate as the authentication failure it is", async () => {
    const createOrUpdateFileContents = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
      ),
    );
    const api = {
      rest: { repos: { getContent: vi.fn(notFound), createOrUpdateFileContents } },
    } as ContentsApi;

    await expect(
      writeContentsFile(
        api,
        AT,
        ".reeve/corrections/2026-08.ndjson",
        "line\n",
        "memory: record #7",
        null,
      ),
    ).rejects.toThrow("Resource not accessible by integration");
  });
});
