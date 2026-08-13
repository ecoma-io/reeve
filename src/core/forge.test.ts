import { describe, expect, it, vi } from "vitest";

import {
  createEffects,
  createReply,
  createThread,
  isCapacityError,
  isMissing,
  listCorrectionFiles,
  listLabelEvents,
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
  const getComment = vi.fn((params: { comment_id: number }) =>
    Promise.resolve({
      data: { body: comments.find((comment) => comment.id === params.comment_id)?.body ?? "" },
    }),
  );
  return {
    api: {
      rest: { issues: { get, update, listComments, updateComment, getComment } },
    } as GitHubApi,
    get,
    update,
    listComments,
    updateComment,
    getComment,
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
      page: 1,
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

  /**
   * A client whose `listComments` answers a different page every call, and
   * reports a real `Link` response header naming the true last page — the
   * signal `listReplies` reads to walk backward from the actual end of the
   * thread, the way a genuine GitHub response does.
   */
  function paged(pages: { id: number; body: string }[][]): GitHubApi {
    const lastPage = pages.length;
    const listComments = vi.fn((params: { page?: number }) => {
      const n = params.page ?? 1;
      return Promise.resolve({
        data: pages[n - 1] ?? [],
        headers:
          lastPage > 1
            ? { link: `<https://api.github.com/x?page=${String(lastPage)}>; rel="last"` }
            : undefined,
      });
    });
    return {
      rest: {
        issues: {
          get: vi.fn(() => Promise.resolve({ data: { body: "" } })),
          update: vi.fn(() => Promise.resolve({})),
          listComments,
          updateComment: vi.fn(() => Promise.resolve({})),
          getComment: vi.fn(() => Promise.resolve({ data: { body: "" } })),
        },
      },
    };
  }

  it("walks backward from the true end of the thread, found through the `Link` header, to reach the newest replies", async () => {
    // GitHub's comment listing has no reverse-chronological order — the only
    // way to the newest ones without walking every page from the start is the
    // `Link` header naming where the thread actually ends.
    const oldest = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      body: `old-${String(index)}`,
    }));
    const newest = [
      { id: 200, body: "Vẫn còn lỗi." },
      { id: 201, body: "Tôi cũng vậy." },
    ];
    const api = paged([oldest, newest]);

    const { replies, more } = await listReplies(api, AT, { max: 2, order: "newest" });

    expect(replies).toEqual([
      { id: 200, body: "Vẫn còn lỗi.", login: "", isBot: false },
      { id: 201, body: "Tôi cũng vậy.", login: "", isBot: false },
    ]);
    expect(more).toBe(true);
    // One request to learn where the thread ends, one to read that page —
    // never the whole hundred-page walk the old, forward-only search paid for.
    expect(api.rest.issues.listComments).toHaveBeenCalledTimes(2);
  });

  it("reaches replies past the page-walk ceiling that a forward walk would have missed entirely", async () => {
    // The bug this replaces: a thread with more pages than `REPLY_PAGES`
    // walked forward from page 1 would stop at page 10, having never seen
    // pages 11–15 — the pages actually holding the newest replies — and hand
    // back the tail of page 10 as though it were "the newest ones".
    const pages = Array.from({ length: 15 }, (_, pageIndex) => {
      const size = pageIndex === 14 ? 50 : 100;
      return Array.from({ length: size }, (_, index) => ({
        id: pageIndex * 100 + index,
        body: `c-${String(pageIndex * 100 + index)}`,
      }));
    });
    const api = paged(pages);

    // `REPLY_PAGE * REPLY_PAGES` (1000) — the largest `max` the ceiling ever
    // serves in full.
    const { replies, more } = await listReplies(api, AT, { max: 1_000, order: "newest" });

    // Genuinely the newest reply on the thread — id 1449, on page 15 — which
    // a forward walk capped at page 10 could never have reached.
    expect(replies.at(-1)?.id).toBe(1449);
    // The oldest reply kept is the first one on page 6 (id 500): the walk
    // reached back exactly `REPLY_PAGES` pages from the true end (15), to
    // page 6, and no further.
    expect(replies[0]?.id).toBe(500);
    expect(more).toBe(true);
    // Pages 2 through 5 hold replies older than the walked window and must
    // never be fetched at all — not "fetched and then discarded".
    for (const page of [2, 3, 4, 5]) {
      expect(api.rest.issues.listComments).not.toHaveBeenCalledWith(
        expect.objectContaining({ page }),
      );
    }
    // Page 1 (the discovery request) plus pages 6 through 15 (the walked
    // window) — eleven requests for a fifteen-page thread, not fifteen.
    expect(api.rest.issues.listComments).toHaveBeenCalledTimes(11);
  });

  it("reaches back into the page before a partial last page, rather than assume every fetched page is full", async () => {
    // The bug this replaces: `pagesNeeded = ceil(max / REPLY_PAGE)` assumed
    // every fetched page holds `REPLY_PAGE` replies, so a 150-reply thread
    // asked for its newest 100 would compute `ceil(100 / 100) = 1` page,
    // walk back exactly one page — the 50-reply last page — and hand back
    // only those 50, missing the 50 replies on the page before it.
    const firstHundred = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      body: `c-${String(index)}`,
    }));
    const lastFifty = Array.from({ length: 50 }, (_, index) => ({
      id: 100 + index,
      body: `c-${String(100 + index)}`,
    }));
    const api = paged([firstHundred, lastFifty]);

    const { replies, more } = await listReplies(api, AT, { max: 100, order: "newest" });

    // Exactly the 100 truly newest replies — ids 50 through 149 — not the 50
    // the last page alone could offer.
    expect(replies).toHaveLength(100);
    expect(replies[0]?.id).toBe(50);
    expect(replies.at(-1)?.id).toBe(149);
    expect(more).toBe(true);
    // Both pages read: the discovery request (page 1, reused for the walk)
    // and the true last page (page 2).
    expect(api.rest.issues.listComments).toHaveBeenCalledTimes(2);
  });

  it("reuses the discovery page instead of re-fetching it, when the backward walk reaches all the way to page 1", async () => {
    const pages = Array.from({ length: 3 }, (_, pageIndex) =>
      Array.from({ length: 100 }, (_, index) => ({
        id: pageIndex * 100 + index,
        body: `c-${String(pageIndex * 100 + index)}`,
      })),
    );
    const api = paged(pages);

    const { replies, more } = await listReplies(api, AT, { max: 1_000, order: "newest" });

    expect(replies).toHaveLength(300);
    expect(replies[0]?.id).toBe(0);
    expect(replies.at(-1)?.id).toBe(299);
    // Nothing older exists past what was walked, and `max` was never reached.
    expect(more).toBe(false);
    // Three pages, not four — page 1 answers both the discovery request and
    // the walk's need for it.
    expect(api.rest.issues.listComments).toHaveBeenCalledTimes(3);
  });

  it("has nothing to walk back to when the whole thread fits on one page — no `Link` header at all", async () => {
    const api = paged([[{ id: 1, body: "Only reply." }]]);

    const { replies, more } = await listReplies(api, AT, { max: 5, order: "newest" });

    expect(replies).toEqual([{ id: 1, body: "Only reply.", login: "", isBot: false }]);
    expect(more).toBe(false);
    expect(api.rest.issues.listComments).toHaveBeenCalledTimes(1);
  });

  it("stops at the first page reading oldest-first, never walking further than `max` needs", async () => {
    const oldest = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      body: `c-${String(index)}`,
    }));
    const api = paged([oldest, oldest]);

    const { replies } = await listReplies(api, AT, { max: 5, order: "oldest" });

    expect(replies).toHaveLength(5);
    expect(replies[0]?.id).toBe(0);
    expect(replies[4]?.id).toBe(4);
    expect(api.rest.issues.listComments).toHaveBeenCalledTimes(1);
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

  it("asks GitHub for a second read, so a re-read after writing sees what actually landed", async () => {
    // The one case the cached first read cannot answer: `publish`'s
    // re-read-after-write, which exists to notice another write racing this
    // one. A second read that just replayed `reply.body` would call every
    // publish "mismatched" — see `core/forge.ts`.
    const { api, getComment } = apiOf("something else", [{ id: 991, body: "edited elsewhere" }]);
    const thread = createReply(api, AT, reply);

    await expect(thread.read()).resolves.toBe(OFFICIAL);
    await expect(thread.read()).resolves.toBe("edited elsewhere");
    expect(getComment).toHaveBeenCalledWith({
      owner: "ecoma-io",
      repo: "reeve",
      comment_id: 991,
    });
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
    pull_request?: unknown;
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
      milestone: null,
      assignees: [],
      createdAt: new Date(0),
      isPullRequest: false,
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
      milestone: null,
      assignees: [],
      createdAt: new Date(0),
      isPullRequest: false,
    });
  });

  it("reads isPullRequest true when the issue payload carries a pull_request field", async () => {
    const { api } = trackerOf({ pull_request: {} });

    await expect(readStanding(api, AT)).resolves.toMatchObject({ isPullRequest: true });
  });

  it("reads isPullRequest false for a plain issue", async () => {
    const { api } = trackerOf({});

    await expect(readStanding(api, AT)).resolves.toMatchObject({ isPullRequest: false });
  });

  it("reads a closed thread as closed", async () => {
    const { api } = trackerOf({ state: "closed" });

    await expect(readStanding(api, AT)).resolves.toMatchObject({ closed: true });
  });
});

describe("listLabelEvents", () => {
  /**
   * A `TrackerApi` whose `listEvents` answers a different page every call —
   * enough to drive the completeness flag past its ceiling, the way a
   * thread with a very long label history would.
   */
  function eventsOf(pages: { event: string; label?: { name?: string } }[][]): TrackerApi {
    const listEvents = vi.fn((params: { page?: number }) =>
      Promise.resolve({ data: pages[(params.page ?? 1) - 1] ?? [] }),
    );
    return {
      rest: {
        issues: {
          get: vi.fn(() => Promise.resolve({ data: {} })),
          update: vi.fn(() => Promise.resolve({})),
          addLabels: vi.fn(() => Promise.resolve({})),
          createComment: vi.fn(() => Promise.resolve({})),
          addAssignees: vi.fn(() => Promise.resolve({})),
          listLabelsForRepo: vi.fn(() => Promise.resolve({ data: [] })),
          listEvents,
        },
      },
    } as unknown as TrackerApi;
  }

  it("reads a short label history as complete", async () => {
    const api = eventsOf([
      [
        { event: "labeled", label: { name: "bug" } },
        { event: "unlabeled", label: { name: "bug" } },
      ],
    ]);

    await expect(listLabelEvents(api, AT)).resolves.toEqual({
      events: [
        { label: "bug", action: "labeled", isBot: false },
        { label: "bug", action: "unlabeled", isBot: false },
      ],
      complete: true,
    });
  });

  it("reports incomplete when the walk hits its page ceiling while the last page read is still full", async () => {
    // Ten full pages of a hundred filler events each — the walk stops at the
    // ceiling never having seen a short page, so it cannot tell whether the
    // real history ends there or keeps going past what it read.
    const full = Array.from({ length: 10 }, () =>
      Array.from({ length: 100 }, () => ({ event: "labeled", label: { name: "filler" } })),
    );
    const api = eventsOf(full);

    const { complete } = await listLabelEvents(api, AT);

    expect(complete).toBe(false);
    expect(api.rest.issues.listEvents).toHaveBeenCalledTimes(10);
  });

  it("reports complete when the history ends exactly on a full page", async () => {
    // A history that happens to be precisely `EVENT_PAGE * EVENT_PAGES` long
    // must not be confused with one that was cut off: the next page, asked
    // for, comes back empty rather than short, and that is what tells the
    // walk it has genuinely reached the end.
    const nine = Array.from({ length: 9 }, () =>
      Array.from({ length: 100 }, () => ({ event: "labeled", label: { name: "filler" } })),
    );
    const api = eventsOf([...nine, []]);

    const { complete } = await listLabelEvents(api, AT);

    expect(complete).toBe(true);
    expect(api.rest.issues.listEvents).toHaveBeenCalledTimes(10);
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

  it("asks for closed or all threads when told to, instead of the open default", async () => {
    const { api, listForRepo } = sweepOf([[entry(3, "2026-03-01T00:00:00Z")]]);

    await listOpenThreads(api, where, null, "closed");

    expect(listForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: "closed" }));
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

  it("pages past 1,000 open threads rather than silently stopping there", async () => {
    // The bug this guards against: a repository with more than 1,000 open
    // issues used to get stuck on the first 1,000 forever, `since` or no
    // `since`, because a fixed page ceiling stopped the walk regardless of
    // whether there was more to find. Paging now follows the tracker's own
    // listing to the end.
    const full = Array.from({ length: 100 }, (_, index) => entry(index, "2026-03-01T00:00:00Z"));
    const last = [entry(9999, "2026-03-01T00:00:00Z")];
    const { api, listForRepo } = sweepOf([...Array.from({ length: 15 }, () => full), last]);

    await expect(listOpenThreads(api, where, null)).resolves.toHaveLength(1_501);
    expect(listForRepo).toHaveBeenCalledTimes(16);
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

describe("isCapacityError", () => {
  it("is true for a 429 or any 5xx status — D12's weather side", () => {
    expect(isCapacityError({ status: 429 })).toBe(true);
    expect(isCapacityError({ status: 500 })).toBe(true);
    expect(isCapacityError({ status: 503 })).toBe(true);
  });

  it("is true for a network-timeout-shaped error with no status at all", () => {
    expect(isCapacityError(new Error("request timed out"))).toBe(true);
    expect(isCapacityError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isCapacityError(new Error("socket hang up: ECONNRESET"))).toBe(true);
    expect(isCapacityError(new Error("network error"))).toBe(true);
  });

  it("is false for auth/configuration statuses — D12's red side", () => {
    expect(isCapacityError({ status: 401 })).toBe(false);
    expect(isCapacityError({ status: 403 })).toBe(false);
    expect(isCapacityError({ status: 404 })).toBe(false);
  });

  it("is false for an ordinary error with no capacity-shaped message", () => {
    expect(isCapacityError(new Error("bad request"))).toBe(false);
    expect(isCapacityError(null)).toBe(false);
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

  it("passes `ref` through to `getContent` when given", async () => {
    const getContent = vi.fn(() =>
      Promise.resolve({
        data: [{ name: "2026-08.ndjson", path: ".reeve/corrections/2026-08.ndjson", sha: "a" }],
      }),
    );
    const { api } = contentsOf(getContent);

    const files = await listCorrectionFiles(api, AT, ".reeve/corrections", "reeve/corrections");
    expect(files).toEqual([{ path: ".reeve/corrections/2026-08.ndjson", sha: "a" }]);
    expect(getContent).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      path: ".reeve/corrections",
      ref: "reeve/corrections",
    });
  });

  it("omits `ref` from the `getContent` call when not given", async () => {
    const getContent = vi.fn((_params: Record<string, unknown>) => Promise.resolve({ data: [] }));
    const { api } = contentsOf(getContent);

    await listCorrectionFiles(api, AT, ".reeve/corrections");
    const call = getContent.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("ref");
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

  it("passes `ref` through to `getContent` when given", async () => {
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

    await expect(
      readContentsFile(api, AT, ".reeve/provenance/state.json", "reeve/corrections"),
    ).resolves.toEqual({
      text,
      sha: "abc",
    });
    expect(getContent).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      path: ".reeve/provenance/state.json",
      ref: "reeve/corrections",
    });
  });

  it("omits `ref` from the `getContent` call when not given", async () => {
    const text = '{"thread":7}\n';
    const getContent = vi.fn((_params: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          content: Buffer.from(text, "utf8").toString("base64"),
          encoding: "base64",
          sha: "abc",
        },
      }),
    );
    const { api } = contentsOf(getContent);

    await readContentsFile(api, AT, ".reeve/corrections/2026-08.ndjson");
    const call = getContent.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("ref");
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

  it("passes `branch` through to `createOrUpdateFileContents` when given", async () => {
    const { api, createOrUpdateFileContents } = contentsOf(vi.fn(notFound));

    await writeContentsFile(
      api,
      AT,
      ".reeve/provenance/state.json",
      '{"id":"docs/guide"}\n',
      "harmonise: update provenance state",
      "abc",
      "reeve/corrections",
    );
    expect(createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: AT.owner,
      repo: AT.repo,
      path: ".reeve/provenance/state.json",
      message: "harmonise: update provenance state",
      content: Buffer.from('{"id":"docs/guide"}\n', "utf8").toString("base64"),
      sha: "abc",
      branch: "reeve/corrections",
    });
  });

  it("omits `branch` from the `createOrUpdateFileContents` call when not given", async () => {
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
    expect(call).not.toHaveProperty("branch");
  });
});
