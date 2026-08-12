import { describe, expect, it } from "vitest";

import { readComments, readEvents, type LifecycleApi } from "./timeline.js";

function apiWith(over: Partial<LifecycleApi["rest"]["issues"]>): LifecycleApi {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- test stub, only the shape above is exercised
  return {
    rest: {
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
