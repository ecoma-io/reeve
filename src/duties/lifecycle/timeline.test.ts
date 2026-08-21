import { describe, expect, it } from "vitest";

import {
  isDraftPr,
  readComments,
  readEvents,
  resolveOwnLogin,
  type LifecycleApi,
} from "./timeline.js";

function apiWith(
  over: Partial<LifecycleApi["rest"]["issues"]>,
  around: {
    readonly login?: string;
    readonly authFails?: boolean;
    readonly draft?: boolean;
  } = {},
): LifecycleApi {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- test stub, only the shape above is exercised
  return {
    rest: {
      users: {
        getAuthenticated: () =>
          around.authFails === true
            ? Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 }))
            : Promise.resolve({ data: { login: around.login } }),
      },
      pulls: {
        get: () => Promise.resolve({ data: { draft: around.draft } }),
      },
      issues: {
        get: () => Promise.resolve({ data: { created_at: "2026-01-01T00:00:00Z" } }),
        update: () => Promise.resolve(undefined),
        addLabels: () => Promise.resolve(undefined),
        removeLabel: () => Promise.resolve(undefined),
        listLabelsForRepo: () => Promise.resolve({ data: [] }),
        listForRepo: () => Promise.resolve({ data: [] }),
        listComments: () => Promise.resolve({ data: [] }),
        listEvents: () => Promise.resolve({ data: [] }),
        ...over,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub, only the shape above is exercised
  } as any;
}

const AT = { owner: "acme", repo: "widgets", number: 1 };

describe("readComments", () => {
  it("reads a single page and stops", async () => {
    const api = apiWith({
      listComments: () =>
        Promise.resolve({
          data: [
            {
              id: 1,
              body: "hi",
              user: { login: "alice", type: "User" },
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        }),
    });
    const comments = await readComments(api, AT);
    expect(comments).toEqual([
      {
        id: 1,
        body: "hi",
        login: "alice",
        isBot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
  });

  it("defaults a missing body and login to empty", async () => {
    const api = apiWith({
      listComments: () =>
        Promise.resolve({ data: [{ id: 2, created_at: "2026-01-01T00:00:00Z" }] }),
    });
    const comments = await readComments(api, AT);
    expect(comments[0]).toMatchObject({ id: 2, body: "", login: "" });
  });

  it("recognises a bot by its [bot] suffix even without a type", async () => {
    const api = apiWith({
      listComments: () =>
        Promise.resolve({
          data: [
            { id: 3, user: { login: "github-actions[bot]" }, created_at: "2026-01-01T00:00:00Z" },
          ],
        }),
    });
    const comments = await readComments(api, AT);
    expect(comments[0]?.isBot).toBe(true);
  });

  it("pages until a short page is returned", async () => {
    let calls = 0;
    const api = apiWith({
      listComments: ({ page }) => {
        calls += 1;
        if (page === 1) {
          const data = Array.from({ length: 100 }, (_v, i) => ({
            id: i,
            created_at: "2026-01-01T00:00:00Z",
          }));
          return Promise.resolve({ data });
        }
        return Promise.resolve({ data: [{ id: 999, created_at: "2026-01-02T00:00:00Z" }] });
      },
    });
    const comments = await readComments(api, AT);
    expect(calls).toBe(2);
    expect(comments).toHaveLength(101);
  });
});

describe("readEvents", () => {
  it("reads label and actor fields, defaulting created_at to the epoch when absent", async () => {
    const api = apiWith({
      listEvents: () =>
        Promise.resolve({
          data: [{ event: "labeled", label: { name: "stale" }, actor: { login: "reeve[bot]" } }],
        }),
    });
    const events = await readEvents(api, AT);
    expect(events).toEqual([
      {
        event: "labeled",
        label: "stale",
        login: "reeve[bot]",
        isBot: true,
        createdAt: new Date(0),
      },
    ]);
  });

  it("reads a null label as null, not the string 'null'", async () => {
    const api = apiWith({
      listEvents: () =>
        Promise.resolve({
          data: [{ event: "reopened", created_at: "2026-01-01T00:00:00Z" }],
        }),
    });
    const events = await readEvents(api, AT);
    expect(events[0]?.label).toBeNull();
  });
});

describe("resolveOwnLogin", () => {
  it("answers the login the run's own token authenticates as", async () => {
    // Everything the clock-hand attribution gate decides turns on this string:
    // `clock.ts` compares it against each event's and comment's own login to
    // tell a labelling this duty made from one it did not.
    const api = apiWith({}, { login: "reeve[bot]" });

    expect(await resolveOwnLogin(api)).toBe("reeve[bot]");
  });

  it("lets a refused identity read propagate rather than answering with a guess", async () => {
    // A GitHub App installation token is refused by `/user` outright. The
    // error reaching the caller is what keeps the run from proceeding with an
    // identity nobody established.
    const api = apiWith({}, { authFails: true });

    await expect(resolveOwnLogin(api)).rejects.toThrow("Forbidden");
  });

  // An identity read that SUCCEEDS without a login answers `""`
  // (`timeline.ts:141`), and `""` is also what `readEvents`/`readComments`
  // answer for an actor GitHub no longer reports — two different unknowns that
  // a `===` compared as the same actor, attributing every actorless event to
  // this duty. That defect is fixed: `isOwnActor` in `clock.ts` never calls an
  // unreadable identity a match, and the two tests at `clock.test.ts:491` and
  // `:511` pin the pair of cases it used to get wrong. What is still a todo is
  // only this end of it — reporting an unreadable identity as unusable instead
  // of as `""` — left unpinned because pinning `""` would bless it.
  it.todo("reports an unreadable identity as unusable rather than as an empty login");
});

describe("isDraftPr", () => {
  it("reads the draft flag the issues endpoint does not carry", async () => {
    expect(await isDraftPr(apiWith({}, { draft: true }), AT)).toBe(true);
  });

  it("is false for a pull request that is ready for review", async () => {
    expect(await isDraftPr(apiWith({}, { draft: false }), AT)).toBe(false);
  });

  it("is false when the field is absent altogether, rather than exempting the thread", async () => {
    // `exempt.drafts` withholds every action from a draft. Reading an absent
    // field as "draft" would exempt threads nobody asked to exempt — silently,
    // and for as long as the field stayed absent.
    expect(await isDraftPr(apiWith({}, {}), AT)).toBe(false);
  });
});

describe("the ceiling both readers stop at", () => {
  /** A full page of the shape `readComments` reads. */
  function fullCommentPage(page: number): { id: number; created_at: string }[] {
    return Array.from({ length: 100 }, (_v, i) => ({
      id: page * 100 + i,
      created_at: "2026-01-01T00:00:00Z",
    }));
  }

  it("stops reading comments after ten full pages rather than paging forever", async () => {
    let calls = 0;
    const api = apiWith({
      listComments: ({ page }) => {
        calls += 1;
        return Promise.resolve({ data: fullCommentPage(page ?? 1) });
      },
    });

    const comments = await readComments(api, AT);

    expect(calls).toBe(10);
    expect(comments).toHaveLength(1000);
  });

  it("stops reading events after ten full pages too", async () => {
    let calls = 0;
    const api = apiWith({
      listEvents: ({ page }) => {
        calls += 1;
        return Promise.resolve({
          data: Array.from({ length: 100 }, () => ({
            event: "labeled",
            label: { name: `l${String(page ?? 0)}` },
            created_at: "2026-01-01T00:00:00Z",
          })),
        });
      },
    });

    const events = await readEvents(api, AT);

    expect(calls).toBe(10);
    expect(events).toHaveLength(1000);
  });

  // Both readers answer a bare array, so a caller cannot tell a thread with
  // 1000 comments from one with 4000 whose tail was never read. `core/forge.ts`
  // answers `more` from `listReplies` and `complete` from `listLabelEvents`
  // for exactly this reason, and `forge.adversarial.test.ts` pins both.
  // `clock.ts:249` finds a step's anchor by scanning these comments for its own
  // marker: an anchor past the ceiling reads as NO anchor, so a thread long
  // enough is re-nudged — and eventually re-closed — on a clock that already
  // ran. Left as a todo rather than pinned, because pinning the bare array
  // would bless it.
  it.todo("says whether the history it returned was complete");
});
