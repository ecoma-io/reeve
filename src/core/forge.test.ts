import { describe, expect, it, vi } from "vitest";

import {
  createEffects,
  createReply,
  createThread,
  listReplies,
  listRepositoryLabels,
  readStanding,
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
  comments: { id: number; body?: string | null }[] = [],
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
      { id: 991, body: "Tôi cũng gặp lỗi này." },
      { id: 992, body: "Same here." },
    ]);

    await expect(listReplies(api, AT)).resolves.toEqual({
      replies: [
        { id: 991, body: "Tôi cũng gặp lỗi này." },
        { id: 992, body: "Same here." },
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
    expect(replies).toEqual([{ id: 991, body: "" }]);
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
});

describe("createReply", () => {
  const reply = { id: 991, body: OFFICIAL };

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
    });
    expect(get).toHaveBeenCalledWith({ owner: "ecoma-io", repo: "reeve", issue_number: 42 });
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
