import { describe, expect, it, vi } from "vitest";

import { createReply, createThread, listReplies, type GitHubApi } from "./forge.js";

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
