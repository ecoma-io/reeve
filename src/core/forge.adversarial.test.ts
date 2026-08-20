/**
 * The GitHub boundary's failure semantics, one call site at a time.
 *
 * `forge.test.ts` pins what each port does when GitHub answers. This file
 * pins what each port does when GitHub *fails*, and the rule it exists to
 * enforce is that every status has exactly ONE defined semantic — retry,
 * fallback, skip, rollback or fail — and that no status reaches a generic path
 * by accident. Every case below names the semantic it pins in its own name.
 *
 * The cases are an enumeration rather than a sample: every mutating call site
 * is asked about the same `FAIL_STATUSES` list, so a call-site-and-status pair
 * with no case here is behaviour nothing pins — a gap left visible rather than
 * absorbed into a default nobody chose.
 *
 * Nothing here is retried anywhere in this module — that is the boundary's
 * actual, documented posture (`docs/development/failure-matrix.md`'s "[GAP]
 * GitHub retry"), and the cases below make it executable rather than assumed.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createEffects,
  createLifecycleEffects,
  createReply,
  createRepositoryLabel,
  createThread,
  isCapacityError,
  listLabelEvents,
  listOpenThreads,
  listReplies,
  listRepositoryLabels,
  readBlob,
  readContentsFile,
  readStanding,
  UnreadableBlob,
  type BlobApi,
  type ContentsApi,
  type GitHubApi,
  type TrackerApi,
} from "./forge.js";

const AT = { owner: "ecoma-io", repo: "reeve", number: 42 };

/** An HTTP failure shaped the way Octokit's `RequestError` is. */
const http = (status: number): Error =>
  Object.assign(new Error(`HTTP ${String(status)}`), { status });

/** The statuses every mutating call site is asked about. */
const FAIL_STATUSES = [401, 403, 404, 409, 422, 429, 500, 502, 503] as const;

/** A network timeout with no status at all — the shape `AbortSignal.timeout` throws. */
function timeout(): Error {
  const error = new Error("Request timed out");
  error.name = "TimeoutError";
  return error;
}

/** A rejecting stub for one named issues method; every other method throws if touched. */
function rejectingIssues(method: string, error: unknown): TrackerApi & GitHubApi {
  const guard = () => {
    throw new Error(`unexpected call to a method other than ${method}`);
  };
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the caller chooses the rejection shape, including non-Error ones
  const reject = () => Promise.reject(error);
  const issues = new Proxy(
    {},
    {
      get: (_t, name) => (String(name) === method ? reject : guard),
    },
  ) as never;
  const repos = new Proxy({}, { get: () => guard }) as never;
  return { rest: { issues, repos } };
}

describe("createThread — read and write a thread body", () => {
  for (const status of FAIL_STATUSES) {
    it(`read_${String(status)}_fails_the_run_no_retry_no_fallback`, async () => {
      const api = rejectingIssues("get", http(status));
      await expect(createThread(api, AT).read()).rejects.toMatchObject({ status });
    });

    it(`write_${String(status)}_fails_the_run_no_retry_no_fallback`, async () => {
      const api = rejectingIssues("update", http(status));
      await expect(createThread(api, AT).write("x")).rejects.toMatchObject({ status });
    });
  }

  it("read_timeout_fails_the_run", async () => {
    const api = rejectingIssues("get", timeout());
    await expect(createThread(api, AT).read()).rejects.toThrow("Request timed out");
  });

  it("a_body_of_null_reads_as_empty_text_not_as_a_failure", async () => {
    // GitHub answers an issue whose body was cleared with `body: null`. That
    // is a real, empty body — never a missing resource.
    const get = vi.fn(() => Promise.resolve({ data: { body: null } }));
    const api = { rest: { issues: { get } } } as unknown as GitHubApi;
    await expect(createThread(api, AT).read()).resolves.toBe("");
  });

  it("a_response_with_no_data_field_at_all_fails_loudly", async () => {
    // A malformed answer is not an empty body: destructuring `undefined` is
    // what makes the difference visible instead of silently reading as "".
    const get = vi.fn(() => Promise.resolve(undefined as never));
    const api = { rest: { issues: { get } } } as unknown as GitHubApi;
    await expect(createThread(api, AT).read()).rejects.toThrow(TypeError);
  });

  it("a_failed_write_never_reports_success_to_its_caller", async () => {
    const api = rejectingIssues("update", http(422));
    let settled: string | null = null;
    await createThread(api, AT)
      .write("x")
      .then(
        () => (settled = "resolved"),
        () => (settled = "rejected"),
      );
    expect(settled).toBe("rejected");
  });
});

describe("createReply — the comment port", () => {
  const reply = { id: 9, body: "hello", login: "octocat", isBot: false };

  it("the_first_read_costs_no_request_and_so_cannot_fail", async () => {
    const getComment = vi.fn(() => Promise.reject(http(500)));
    const api = { rest: { issues: { getComment } } } as unknown as GitHubApi;
    await expect(createReply(api, AT, reply).read()).resolves.toBe("hello");
    expect(getComment).not.toHaveBeenCalled();
  });

  for (const status of [404, 403, 429, 500] as const) {
    it(`the_re_read_after_write_propagates_${String(status)}_rather_than_reusing_the_stale_body`, async () => {
      // The re-read exists to notice a concurrent edit. Answering it from the
      // body already in hand would report "no race" for a comment this run can
      // no longer see — a silent success is the one thing it must not be.
      const getComment = vi.fn(() => Promise.reject(http(status)));
      const api = { rest: { issues: { getComment } } } as unknown as GitHubApi;
      const thread = createReply(api, AT, reply);
      await thread.read();
      await expect(thread.read()).rejects.toMatchObject({ status });
    });
  }

  for (const status of FAIL_STATUSES) {
    it(`write_${String(status)}_fails_the_run_no_retry_no_fallback`, async () => {
      const updateComment = vi.fn(() => Promise.reject(http(status)));
      const api = { rest: { issues: { updateComment } } } as unknown as GitHubApi;
      await expect(createReply(api, AT, reply).write("x")).rejects.toMatchObject({ status });
    });
  }
});

describe("createEffects — every way a duty changes a tracker", () => {
  /** Each effect, with an argument that actually reaches the API. */
  const effects = {
    addLabels: (e: ReturnType<typeof createEffects>) => e.addLabels(["bug"]),
    comment: (e: ReturnType<typeof createEffects>) => e.comment("hi"),
    assign: (e: ReturnType<typeof createEffects>) => e.assign(["octocat"]),
    closeAsNotPlanned: (e: ReturnType<typeof createEffects>) => e.closeAsNotPlanned(),
  } as const;
  const method = {
    addLabels: "addLabels",
    comment: "createComment",
    assign: "addAssignees",
    closeAsNotPlanned: "update",
  } as const;

  for (const name of Object.keys(effects) as (keyof typeof effects)[]) {
    for (const status of FAIL_STATUSES) {
      it(`${name}_${String(status)}_fails_the_run_and_never_reports_a_silent_success`, async () => {
        const api = rejectingIssues(method[name], http(status));
        await expect(effects[name](createEffects(api, AT))).rejects.toMatchObject({ status });
      });
    }

    it(`${name}_timeout_fails_the_run`, async () => {
      const api = rejectingIssues(method[name], timeout());
      await expect(effects[name](createEffects(api, AT))).rejects.toThrow("Request timed out");
    });
  }

  it("an_empty_label_list_spends_no_request_at_all", async () => {
    const api = rejectingIssues("addLabels", http(500));
    await expect(createEffects(api, AT).addLabels([])).resolves.toBeUndefined();
  });

  it("an_empty_assignee_list_spends_no_request_at_all", async () => {
    const api = rejectingIssues("addAssignees", http(500));
    await expect(createEffects(api, AT).assign([])).resolves.toBeUndefined();
  });
});

describe("createLifecycleEffects — the one bounded removal", () => {
  for (const status of FAIL_STATUSES) {
    it(`removeLabel_${String(status)}_fails_the_run_no_retry_no_fallback`, async () => {
      // 404 included on purpose: "the label was already gone" is not folded
      // into success here, because this port does not decide that question.
      const api = rejectingIssues("removeLabel", http(status));
      await expect(createLifecycleEffects(api, AT).removeLabel("stale")).rejects.toMatchObject({
        status,
      });
    });
  }

  it("removes_exactly_the_one_name_it_was_given", async () => {
    const removeLabel = vi.fn(() => Promise.resolve({}));
    const api = { rest: { issues: { removeLabel } } } as unknown as TrackerApi;
    await createLifecycleEffects(api, AT).removeLabel("stale");
    expect(removeLabel).toHaveBeenCalledExactlyOnceWith({
      owner: "ecoma-io",
      repo: "reeve",
      issue_number: 42,
      name: "stale",
    });
  });

  it("still_carries_every_adds_only_effect_of_the_narrow_port", () => {
    const api = { rest: { issues: {} } } as unknown as TrackerApi;
    const effects = createLifecycleEffects(api, AT);
    expect(Object.keys(effects).sort()).toEqual(
      ["addLabels", "assign", "closeAsNotPlanned", "comment", "removeLabel"].sort(),
    );
  });
});

describe("createRepositoryLabel", () => {
  for (const status of [401, 403, 404, 422, 429, 500] as const) {
    it(`a_${String(status)}_fails_the_run_rather_than_reading_as_already_created`, async () => {
      // 422 is GitHub's "already exists" for this endpoint, and it is NOT
      // folded into success: a name that already exists carries somebody
      // else's colour and description, which this call has no standing to
      // adopt silently.
      const api = rejectingIssues("createLabel", http(status));
      await expect(
        createRepositoryLabel(api, AT, { name: "bug", color: null, description: "d" }),
      ).rejects.toMatchObject({ status });
    });
  }

  it("falls_back_to_a_neutral_colour_and_caps_the_description_at_a_hundred", async () => {
    const createLabel = vi.fn(() => Promise.resolve({}));
    const api = { rest: { issues: { createLabel } } } as unknown as TrackerApi;
    await createRepositoryLabel(api, AT, {
      name: "bug",
      color: null,
      description: "x".repeat(250),
    });
    expect(createLabel).toHaveBeenCalledExactlyOnceWith({
      owner: "ecoma-io",
      repo: "reeve",
      name: "bug",
      color: "ededed",
      description: "x".repeat(100),
    });
  });
});

describe("readBlob", () => {
  function blobApi(answer: () => Promise<unknown>): BlobApi {
    return { rest: { git: { getBlob: answer } } } as unknown as BlobApi;
  }

  it("decodes_the_base64_the_blobs_api_answers_with", async () => {
    const api = blobApi(() =>
      Promise.resolve({
        data: {
          content: Buffer.from("hello", "utf8").toString("base64"),
          encoding: "base64",
          sha: "a".repeat(40),
          size: 5,
        },
      }),
    );
    await expect(readBlob(api, AT, "a".repeat(40))).resolves.toBe("hello");
  });

  it("a_404_is_null_the_force_push_case_not_a_failure", async () => {
    const api = blobApi(() => Promise.reject(http(404)));
    await expect(readBlob(api, AT, "a".repeat(40))).resolves.toBeNull();
  });

  for (const status of [401, 403, 409, 422, 429, 500] as const) {
    it(`a_${String(status)}_fails_the_run_rather_than_reading_as_an_unreachable_sha`, async () => {
      // The distinction is load-bearing: `null` means "the previous state
      // cannot be resolved"; folding a permissions failure into it would make
      // a caller compute a diff against an empty file it never read.
      const api = blobApi(() => Promise.reject(http(status)));
      await expect(readBlob(api, AT, "a".repeat(40))).rejects.toMatchObject({ status });
    });
  }

  it("a_blob_answered_without_base64_content_throws_rather_than_reading_as_empty", async () => {
    const api = blobApi(() =>
      Promise.resolve({ data: { content: "", encoding: "none", sha: "b".repeat(40), size: 9e6 } }),
    );
    await expect(readBlob(api, AT, "b".repeat(40))).rejects.toBeInstanceOf(UnreadableBlob);
  });

  it("names_the_sha_it_could_not_read_so_a_catcher_need_not_parse_the_message", async () => {
    const sha = "c".repeat(40);
    const api = blobApi(() => Promise.resolve({ data: { encoding: "utf-8", sha, size: null } }));
    await expect(readBlob(api, AT, sha)).rejects.toMatchObject({ name: "UnreadableBlob", sha });
  });
});

describe("readStanding — malformed and missing fields", () => {
  function standingApi(data: unknown): TrackerApi {
    return { rest: { issues: { get: () => Promise.resolve({ data }) } } } as unknown as TrackerApi;
  }

  for (const status of FAIL_STATUSES) {
    it(`a_${String(status)}_fails_the_run_no_fallback_standing`, async () => {
      const api = rejectingIssues("get", http(status));
      await expect(readStanding(api, AT)).rejects.toMatchObject({ status });
    });
  }

  it("an_answer_with_every_field_absent_reads_as_an_empty_standing_not_a_crash", async () => {
    await expect(readStanding(standingApi({}), AT)).resolves.toEqual({
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

  it("a_created_at_that_is_not_a_date_reads_as_an_invalid_date_never_as_now", async () => {
    // ADJUDICATE: an unparseable `created_at` becomes `Invalid Date`, not the
    // epoch fallback and not the current time. Pinned as current behaviour —
    // a clock-driven default would make every inactivity decision wrong in the
    // direction of "no time has passed".
    const out = await readStanding(standingApi({ created_at: "not-a-date" }), AT);
    expect(Number.isNaN(out.createdAt.getTime())).toBe(true);
  });

  it("a_label_list_mixing_strings_objects_and_empties_keeps_only_real_names", async () => {
    // Both documented shapes are read, and an unnamed entry is dropped rather
    // than becoming an empty string every guardrail then treats as a label.
    const out = await readStanding(
      standingApi({ labels: ["bug", { name: "triage" }, { name: "" }, {}, ""] }),
      AT,
    );
    expect(out.labels).toEqual(["bug", "triage"]);
  });

  it("a_null_entry_in_the_label_list_throws_while_a_null_assignee_is_dropped", async () => {
    // ADJUDICATE: the assignee mapping guards `null` (`assignee?.login`), the
    // label mapping one line above it does not (`label.name`). GitHub does not
    // send a null label today, so this pins the asymmetry rather than guessing
    // at which side is intended — a run that sees one gets a TypeError naming
    // `name`, not a thread that silently reads as unlabelled.
    await expect(readStanding(standingApi({ labels: [null] }), AT)).rejects.toThrow(TypeError);
    await expect(readStanding(standingApi({ assignees: [null] }), AT)).resolves.toMatchObject({
      assignees: [],
    });
  });

  it("a_pull_request_field_present_but_null_still_reads_as_a_pull_request", async () => {
    // `undefined` is the only "not a pull request" answer; GitHub sends the
    // key with a value on a PR's issue record and omits it on a plain issue.
    const out = await readStanding(standingApi({ pull_request: null }), AT);
    expect(out.isPullRequest).toBe(true);
  });
});

describe("listReplies — pagination boundaries", () => {
  function pager(pages: Record<number, { id: number; body?: string | null }[]>, link?: string) {
    const calls: number[] = [];
    const listComments = vi.fn((params: { page?: number }) => {
      const page = params.page ?? 1;
      calls.push(page);
      return Promise.resolve({
        data: pages[page] ?? [],
        ...(page === 1 && link !== undefined ? { headers: { link } } : {}),
      });
    });
    return { api: { rest: { issues: { listComments } } } as unknown as GitHubApi, calls };
  }

  const page = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => ({ id: from + i, body: `c${String(from + i)}` }));

  it("an_empty_page_is_one_request_and_no_replies", async () => {
    const { api, calls } = pager({});
    await expect(listReplies(api, AT)).resolves.toEqual({ replies: [], more: false });
    expect(calls).toEqual([1]);
  });

  it("exactly_one_full_page_reports_more_because_the_next_page_was_never_read", async () => {
    // A full page is honest about the ceiling rather than claiming the thread
    // ended exactly there.
    const { api, calls } = pager({ 1: page(100, 1) });
    const out = await listReplies(api, AT);
    expect(out.replies).toHaveLength(100);
    expect(out.more).toBe(true);
    expect(calls).toEqual([1]);
  });

  it("a_short_page_ends_the_walk_and_reports_no_more", async () => {
    const { api, calls } = pager({ 1: page(3, 1) });
    await expect(listReplies(api, AT)).resolves.toMatchObject({ more: false });
    expect(calls).toEqual([1]);
  });

  it("a_404_on_the_first_page_fails_rather_than_reading_as_an_empty_thread", async () => {
    // A thread that is gone and a thread with no replies must never be the
    // same answer: one is a missing resource, the other is a real, empty read.
    const listComments = vi.fn(() => Promise.reject(http(404)));
    const api = { rest: { issues: { listComments } } } as unknown as GitHubApi;
    await expect(listReplies(api, AT)).rejects.toMatchObject({ status: 404 });
  });

  for (const status of [403, 429, 500] as const) {
    it(`a_${String(status)}_midway_through_the_walk_fails_rather_than_returning_a_partial_thread`, async () => {
      let served = 0;
      const listComments = vi.fn(() => {
        served += 1;
        if (served === 1) return Promise.resolve({ data: page(100, 1) });
        return Promise.reject(http(status));
      });
      const api = { rest: { issues: { listComments } } } as unknown as GitHubApi;
      await expect(listReplies(api, AT, { max: 200 })).rejects.toMatchObject({ status });
    });
  }

  it("newest_order_with_no_link_header_treats_the_first_page_as_the_whole_thread", async () => {
    const { api, calls } = pager({ 1: page(3, 1) });
    const out = await listReplies(api, AT, { order: "newest", max: 2 });
    expect(out.replies.map((r) => r.id)).toEqual([2, 3]);
    expect(calls).toEqual([1]);
  });

  it("newest_order_ignores_a_link_header_that_names_no_last_page", async () => {
    const { api, calls } = pager(
      { 1: page(3, 1) },
      '<https://api.github.com/x?page=2>; rel="next"',
    );
    await expect(listReplies(api, AT, { order: "newest", max: 2 })).resolves.toMatchObject({
      more: true,
    });
    expect(calls).toEqual([1]);
  });

  it("newest_order_ignores_a_malformed_last_page_number", async () => {
    // `page=abc` cannot name a page, so the walk must not invent one.
    const { api, calls } = pager(
      { 1: page(3, 1) },
      '<https://api.github.com/x?page=abc>; rel="last"',
    );
    await expect(listReplies(api, AT, { order: "newest" })).resolves.toMatchObject({ more: false });
    expect(calls).toEqual([1]);
  });

  it("newest_order_walks_backward_from_the_true_last_page_and_reuses_page_one", async () => {
    const { api, calls } = pager(
      { 1: page(100, 1), 2: page(50, 101) },
      '<https://api.github.com/x?page=2>; rel="last"',
    );
    const out = await listReplies(api, AT, { order: "newest", max: 100 });
    expect(out.replies.map((r) => r.id)).toEqual(Array.from({ length: 100 }, (_, i) => 51 + i));
    // Page 1 is fetched once, to learn where the thread ends, and reused.
    expect(calls).toEqual([1, 2]);
  });

  it("newest_order_stops_at_the_page_ceiling_and_says_the_thread_is_longer", async () => {
    const pages: Record<number, { id: number }[]> = {};
    for (let n = 1; n <= 40; n += 1) pages[n] = page(100, n * 100);
    const { api, calls } = pager(pages, '<https://api.github.com/x?page=40>; rel="last"');
    const out = await listReplies(api, AT, { order: "newest", max: 5000 });
    expect(calls).toHaveLength(11); // the establishing read of page 1, then ten walked pages
    expect(out.more).toBe(true);
  });

  it("a_page_that_shrank_under_the_walk_reports_what_it_actually_read", async () => {
    // The `Link` header named page 3, but by the time the walk got there the
    // thread had lost comments and pages 2-3 came back empty. The answer must
    // be the replies that really exist, never fabricated ones.
    const { api } = pager(
      { 1: page(100, 1), 2: [], 3: [] },
      '<https://api.github.com/x?page=3>; rel="last"',
    );
    const out = await listReplies(api, AT, { order: "newest", max: 10 });
    expect(out.replies.map((r) => r.id)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it("a_comment_with_no_author_reads_as_an_empty_login_and_not_a_bot", async () => {
    const { api } = pager({ 1: [{ id: 1, body: null }] });
    const out = await listReplies(api, AT);
    expect(out.replies[0]).toEqual({ id: 1, body: "", login: "", isBot: false });
  });
});

describe("listRepositoryLabels — pagination boundaries", () => {
  function pager(pages: Record<number, { name: string; description?: string | null }[]>) {
    const calls: number[] = [];
    const listLabelsForRepo = vi.fn((params: { page?: number }) => {
      calls.push(params.page ?? 1);
      return Promise.resolve({ data: pages[params.page ?? 1] ?? [] });
    });
    return { api: { rest: { issues: { listLabelsForRepo } } } as unknown as TrackerApi, calls };
  }
  const labels = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `l${String(from + i)}` }));

  it("an_empty_first_page_is_one_request_and_no_labels", async () => {
    const { api, calls } = pager({});
    await expect(listRepositoryLabels(api, AT)).resolves.toEqual([]);
    expect(calls).toEqual([1]);
  });

  it("exactly_one_full_page_walks_a_second_before_concluding", async () => {
    const { api, calls } = pager({ 1: labels(100, 1) });
    expect(await listRepositoryLabels(api, AT)).toHaveLength(100);
    expect(calls).toEqual([1, 2]);
  });

  it("the_walk_stops_at_ten_pages_of_a_pathological_taxonomy", async () => {
    const pages: Record<number, { name: string }[]> = {};
    for (let n = 1; n <= 20; n += 1) pages[n] = labels(100, n * 100);
    const { api, calls } = pager(pages);
    expect(await listRepositoryLabels(api, AT)).toHaveLength(1000);
    expect(calls).toHaveLength(10);
  });

  it("a_page_repeating_the_previous_one_is_kept_verbatim_never_deduplicated", async () => {
    // ADJUDICATE: this port does not dedupe. A listing that changes under the
    // walk can therefore report a label twice. Pinned as current behaviour so
    // a consumer that needs uniqueness knows it must ask for it.
    const { api } = pager({ 1: labels(100, 1), 2: labels(1, 1) });
    const out = await listRepositoryLabels(api, AT);
    expect(out.filter((label) => label.name === "l1")).toHaveLength(2);
  });

  for (const status of [401, 403, 404, 429, 500] as const) {
    it(`a_${String(status)}_fails_rather_than_reading_as_a_repository_with_no_labels`, async () => {
      const listLabelsForRepo = vi.fn(() => Promise.reject(http(status)));
      const api = { rest: { issues: { listLabelsForRepo } } } as unknown as TrackerApi;
      await expect(listRepositoryLabels(api, AT)).rejects.toMatchObject({ status });
    });
  }
});

describe("listOpenThreads — pagination boundaries", () => {
  function pager(pages: Record<number, { number: number; created_at: string }[]>) {
    const calls: number[] = [];
    const listForRepo = vi.fn((params: { page?: number }) => {
      calls.push(params.page ?? 1);
      return Promise.resolve({ data: pages[params.page ?? 1] ?? [] });
    });
    return { api: { rest: { issues: { listForRepo } } } as unknown as TrackerApi, calls };
  }
  const entries = (n: number, from: number, at = "2026-01-01T00:00:00Z") =>
    Array.from({ length: n }, (_, i) => ({ number: from + i, created_at: at }));

  it("an_empty_first_page_is_one_request_and_nothing_listed", async () => {
    const { api, calls } = pager({});
    await expect(listOpenThreads(api, AT, null)).resolves.toEqual([]);
    expect(calls).toEqual([1]);
  });

  it("a_since_bound_stops_the_walk_at_the_first_entry_before_it", async () => {
    const { api, calls } = pager({
      1: [
        ...entries(2, 1, "2026-02-01T00:00:00Z"),
        ...entries(1, 3, "2020-01-01T00:00:00Z"),
        ...entries(1, 4, "2026-02-01T00:00:00Z"),
      ],
    });
    const out = await listOpenThreads(api, AT, new Date("2026-01-01T00:00:00Z"));
    // The sort makes `since` a true prefix: everything after the first entry
    // before the bound is dropped, including a later one that would have
    // passed on its own date.
    expect(out.map((entry) => entry.number)).toEqual([1, 2]);
    expect(calls).toEqual([1]);
  });

  it("maxPages_bounds_a_listing_that_never_serves_a_short_page", async () => {
    // ADJUDICATE / see the GitHub failure matrix: with `maxPages` undefined
    // this walk has no ceiling of its own — it stops only at `since` or a
    // short page. A listing that keeps answering full pages therefore has no
    // bound but the platform's own honesty. `maxPages` is the only guard, and
    // it is opt-in.
    const pages: Record<number, { number: number; created_at: string }[]> = {};
    for (let n = 1; n <= 50; n += 1) pages[n] = entries(100, n * 100);
    const { api, calls } = pager(pages);
    const out = await listOpenThreads(api, AT, null, "open", 3);
    expect(out).toHaveLength(300);
    expect(calls).toEqual([1, 2, 3]);
  });

  for (const status of [401, 403, 404, 422, 429, 500] as const) {
    it(`a_${String(status)}_fails_rather_than_reading_as_an_empty_backlog`, async () => {
      const listForRepo = vi.fn(() => Promise.reject(http(status)));
      const api = { rest: { issues: { listForRepo } } } as unknown as TrackerApi;
      await expect(listOpenThreads(api, AT, null)).rejects.toMatchObject({ status });
    });
  }
});

describe("listLabelEvents — pagination boundaries", () => {
  function pager(pages: Record<number, { event?: string; label?: { name?: string } }[]>) {
    const calls: number[] = [];
    const listEvents = vi.fn((params: { page?: number }) => {
      calls.push(params.page ?? 1);
      return Promise.resolve({ data: pages[params.page ?? 1] ?? [] });
    });
    return { api: { rest: { issues: { listEvents } } } as unknown as TrackerApi, calls };
  }
  const noise = (n: number) => Array.from({ length: n }, () => ({ event: "commented" }));

  it("an_empty_timeline_is_complete_with_no_events", async () => {
    const { api, calls } = pager({});
    await expect(listLabelEvents(api, AT)).resolves.toEqual({ events: [], complete: true });
    expect(calls).toEqual([1]);
  });

  it("the_ceiling_reports_incomplete_so_no_event_is_never_confused_with_not_read", async () => {
    const pages: Record<number, { event?: string }[]> = {};
    for (let n = 1; n <= 20; n += 1) pages[n] = noise(100);
    const { api, calls } = pager(pages);
    const out = await listLabelEvents(api, AT);
    expect(calls).toHaveLength(10);
    expect(out.complete).toBe(false);
  });

  it("a_labeled_event_with_no_label_name_is_dropped_not_recorded_as_an_empty_label", async () => {
    const { api } = pager({ 1: [{ event: "labeled" }, { event: "labeled", label: { name: "" } }] });
    await expect(listLabelEvents(api, AT)).resolves.toEqual({ events: [], complete: true });
  });

  for (const status of [401, 403, 404, 429, 500] as const) {
    it(`a_${String(status)}_fails_rather_than_reading_as_a_thread_nobody_labelled`, async () => {
      const listEvents = vi.fn(() => Promise.reject(http(status)));
      const api = { rest: { issues: { listEvents } } } as unknown as TrackerApi;
      await expect(listLabelEvents(api, AT)).rejects.toMatchObject({ status });
    });
  }
});

describe("shapes GitHub really sends that must not be read as something else", () => {
  it("a_re_read_comment_whose_body_was_cleared_reads_as_empty_not_as_unchanged", async () => {
    // The re-read-after-write exists to notice a concurrent edit. A body
    // cleared to `null` IS such an edit, so it must come back as "" rather
    // than as the body this run wrote.
    const getComment = vi.fn(() => Promise.resolve({ data: { body: null } }));
    const api = { rest: { issues: { getComment } } } as unknown as GitHubApi;
    const thread = createReply(api, AT, { id: 9, body: "written", login: "l", isBot: false });
    await thread.read();
    await expect(thread.read()).resolves.toBe("");
  });

  it("a_listed_thread_reports_both_documented_label_shapes_and_drops_the_unnamed", async () => {
    const listForRepo = vi.fn(() =>
      Promise.resolve({
        data: [
          {
            number: 1,
            created_at: "2026-01-01T00:00:00Z",
            labels: ["bug", { name: "triage" }, { name: "" }, {}],
          },
        ],
      }),
    );
    const api = { rest: { issues: { listForRepo } } } as unknown as TrackerApi;
    const [only] = await listOpenThreads(api, AT, null);
    expect(only?.labels).toEqual(["bug", "triage"]);
  });

  it("a_listed_thread_with_a_pull_request_field_is_marked_as_one", async () => {
    const listForRepo = vi.fn(() =>
      Promise.resolve({
        data: [
          { number: 1, created_at: "2026-01-01T00:00:00Z" },
          { number: 2, created_at: "2026-01-01T00:00:00Z", pull_request: { url: "u" } },
        ],
      }),
    );
    const api = { rest: { issues: { listForRepo } } } as unknown as TrackerApi;
    const listed = await listOpenThreads(api, AT, null);
    expect(listed.map((entry) => entry.isPullRequest)).toEqual([false, true]);
  });

  it("a_contents_answer_with_no_sha_reads_as_nothing_there_rather_than_as_a_file", async () => {
    // A response this function cannot recognise as a file entry is the same
    // "nothing here" a directory listing already is — never a decode attempt
    // on a shape that has no identity to write back against.
    const getContent = vi.fn(() =>
      Promise.resolve({ data: { content: "aGk=", encoding: "base64" } }),
    );
    const api = { rest: { repos: { getContent } } } as unknown as ContentsApi;
    await expect(readContentsFile(api, AT, "store/a.ndjson")).resolves.toBeNull();
  });

  it("a_contents_answer_with_a_non_string_sha_also_reads_as_nothing_there", async () => {
    const getContent = vi.fn(() =>
      Promise.resolve({ data: { content: "aGk=", encoding: "base64", sha: 7 } }),
    );
    const api = { rest: { repos: { getContent } } } as unknown as ContentsApi;
    await expect(readContentsFile(api, AT, "store/a.ndjson")).resolves.toBeNull();
  });
});

describe("isCapacityError — header shapes that must not decide a run's colour", () => {
  /** A 403 carrying whatever `.response.headers` the wire, or an attacker, produced. */
  const forbidden = (headers: unknown): Error =>
    Object.assign(new Error("HTTP 403"), { status: 403, response: { status: 403, headers } });

  it("a_403_whose_headers_are_a_string_stays_red_without_throwing", () => {
    // A body-shaped or truncated response can hand this a string where a
    // record belongs. Indexing it would find nothing; iterating it would
    // walk its characters. Neither is allowed to end in `true`.
    expect(() => isCapacityError(forbidden("retry-after: 60"))).not.toThrow();
    expect(isCapacityError(forbidden("retry-after: 60"))).toBe(false);
    expect(isCapacityError(forbidden("x-ratelimit-remaining: 0"))).toBe(false);
  });

  it("a_403_whose_headers_are_an_array_stays_red_without_throwing", () => {
    expect(isCapacityError(forbidden([["retry-after", "60"]]))).toBe(false);
    expect(isCapacityError(forbidden(["x-ratelimit-remaining", "0"]))).toBe(false);
    expect(isCapacityError(forbidden([]))).toBe(false);
  });

  it("a_403_whose_retry_after_is_empty_or_unusable_stays_red", () => {
    // Present-but-empty is not "GitHub told us how long to wait". Only a
    // non-empty string or a number is that; a bare `true` or an object is
    // not a duration and must not stand in for one.
    expect(isCapacityError(forbidden({ "retry-after": "" }))).toBe(false);
    expect(isCapacityError(forbidden({ "retry-after": "   " }))).toBe(false);
    expect(isCapacityError(forbidden({ "retry-after": null }))).toBe(false);
    expect(isCapacityError(forbidden({ "retry-after": true }))).toBe(false);
    expect(isCapacityError(forbidden({ "retry-after": {} }))).toBe(false);
    expect(isCapacityError(forbidden({ "retry-after": Number.NaN }))).toBe(false);
    expect(isCapacityError(forbidden({ "retry-after": [60] }))).toBe(false);
  });

  it("a_403_whose_remaining_is_zero_shaped_but_not_zero_stays_red", () => {
    // Only the string "0" or the number 0 is exhaustion. Values that merely
    // coerce to zero — "", false, null, [], "0x0" — are not, because a
    // coercing test would turn every empty header into a green run.
    for (const value of ["", " ", false, null, [], [0], "0x0", "00", "-0"]) {
      expect(isCapacityError(forbidden({ "x-ratelimit-remaining": value }))).toBe(false);
    }
  });

  it("a_403_whose_rate_limit_headers_are_only_on_the_prototype_stays_red", () => {
    // Own enumerable keys only. A polluted `Object.prototype`, or a headers
    // object created over a poisoned parent, must not mint capacity for a
    // response that never carried the header.
    const inherited: unknown = Object.create({ "retry-after": "60", "x-ratelimit-remaining": "0" });
    expect(isCapacityError(forbidden(inherited))).toBe(false);
    expect(isCapacityError(forbidden(JSON.parse('{"__proto__":{"retry-after":"60"}}')))).toBe(
      false,
    );
  });

  it("a_403_whose_response_is_a_primitive_stays_red_without_throwing", () => {
    for (const response of ["nope", 403, true, undefined, null]) {
      const error = Object.assign(new Error("HTTP 403"), { status: 403, response });
      expect(() => isCapacityError(error)).not.toThrow();
      expect(isCapacityError(error)).toBe(false);
    }
  });

  it("a_403_whose_header_getter_throws_stays_red_without_throwing", () => {
    // `isCapacityError` is called from inside `catch` blocks at every one of
    // its call sites. A throw from here does not merely misclassify: it
    // REPLACES the original failure with this one, and the thing that
    // actually went wrong is lost. No input shape may throw.
    const headers = {
      get "retry-after"(): string {
        throw new Error("hostile getter");
      },
    };
    expect(() => isCapacityError(forbidden(headers))).not.toThrow();
    expect(isCapacityError(forbidden(headers))).toBe(false);
  });

  it("a_403_whose_unrelated_header_getter_throws_still_reads_the_rate_limit", () => {
    // Totality must not be bought by abandoning the whole record on the
    // first hostile key — the header that answers the question is still read.
    const headers = {
      get "x-github-request-id"(): string {
        throw new Error("hostile getter");
      },
      "retry-after": "60",
    };
    expect(() => isCapacityError(forbidden(headers))).not.toThrow();
    expect(isCapacityError(forbidden(headers))).toBe(true);
  });

  it("a_403_whose_headers_get_method_throws_stays_red_without_throwing", () => {
    const headers = {
      get(): string {
        throw new Error("hostile get");
      },
    };
    expect(() => isCapacityError(forbidden(headers))).not.toThrow();
    expect(isCapacityError(forbidden(headers))).toBe(false);
  });

  it("a_403_whose_headers_iterator_throws_stays_red_without_throwing", () => {
    const headers = {
      [Symbol.iterator]() {
        throw new Error("hostile iterator");
      },
    };
    expect(() => isCapacityError(forbidden(headers))).not.toThrow();
    expect(isCapacityError(forbidden(headers))).toBe(false);
  });

  it("a_403_whose_response_getter_throws_stays_red_without_throwing", () => {
    // Defined rather than assigned: `Object.assign` READS a source getter,
    // so the hostile property has to be installed on the error directly.
    const error = Object.assign(new Error("HTTP 403"), { status: 403 });
    Object.defineProperty(error, "response", {
      enumerable: true,
      get: () => {
        throw new Error("hostile response");
      },
    });
    expect(() => isCapacityError(error)).not.toThrow();
    expect(isCapacityError(error)).toBe(false);
  });

  it("a_403_whose_headers_getter_throws_stays_red_without_throwing", () => {
    const response = {
      status: 403,
      get headers(): unknown {
        throw new Error("hostile headers");
      },
    };
    const error = Object.assign(new Error("HTTP 403"), { status: 403, response });
    expect(() => isCapacityError(error)).not.toThrow();
    expect(isCapacityError(error)).toBe(false);
  });

  it("a_403_whose_retry_after_is_junk_a_gateway_invented_stays_red", () => {
    // A proxy, WAF or GHES gateway can put anything in `Retry-After` on its
    // own 403. Only a delta-seconds value is GitHub naming a wait; anything
    // else must not buy a green run plus a `starved` rotation.
    for (const value of ["unknown", "-5", "0x0", "1e3", "60s", "Infinity", "  "]) {
      expect(isCapacityError(forbidden({ "retry-after": value }))).toBe(false);
    }
    expect(isCapacityError(forbidden({ "retry-after": Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isCapacityError(forbidden({ "retry-after": -5 }))).toBe(false);
  });

  it("a_remaining_of_negative_zero_is_exhaustion_and_that_is_deliberate", () => {
    // `-0 === 0` is true, so the numeric branch already answers `true` here.
    // Asserted rather than left to chance: negative zero remaining IS a spent
    // quota, and pinning it stops a later `Object.is` "tidy-up" changing the
    // answer without anyone deciding to.
    expect(isCapacityError(forbidden({ "x-ratelimit-remaining": -0 }))).toBe(true);
    // The string form is matched exactly, so `"-0"` is not `"0"` and stays red.
    expect(isCapacityError(forbidden({ "x-ratelimit-remaining": "-0" }))).toBe(false);
  });

  it("a_403_with_rate_limit_headers_at_the_top_level_only_stays_red", () => {
    // The classifier reads `.response.headers`, which is where Octokit's
    // `RequestError` puts them. A caller that invented a top-level `headers`
    // is not evidence of anything GitHub said.
    const error = Object.assign(new Error("HTTP 403"), {
      status: 403,
      headers: { "retry-after": "60" },
    });
    expect(isCapacityError(error)).toBe(false);
  });
});

/**
 * Totality at the OUTERMOST boundary, not one layer in.
 *
 * The block above hardened the header lookup; three reviewers in a row then
 * found the same class one function further out. `isCapacityError` itself
 * reads `.status`, `.code`, `.name` and `.message`, and does an `instanceof`
 * and a `String()` — every one of those runs arbitrary user code when the
 * input is a `Proxy` or carries an accessor. It is called from inside twelve
 * `catch` blocks, so a throw does not merely misclassify: it REPLACES the
 * failure being classified and the real fault is lost.
 *
 * So the contract this block pins is the strongest one available and the
 * only one that ends the recursion: **no input, of any shape, makes
 * `isCapacityError` throw.** It always answers `true` or `false`.
 */
describe("isCapacityError — total for every input shape", () => {
  /** Every way an input can run code during classification, one entry each. */
  const HOSTILE: readonly (readonly [string, () => unknown])[] = [
    [
      "a proxy whose `has` trap throws",
      () =>
        new Proxy(
          {},
          {
            has: () => {
              throw new Error("has");
            },
          },
        ),
    ],
    [
      "a proxy whose `get` trap throws",
      () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("get");
            },
          },
        ),
    ],
    [
      "a proxy whose `getPrototypeOf` trap throws",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf: () => {
              throw new Error("getPrototypeOf");
            },
          },
        ),
    ],
    [
      "a proxy whose `ownKeys` trap throws",
      () =>
        new Proxy(
          { status: 403, response: { status: 403, headers: {} } },
          {
            ownKeys: () => {
              throw new Error("ownKeys");
            },
          },
        ),
    ],
    [
      "an object whose `status` getter throws",
      () => {
        const shape = {};
        Object.defineProperty(shape, "status", {
          enumerable: true,
          get: () => {
            throw new Error("status");
          },
        });
        return shape;
      },
    ],
    [
      "an object whose `code` getter throws",
      () => {
        const shape = {};
        Object.defineProperty(shape, "code", {
          enumerable: true,
          get: () => {
            throw new Error("code");
          },
        });
        return shape;
      },
    ],
    [
      "an Error whose `name` getter throws",
      () => {
        const error = new Error("boom");
        Object.defineProperty(error, "name", {
          get: () => {
            throw new Error("name");
          },
        });
        return error;
      },
    ],
    [
      "an Error whose `message` getter throws",
      () => {
        const error = new Error("boom");
        Object.defineProperty(error, "message", {
          get: () => {
            throw new Error("message");
          },
        });
        return error;
      },
    ],
    ["a null-prototype object, which cannot be stringified", () => Object.create(null) as unknown],
    [
      "an object whose `toString` throws",
      () => ({
        toString: () => {
          throw new Error("toString");
        },
      }),
    ],
    [
      "an object whose `Symbol.toPrimitive` throws",
      () => ({
        [Symbol.toPrimitive]: () => {
          throw new Error("toPrimitive");
        },
      }),
    ],
    [
      "a null-prototype object whose `valueOf` throws",
      () =>
        Object.assign(Object.create(null) as object, {
          valueOf: () => {
            throw new Error("valueOf");
          },
        }),
    ],
  ];

  for (const [what, build] of HOSTILE) {
    it(`answers rather than throws for ${what}`, () => {
      expect(() => isCapacityError(build())).not.toThrow();
      expect(typeof isCapacityError(build())).toBe("boolean");
    });
  }

  it("a_hostile_status_getter_does_not_blind_the_rest_of_the_classification", () => {
    // Totality is not bought by abandoning the input at the first hostile
    // read. A socket reset whose `.status` accessor throws is still a socket
    // reset, and the `.code` beside it still answers.
    const error = Object.assign(new Error("connect"), { code: "ECONNRESET" });
    Object.defineProperty(error, "status", {
      enumerable: true,
      get: () => {
        throw new Error("hostile status");
      },
    });
    expect(isCapacityError(error)).toBe(true);
  });

  it("a_hostile_message_getter_does_not_blind_an_answerable_status", () => {
    const error = Object.assign(new Error("boom"), { status: 503 });
    Object.defineProperty(error, "message", {
      get: () => {
        throw new Error("hostile message");
      },
    });
    expect(isCapacityError(error)).toBe(true);
  });
});

describe("isCapacityError — laundering paths that bypass the 403 narrowing", () => {
  /**
   * Runs `probe` with `Object.prototype[key]` set, and answers what it
   * returned — restoring the prototype first, always.
   *
   * The result is returned rather than asserted inside the window on
   * purpose. Polluting `Object.prototype.get` breaks `Object.defineProperty`
   * process-wide (a descriptor is a plain object, so `descriptor.get` starts
   * resolving to the polluted function), which is enough to take the test
   * runner itself down mid-assertion. Nothing but the classifier runs while
   * the prototype is dirty.
   */
  function whilePolluted<T>(key: PropertyKey, value: unknown, probe: () => T): T {
    Object.defineProperty(Object.prototype, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      return probe();
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
  }

  it("a_polluted_object_prototype_get_cannot_mint_a_rate_limit", () => {
    // The `Headers`-like strategy probes `.get` through the prototype chain,
    // because a real `Headers` carries `get` on `Headers.prototype` and not
    // as an own key. That reach is exactly what a polluted `Object.prototype`
    // exploits: every plain header record suddenly answers "60", and every
    // 403 in the process turns green.
    const answer = whilePolluted(
      "get",
      (name: string) => (name === "retry-after" ? "60" : null),
      () => isCapacityError({ status: 403, response: { status: 403, headers: {} } }),
    );
    expect(answer).toBe(false);
  });

  it("a_polluted_object_prototype_iterator_cannot_mint_a_rate_limit", () => {
    const answer = whilePolluted(
      Symbol.iterator,
      function* (): Generator<readonly [string, string]> {
        yield ["retry-after", "60"];
      },
      () => isCapacityError({ status: 403, response: { status: 403, headers: {} } }),
    );
    expect(answer).toBe(false);
  });

  it("a_genuine_headers_instance_still_answers_while_the_prototype_is_polluted", () => {
    // The closure must exclude `Object.prototype`'s own copy, not the reach
    // itself — a real `Headers` has to keep working.
    const real = new Headers({ "retry-after": "60" });
    const plain = { status: 403, response: { status: 403, headers: {} } };
    const answers = whilePolluted(
      "get",
      () => "60",
      () => [
        isCapacityError({ status: 403, response: { status: 403, headers: real } }),
        isCapacityError(plain),
      ],
    );
    expect(answers).toEqual([true, false]);
  });

  it("a_401_whose_message_says_timed_out_is_still_credentials", () => {
    // The message fallback reads TEXT. Text is not evidence about the cause
    // when the status already is one: this is the same laundering the header
    // narrowing refuses, arriving by the other door.
    expect(isCapacityError(Object.assign(new Error("request timed out"), { status: 401 }))).toBe(
      false,
    );
  });

  it("a_403_whose_message_says_timed_out_is_still_a_permission_error", () => {
    expect(isCapacityError(Object.assign(new Error("request timed out"), { status: 403 }))).toBe(
      false,
    );
  });

  it("an_auth_status_named_TimeoutError_is_still_not_capacity", () => {
    const error = Object.assign(new Error("Bad credentials"), { status: 403 });
    error.name = "TimeoutError";
    expect(isCapacityError(error)).toBe(false);
  });

  it("a_statusless_or_non_auth_timeout_is_unaffected_by_that_gate", () => {
    // The gate is 401/403 only. Nothing else about the message fallback moves.
    expect(isCapacityError(new Error("request timed out"))).toBe(true);
    expect(isCapacityError(Object.assign(new Error("request timed out"), { status: 404 }))).toBe(
      true,
    );
    expect(isCapacityError("timed out")).toBe(true);
  });

  it("a_rate_limit_403_is_still_capacity_through_the_header_path", () => {
    // The gate must not undo the fix it sits beside.
    expect(
      isCapacityError({
        status: 403,
        response: { status: 403, headers: { "retry-after": "60" } },
      }),
    ).toBe(true);
  });
});
