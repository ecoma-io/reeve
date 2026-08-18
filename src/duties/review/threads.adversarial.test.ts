/**
 * Adversarial coverage for the inline-thread boundary: the places a GitHub
 * failure could be swallowed, a write could be duplicated, or a rerun could
 * stack a second copy of a thread this duty already owns.
 *
 * The brief every case here answers is "how do I make this boundary write
 * twice, or make it lie about what it wrote, while the existing suite stays
 * green". Three of them succeeded against the code as it stood and are marked
 * REGRESSION; the rest pin the semantics the module already keeps so a later
 * change cannot quietly relax them.
 *
 * Style follows `threads.test.ts`: a hand-built structural stub, no mocking
 * library, and the stub's `comments` array is the live listing — a create
 * pushes into it, so a second `syncThreads` against the same stub is a real
 * rerun against what the first run left behind.
 */
import { describe, expect, it } from "vitest";

import type { Author } from "../../core/forge.js";
import type { DiffStanding, Finding } from "./findings.js";
import { findingFingerprint } from "./findings.js";
import type { ReviewThreadApi } from "./threads.js";
import {
  dryRunThreads,
  listOwnedThreads,
  planThreads,
  syncThreads,
  threadBody,
} from "./threads.js";

const AT = { owner: "o", repo: "r", number: 7 };
const SHA = "1111111111111111111111111111111111111111";
const MARKER = "<!-- reeve:review:thread source=";
const BOT: Author = { login: "reeve[bot]", type: "Bot" };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "id",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "a.ts",
    line: 12,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    ...overrides,
  };
}

function standing(overrides: Partial<DiffStanding> = {}): DiffStanding {
  return { files: new Map([["a.ts", new Set([11, 12])]]), headSha: SHA, ...overrides };
}

function keyOf(f: Finding): string {
  return `${f.ruleId}|${f.path}|${f.line === null ? "" : String(f.line)}`;
}

function markerBody(f: Finding): string {
  return `${MARKER}${findingFingerprint(f)}.${keyOf(f)} -->`;
}

interface Listed {
  id: number;
  body: string;
  path?: string;
  line: number | null;
  user?: Author | null;
}

interface Stub {
  api: ReviewThreadApi;
  comments: { id: number; body: string; path: string; line: number | null; user: Author }[];
  pages: number;
  fail: {
    list?: () => Promise<never>;
    create?: () => Promise<never>;
    update?: () => Promise<never>;
  };
}

/** The same structural stub `threads.test.ts` builds, plus a page counter. */
function stubOf(threads: Listed[] = []): Stub {
  const comments: Stub["comments"] = threads.map((entry) => ({
    id: entry.id,
    body: entry.body,
    path: entry.path ?? "a.ts",
    line: entry.line,
    user: entry.user ?? BOT,
  }));
  let nextId = Math.max(0, ...comments.map((c) => c.id)) + 1;
  const state = { pages: 0 };
  const fail: Stub["fail"] = {};

  const base = {
    listReviewComments: (params: { per_page?: number; page?: number }) => {
      state.pages += 1;
      const per = params.per_page ?? 100;
      const page = params.page ?? 1;
      return Promise.resolve({
        data: comments
          .slice((page - 1) * per, page * per)
          .map(({ id, body, path, line, user }) => ({ id, body, path, line, user })),
      });
    },
    createReviewComment: (params: { body?: string; path?: string; line?: number }) => {
      comments.push({
        id: nextId,
        body: params.body ?? "",
        path: params.path ?? "a.ts",
        line: params.line ?? null,
        user: BOT,
      });
      nextId += 1;
      return Promise.resolve({});
    },
    updateReviewComment: (params: { comment_id: number; body?: string }) => {
      const found = comments.find((entry) => entry.id === params.comment_id);
      if (found) found.body = params.body ?? "";
      return Promise.resolve({});
    },
  };

  return {
    api: {
      rest: {
        pulls: {
          listReviewComments: (params) =>
            fail.list !== undefined ? fail.list() : base.listReviewComments(params),
          createReviewComment: (params) =>
            fail.create !== undefined ? fail.create() : base.createReviewComment(params),
          updateReviewComment: (params) =>
            fail.update !== undefined ? fail.update() : base.updateReviewComment(params),
        },
      },
    },
    comments,
    get pages() {
      return state.pages;
    },
    fail,
  };
}

/** A listing of `count` comments this duty does not own — filler for the page walk. */
function filler(count: number, from = 1000): Listed[] {
  return Array.from({ length: count }, (_, i) => ({
    id: from + i,
    body: "someone else's review comment",
    line: 1,
  }));
}

const status = (code: number): Error =>
  Object.assign(new Error(`HTTP ${String(code)}`), { status: code });

describe("syncThreads — duplicate-write hunting", () => {
  it("rerun_updates_its_own_thread_instead_of_duplicating", async () => {
    // REGRESSION. GitHub answers an OUTDATED review comment with `line: null`
    // while the comment (and so the thread marker's position key) still names
    // the line it was written at. `planThreads` matched the owned thread by
    // key, saw `line: null !== 12`, and planned a create — every single run,
    // for ever, because the next listing still returned the outdated thread
    // first. The module's own contract is "a rerun never stacks a second
    // copy" (`threads.ts` module doc) and "an owned thread whose body already
    // renders the same is left alone" (`planThreads`).
    const f = finding({ id: "mine" });
    const stub = stubOf([{ id: 5, body: threadBody(f), line: 12, path: "a.ts" }]);
    const entry = [{ finding: f, status: "created" }];

    // GitHub outdates the thread: same body, same marker key, no live line.
    const outdated = stub.comments[0];
    expect(outdated).toBeDefined();
    if (outdated !== undefined) outdated.line = null;

    const first = await syncThreads(stub.api, AT, entry, standing(), SHA);
    expect(first.created).toBe(1);
    expect(stub.comments).toHaveLength(2);

    // The rerun sees the thread it just wrote, at the line the diff proves,
    // with the identical body — and must leave it alone.
    const second = await syncThreads(stub.api, AT, entry, standing(), SHA);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(stub.comments).toHaveLength(2);

    // A third run must not grow it either: the count is bounded, not merely
    // slower to grow.
    await syncThreads(stub.api, AT, entry, standing(), SHA);
    expect(stub.comments).toHaveLength(2);
  });

  it("uncertain_listing_withholds_thread_writes_instead_of_duplicating", async () => {
    // REGRESSION. `listOwnedThreads` reports `uncertain` when the walk ended
    // at a full page with nothing owned — "so the caller can withhold writes
    // instead of risking a copy" (`listOwnedThreads` doc). `syncThreads` read
    // the flag, passed it through, and wrote anyway; `main.ts` then warned
    // "so none were written this run", which was false. The sibling summary
    // boundary already withholds on exactly this signal
    // (`publish.ts`'s `classify`: `existing === null && uncertain` → withheld).
    const stub = stubOf(filler(1000));
    const out = await syncThreads(
      stub.api,
      AT,
      [{ finding: finding(), status: "created" }],
      standing(),
      SHA,
    );
    expect(out.uncertain).toBe(true);
    expect(out.created).toBe(0);
    expect(out.updated).toBe(0);
    expect(stub.comments).toHaveLength(1000);
  });

  it("dry_run_reports_no_thread_writes_when_the_listing_is_uncertain", async () => {
    // The rehearsal must rehearse the run that would actually happen. A
    // dry-run promising a create the real run withholds is a rehearsal of a
    // different run.
    const stub = stubOf(filler(1000));
    const out = await dryRunThreads(
      stub.api,
      AT,
      [{ finding: finding(), status: "created" }],
      standing(),
    );
    expect(out.uncertain).toBe(true);
    expect(out.created).toBe(0);
    expect(out.updated).toBe(0);
  });

  it("a_listing_that_grows_under_the_walk_still_writes_each_thread_once", async () => {
    // A page that changes under you: the second page is served after the
    // first, and by then a thread this duty owns has appeared on it. The walk
    // must find it and leave it alone rather than create a second copy.
    const f = finding({ id: "mine" });
    const stub = stubOf(filler(100));
    let served = 0;
    const inner = stub.api.rest.pulls.listReviewComments;
    const api: ReviewThreadApi = {
      rest: {
        pulls: {
          ...stub.api.rest.pulls,
          listReviewComments: (params) => {
            served += 1;
            if (served === 1) {
              stub.comments.push({
                id: 42,
                body: threadBody(f),
                path: "a.ts",
                line: 12,
                user: BOT,
              });
            }
            return inner(params);
          },
        },
      },
    };
    const out = await syncThreads(api, AT, [{ finding: f, status: "created" }], standing(), SHA);
    expect(out.created).toBe(0);
    expect(out.updated).toBe(0);
    expect(stub.comments).toHaveLength(101);
  });
});

describe("syncThreads — GitHub failure semantics", () => {
  // Exactly one defined semantic per status: 422 → fallback, every other
  // status → fail. Nothing here may be a swallowed error or a silent skip.
  for (const code of [401, 403, 404, 409, 429, 500, 502, 503]) {
    it(`create_${String(code)}_fails_the_run_rather_than_falling_back`, async () => {
      const stub = stubOf([]);
      stub.fail.create = () => Promise.reject(status(code));
      await expect(
        syncThreads(stub.api, AT, [{ finding: finding(), status: "created" }], standing(), SHA),
      ).rejects.toMatchObject({ status: code });
    });

    it(`update_${String(code)}_fails_the_run_rather_than_falling_back`, async () => {
      const f = finding({ id: "mine" });
      const stub = stubOf([{ id: 5, body: markerBody(f), line: 12, path: "a.ts" }]);
      stub.fail.update = () => Promise.reject(status(code));
      await expect(
        syncThreads(stub.api, AT, [{ finding: f, status: "created" }], standing(), SHA),
      ).rejects.toMatchObject({ status: code });
    });

    it(`list_${String(code)}_fails_before_any_write_is_attempted`, async () => {
      const stub = stubOf([]);
      stub.fail.list = () => Promise.reject(status(code));
      await expect(
        syncThreads(stub.api, AT, [{ finding: finding(), status: "created" }], standing(), SHA),
      ).rejects.toMatchObject({ status: code });
      expect(stub.comments).toHaveLength(0);
    });
  }

  it("a_timeout_with_no_status_fails_the_run", async () => {
    const stub = stubOf([]);
    const timeout = new Error("Request timed out");
    timeout.name = "TimeoutError";
    stub.fail.create = () => Promise.reject(timeout);
    await expect(
      syncThreads(stub.api, AT, [{ finding: finding(), status: "created" }], standing(), SHA),
    ).rejects.toThrow("Request timed out");
  });

  it("a_non_422_failure_aborts_the_remaining_creates_rather_than_continuing", async () => {
    // No rollback anywhere is the documented posture (`failure-matrix.md`), so
    // what has to be pinned is that the loop does not carry on writing after a
    // failure it did not classify.
    const stub = stubOf([]);
    let attempts = 0;
    stub.fail.create = () => {
      attempts += 1;
      return Promise.reject(status(403));
    };
    await expect(
      syncThreads(
        stub.api,
        AT,
        [
          { finding: finding({ id: "one", line: 11 }), status: "created" },
          { finding: finding({ id: "two", line: 12 }), status: "created" },
        ],
        standing(),
        SHA,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(1);
  });

  it("a_422_on_the_first_create_still_lets_the_second_finding_be_written", async () => {
    // 422 is the one status with a defined non-fatal semantic: the finding
    // falls back to the summary and the sync carries on.
    const stub = stubOf([]);
    let attempts = 0;
    const inner = stub.api.rest.pulls.createReviewComment;
    const api: ReviewThreadApi = {
      rest: {
        pulls: {
          ...stub.api.rest.pulls,
          createReviewComment: (params) => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(status(422));
            return inner(params);
          },
        },
      },
    };
    const out = await syncThreads(
      api,
      AT,
      [
        { finding: finding({ id: "one", line: 11 }), status: "created" },
        { finding: finding({ id: "two", line: 12 }), status: "created" },
      ],
      standing(),
      SHA,
    );
    expect(out.created).toBe(1);
    expect(out.fallback).toEqual([keyOf(finding({ line: 11 }))]);
    expect(stub.comments).toHaveLength(1);
  });

  it("a_rejection_that_is_not_an_object_still_reaches_the_caller_unmasked", async () => {
    // ADJUDICATE: `isUnprocessable` reads `.status` off the rejection value
    // directly. A rejection of `null`/`undefined` used to make the catch block
    // itself throw a TypeError, replacing the real failure with a confusing
    // one. The value a boundary failed with must reach the caller as it was.
    const stub = stubOf([]);
    stub.fail.create = () => Promise.reject(new Error("string-shaped failure"));
    await expect(
      syncThreads(stub.api, AT, [{ finding: finding(), status: "created" }], standing(), SHA),
    ).rejects.toThrow("string-shaped failure");

    const nullish = stubOf([]);
    // The point of the case is a rejection value that is not an Error at all —
    // the shape the classifier used to raise a TypeError on. Thrown rather than
    // rejected-with, because a `Promise.reject(null)` is exactly what the lint
    // rule exists to stop people writing on purpose; an async function that
    // throws produces the identical rejection.
    // eslint-disable-next-line @typescript-eslint/require-await -- the throw is the whole body
    nullish.fail.create = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error rejection is the case under test
      throw null;
    };
    await expect(
      syncThreads(nullish.api, AT, [{ finding: finding(), status: "created" }], standing(), SHA),
    ).rejects.toBeNull();
  });
});

describe("listOwnedThreads — pagination boundaries", () => {
  it("an_empty_first_page_is_one_request_and_no_owned_thread", async () => {
    const stub = stubOf([]);
    const out = await listOwnedThreads(stub.api, AT);
    expect(out).toEqual({ threads: [], uncertain: false });
    expect(stub.pages).toBe(1);
  });

  it("exactly_one_full_page_walks_a_second_page_before_concluding", async () => {
    // A full page is never assumed to be the end — the whole anti-duplicate
    // guard is that a thread behind a hundred unrelated comments is found.
    const stub = stubOf(filler(100));
    const out = await listOwnedThreads(stub.api, AT);
    expect(out.threads).toEqual([]);
    expect(out.uncertain).toBe(false);
    expect(stub.pages).toBe(2);
  });

  it("the_walk_stops_at_ten_pages_and_says_so", async () => {
    const stub = stubOf(filler(1500));
    const out = await listOwnedThreads(stub.api, AT);
    expect(stub.pages).toBe(10);
    expect(out.uncertain).toBe(true);
  });

  it("a_truncated_short_page_ends_the_walk_without_claiming_uncertainty", async () => {
    const stub = stubOf(filler(150));
    const out = await listOwnedThreads(stub.api, AT);
    expect(stub.pages).toBe(2);
    expect(out.uncertain).toBe(false);
  });
});

describe("planThreads — ownership cannot be forged", () => {
  it("a_human_authored_body_carrying_a_valid_marker_is_never_updated", async () => {
    const f = finding({ id: "mine" });
    const stub = stubOf([
      {
        id: 5,
        body: threadBody(f),
        line: 12,
        path: "a.ts",
        user: { login: "mallory", type: "User" },
      },
    ]);
    const listed = await listOwnedThreads(stub.api, AT);
    expect(listed.threads).toEqual([]);
    const plan = planThreads([{ finding: f, status: "created" }], standing(), listed.threads);
    // Not adopted, and not updated: the duty writes its own thread instead.
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toHaveLength(1);
  });

  it("a_marker_whose_fingerprint_is_not_sixteen_hex_is_not_owned", async () => {
    const forged = `${MARKER}not-a-fingerprint.dedup|a.ts|12 -->`;
    const stub = stubOf([{ id: 5, body: forged, line: 12, path: "a.ts" }]);
    expect((await listOwnedThreads(stub.api, AT)).threads).toEqual([]);
  });
});
