import { describe, expect, it } from "vitest";

import type { Author } from "../../core/forge.js";
import type { DiffStanding, Finding } from "./findings.js";
import { findingFingerprint } from "./findings.js";
import type { ReviewThreadApi } from "./threads.js";
import {
  anchorable,
  dryRunThreads,
  listOwnedThreads,
  planThreads,
  syncThreads,
  threadBody,
} from "./threads.js";

const AT = { owner: "o", repo: "r", number: 7 };
const SHA = "1111111111111111111111111111111111111111";

/** The thread marker's literal opener — documented in PR 04's architecture. */
const MARKER = "<!-- reeve:review:thread source=";

const BOT: Author = { login: "reeve[bot]", type: "Bot" };
const HUMAN: Author = { login: "octocat", type: "User" };

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

/** A diff standing where `a.ts` proves lines 11 and 12, and `gone.ts` is skipped. */
function standing(overrides: Partial<DiffStanding> = {}): DiffStanding {
  return {
    files: new Map([
      ["a.ts", new Set([11, 12])],
      ["gone.ts", null],
    ]),
    headSha: SHA,
    ...overrides,
  };
}

/** The position-based thread key: `ruleId|path|line`. */
function keyOf(f: Finding): string {
  return `${f.ruleId}|${f.path}|${f.line === null ? "" : String(f.line)}`;
}

/** The thread-marker payload: `<fingerprint>.<key>`. */
function payloadOf(f: Finding): string {
  return `${findingFingerprint(f)}.${keyOf(f)}`;
}

/** A bot-authored thread body carrying only the marker (as a stale listing would). */
function markerBody(f: Finding): string {
  return `${MARKER}${payloadOf(f)} -->`;
}

interface Owned {
  readonly id: number;
  readonly key: string;
  readonly path: string;
  readonly line: number | null;
  /** The thread's body — the idempotency comparison: a matching body means no write. */
  readonly body: string;
}

interface ListedComment {
  id: number;
  body: string;
  path?: string;
  line: number | null;
  user?: Author | null;
}

interface ThreadStub {
  api: ReviewThreadApi;
  comments: { id: number; body: string; path: string; line: number | null; user: Author }[];
  calls: { page?: number; per_page?: number }[];
  creates: number;
  updates: number;
  createBodies: string[];
  updateBodies: string[];
  /** Injected failures, keyed by the endpoint they replace. */
  fail: {
    list?: () => Promise<never>;
    create?: () => Promise<never>;
    update?: () => Promise<never>;
  };
}

/** A hand-built review-thread API — the structured-stub style publish.test.ts uses, no mock library. */
function stubOf(threads: ListedComment[] = []): ThreadStub {
  const comments: ThreadStub["comments"] = threads.map((entry) => ({
    id: entry.id,
    body: entry.body,
    path: entry.path ?? "a.ts",
    line: entry.line,
    user: entry.user ?? BOT,
  }));
  let nextId = Math.max(0, ...comments.map((c) => c.id)) + 1;
  const calls: { page?: number; per_page?: number }[] = [];
  const state = { creates: 0, updates: 0 };
  const bodies = { createBodies: [] as string[], updateBodies: [] as string[] };
  const fail: ThreadStub["fail"] = {};

  const base = {
    listReviewComments: (params: { per_page?: number; page?: number }) => {
      calls.push({ page: params.page, per_page: params.per_page });
      const per = params.per_page ?? 100;
      const page = params.page ?? 1;
      return Promise.resolve({
        data: comments
          .slice((page - 1) * per, page * per)
          .map(({ id, body, path, line, user }) => ({ id, body, path, line, user })),
      });
    },
    createReviewComment: (params: { body?: string; path?: string; line?: number }) => {
      state.creates += 1;
      bodies.createBodies.push(params.body ?? "");
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
      state.updates += 1;
      bodies.updateBodies.push(params.body ?? "");
      const found = comments.find((entry) => entry.id === params.comment_id);
      if (found) found.body = params.body ?? "";
      return Promise.resolve({});
    },
  };

  const api: ReviewThreadApi = {
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
  };

  return {
    api,
    comments,
    calls,
    // Live counters, not snapshots: `...state` at return time would copy the
    // numbers and every `creates`/`updates` assertion would read a stale 0.
    get creates() {
      return state.creates;
    },
    get updates() {
      return state.updates;
    },
    ...bodies,
    fail,
  };
}

/** The `owned` argument `planThreads` wants, shaped from a fresh listing. */
function owned(out: Awaited<ReturnType<typeof listOwnedThreads>>): Owned[] {
  return out.threads.map((t) => ({
    id: t.id,
    key: t.key,
    path: t.path,
    line: t.line,
    body: t.body,
  }));
}

describe("anchorable", () => {
  it("is false for a finding with no line", () => {
    expect(anchorable({ finding: finding({ line: null }), status: "created" }, standing())).toBe(
      false,
    );
  });

  it("is false for a resolved finding, proven line or not", () => {
    expect(anchorable({ finding: finding(), status: "resolved" }, standing())).toBe(false);
  });

  it("is false when the standing diff does not prove the line", () => {
    expect(anchorable({ finding: finding({ line: 99 }), status: "created" }, standing())).toBe(
      false,
    );
  });

  it("is false when the file is not in the standing diff", () => {
    expect(
      anchorable({ finding: finding({ path: "absent.ts" }), status: "created" }, standing()),
    ).toBe(false);
  });

  it("is true for a non-resolved finding on a line the diff proves", () => {
    expect(anchorable({ finding: finding(), status: "created" }, standing())).toBe(true);
    expect(anchorable({ finding: finding(), status: "persists" }, standing())).toBe(true);
    expect(anchorable({ finding: finding(), status: "changed" }, standing())).toBe(true);
  });
});

describe("threadBody", () => {
  it("carries the finding line, the thread marker, and the machine notice", () => {
    const body = threadBody(finding());
    expect(body).toContain("`a.ts`");
    expect(body).toContain("Repeated.");
    expect(body).toContain(MARKER);
    expect(body).toContain("model");
  });

  it("rides a marker whose payload opens with the finding's fingerprint and closes", () => {
    const body = threadBody(finding());
    expect(body).toContain(`${MARKER}${payloadOf(finding())} -->`);
  });

  it("caps the body at 8000 characters even for a 50k finding body", () => {
    const body = threadBody(finding({ body: "x".repeat(50_000) }));
    expect(body.length).toBeLessThanOrEqual(8000);
    expect(body).toContain("x".repeat(7000));
  });
});

describe("listOwnedThreads", () => {
  it("owns nothing when no thread carries a marker", async () => {
    const { api } = stubOf([{ id: 1, body: "human prose", line: 12, user: BOT }]);
    const out = await listOwnedThreads(api, AT);
    expect(out.threads).toEqual([]);
    expect(out.uncertain).toBe(false);
  });

  it("does not own a forged marker whose fingerprint is not 16 hex", async () => {
    const { api } = stubOf([{ id: 1, body: `${MARKER}not-hex.key -->`, line: 12, user: BOT }]);
    expect((await listOwnedThreads(api, AT)).threads).toEqual([]);
  });

  it("does not own a marker with no ` -->` closer even when the fingerprint is valid", async () => {
    const f = finding();
    const { api } = stubOf([{ id: 1, body: `${MARKER}${payloadOf(f)}`, line: 12, user: BOT }]);
    expect((await listOwnedThreads(api, AT)).threads).toEqual([]);
  });

  it("does not own a marker with an empty key remainder", async () => {
    const { api } = stubOf([
      { id: 1, body: `${MARKER}deadbeefdeadbeef. -->`, line: 12, user: BOT },
    ]);
    expect((await listOwnedThreads(api, AT)).threads).toEqual([]);
  });

  it("does not own a human-authored thread, marker or not", async () => {
    const f = finding();
    const { api } = stubOf([{ id: 1, body: markerBody(f), line: 12, user: HUMAN }]);
    expect((await listOwnedThreads(api, AT)).threads).toEqual([]);
  });

  it("owns a bot-authored thread with a valid marker, reporting key, path and line", async () => {
    const f = finding();
    const { api } = stubOf([{ id: 1, body: markerBody(f), line: 12, path: "a.ts" }]);
    const out = await listOwnedThreads(api, AT);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0]).toMatchObject({
      id: 1,
      key: keyOf(f),
      path: "a.ts",
      line: 12,
    });
    expect(out.uncertain).toBe(false);
  });

  it("walks to page 2 when the first page is a full 100 and the owned thread is there", async () => {
    const comments: ListedComment[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: "noise",
      line: 1,
      user: BOT,
    }));
    comments.push({ id: 101, body: markerBody(finding()), line: 12, path: "a.ts" });
    const { api, calls } = stubOf(comments);
    const out = await listOwnedThreads(api, AT);
    expect(calls.map((c) => c.page)).toEqual([1, 2]);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0]?.id).toBe(101);
    expect(out.uncertain).toBe(false);
  });

  it("reports uncertain when every page is a full 100 and no owned thread is ever found", async () => {
    // 1000 comments is exactly ten full pages — the walk's bound. It ends
    // never having seen a short page, so the listing cannot prove it saw every
    // thread, and a write could duplicate one it missed: withhold instead.
    const comments: ListedComment[] = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      body: "noise",
      line: 1,
      user: BOT,
    }));
    const { api, calls } = stubOf(comments);
    const out = await listOwnedThreads(api, AT);
    expect(calls).toHaveLength(10);
    expect(out.threads).toEqual([]);
    expect(out.uncertain).toBe(true);
  });
});

describe("planThreads", () => {
  it("creates one thread per anchorable finding against an empty listing", () => {
    const plan = planThreads([{ finding: finding(), status: "created" }], standing(), []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ key: keyOf(finding()), finding: finding() });
    expect(plan.updates).toEqual([]);
    expect(plan.fallback).toEqual([]);
  });

  it("collapses two findings at the same key into one thread — the first wins", () => {
    const first = finding({ id: "first", ruleId: "r", body: "First." });
    const second = finding({ id: "second", ruleId: "r", body: "Second." });
    const plan = planThreads(
      [
        { finding: first, status: "created" },
        { finding: second, status: "created" },
      ],
      standing(),
      [],
    );
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ key: keyOf(first) });
    expect(plan.fallback).toEqual([]);
  });

  it("updates an owned thread at the same key when the rendered body moved", async () => {
    const f = finding({ id: "mine" });
    const { api } = stubOf([{ id: 5, body: markerBody(f), line: 12, path: "a.ts" }]);
    const plan = planThreads(
      [{ finding: f, status: "created" }],
      standing(),
      owned(await listOwnedThreads(api, AT)),
    );
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ id: 5, finding: f });
  });

  it("plans no write for an owned thread whose body already matches — idempotency", async () => {
    const f = finding({ id: "mine" });
    const { api } = stubOf([{ id: 5, body: threadBody(f), line: 12, path: "a.ts" }]);
    const plan = planThreads(
      [{ finding: f, status: "created" }],
      standing(),
      owned(await listOwnedThreads(api, AT)),
    );
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.fallback).toEqual([]);
  });

  it("creates at the finding's new position instead of updating the owned thread at the old one", async () => {
    const { api } = stubOf([
      { id: 5, body: markerBody(finding({ line: 13 })), line: 13, path: "a.ts" },
    ]);
    const moved = finding({ id: "moved", line: 14 });
    const diff = standing({ files: new Map([["a.ts", new Set([14])]]) });
    const plan = planThreads(
      [{ finding: moved, status: "created" }],
      diff,
      owned(await listOwnedThreads(api, AT)),
    );
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ key: keyOf(moved) });
    // The old thread is left for GitHub to mark outdated, never updated.
    expect(plan.updates).toEqual([]);
  });

  it("never creates, nor touches an existing thread, for an unanchorable finding", async () => {
    const f = finding({ id: "mine" });
    const { api } = stubOf([{ id: 5, body: markerBody(f), line: 12, path: "a.ts" }]);
    const owned = (await listOwnedThreads(api, AT)).threads.map((t) => ({
      id: t.id,
      key: t.key,
      path: t.path,
      line: t.line,
      body: t.body,
    }));
    const nullLine = planThreads(
      [{ finding: finding({ id: "whole-file", line: null }), status: "created" }],
      standing(),
      owned,
    );
    expect(nullLine.creates).toEqual([]);
    expect(nullLine.updates).toEqual([]);

    const resolved = planThreads([{ finding: f, status: "resolved" }], standing(), owned);
    expect(resolved.creates).toEqual([]);
    expect(resolved.updates).toEqual([]);

    const unproven = planThreads(
      [{ finding: finding({ id: "unproven", line: 99 }), status: "created" }],
      standing(),
      owned,
    );
    expect(unproven.creates).toEqual([]);
    expect(unproven.updates).toEqual([]);
  });

  it("leaves a stray owned thread whose key matches no current finding untouched", async () => {
    const stray = markerBody(finding({ id: "stray", line: 13 }));
    const { api } = stubOf([{ id: 5, body: stray, line: 13, path: "a.ts" }]);
    const o = owned(await listOwnedThreads(api, AT));
    const plan = planThreads([{ finding: finding(), status: "created" }], standing(), o);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ key: keyOf(finding()) });
    expect(plan.updates).toEqual([]);
  });
});

describe("syncThreads", () => {
  it("writes the surviving create plan once", async () => {
    const { api, comments } = stubOf([]);
    const out = await syncThreads(
      api,
      AT,
      [{ finding: finding(), status: "created" }],
      standing(),
      SHA,
    );
    expect(out.created).toBe(1);
    expect(out.updated).toBe(0);
    expect(out.fallback).toEqual([]);
    expect(out.uncertain).toBe(false);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(MARKER);
  });

  it("writes the surviving update plan once", async () => {
    const f = finding({ id: "mine" });
    const { api, comments } = stubOf([{ id: 5, body: markerBody(f), line: 12, path: "a.ts" }]);
    const out = await syncThreads(api, AT, [{ finding: f, status: "created" }], standing(), SHA);
    expect(out.created).toBe(0);
    expect(out.updated).toBe(1);
    expect(out.fallback).toEqual([]);
    expect(out.uncertain).toBe(false);
    expect(comments[0]?.body).toContain(MARKER);
  });

  it("writes nothing on a rerun whose owned threads already match — the anti-duplicate guard", async () => {
    const f = finding({ id: "mine" });
    const { api, comments } = stubOf([{ id: 5, body: threadBody(f), line: 12, path: "a.ts" }]);
    const out = await syncThreads(api, AT, [{ finding: f, status: "created" }], standing(), SHA);
    expect(out.created).toBe(0);
    expect(out.updated).toBe(0);
    expect(comments).toHaveLength(1);
  });

  it("sends a 422-failing finding to the fallback list instead of throwing", async () => {
    const { api, fail } = stubOf([]);
    fail.create = () => Promise.reject(Object.assign(new Error("Unprocessable"), { status: 422 }));
    const out = await syncThreads(
      api,
      AT,
      [{ finding: finding(), status: "created" }],
      standing(),
      SHA,
    );
    expect(out.created).toBe(0);
    expect(out.fallback).toEqual([keyOf(finding())]);
  });

  it("sends a 422-failing update to the fallback list instead of throwing", async () => {
    const f = finding({ id: "mine" });
    const { api, fail } = stubOf([{ id: 5, body: markerBody(f), line: 12, path: "a.ts" }]);
    fail.update = () => Promise.reject(Object.assign(new Error("Unprocessable"), { status: 422 }));
    const out = await syncThreads(api, AT, [{ finding: f, status: "created" }], standing(), SHA);
    expect(out.updated).toBe(0);
    expect(out.fallback).toEqual([keyOf(f)]);
  });

  it.each([403, 401, 404, 500])("throws on HTTP %d from create", async (status) => {
    const { api, fail } = stubOf([]);
    fail.create = () => Promise.reject(Object.assign(new Error(String(status)), { status }));
    await expect(
      syncThreads(api, AT, [{ finding: finding(), status: "created" }], standing(), SHA),
    ).rejects.toMatchObject({ status });
  });

  it.each([403, 401, 404, 500])("throws on HTTP %d from update", async (status) => {
    const f = finding({ id: "mine" });
    const { api, fail } = stubOf([{ id: 5, body: markerBody(f), line: 12, path: "a.ts" }]);
    fail.update = () => Promise.reject(Object.assign(new Error(String(status)), { status }));
    await expect(
      syncThreads(api, AT, [{ finding: f, status: "created" }], standing(), SHA),
    ).rejects.toMatchObject({ status });
  });
});

describe("dryRunThreads", () => {
  it("reports a create without writing anything", async () => {
    const { api, comments, creates, updates } = stubOf([]);
    const out = await dryRunThreads(
      api,
      AT,
      [{ finding: finding(), status: "created" }],
      standing(),
    );
    expect(out.created).toBe(1);
    expect(out.updated).toBe(0);
    expect(out.fallback).toEqual([]);
    expect(out.uncertain).toBe(false);
    expect(creates).toBe(0);
    expect(updates).toBe(0);
    expect(comments).toHaveLength(0);
  });

  it("reports an update without writing anything", async () => {
    const f = finding({ id: "mine" });
    const { api, comments, creates, updates } = stubOf([
      { id: 5, body: markerBody(f), line: 12, path: "a.ts" },
    ]);
    const out = await dryRunThreads(api, AT, [{ finding: f, status: "created" }], standing());
    expect(out.created).toBe(0);
    expect(out.updated).toBe(1);
    expect(creates).toBe(0);
    expect(updates).toBe(0);
    expect(comments[0]?.body).toBe(markerBody(f));
  });
});
