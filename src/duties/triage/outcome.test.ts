import { describe, expect, it } from "vitest";

import type { ContentsApi, GitHubApi, Location, Standing, TrackerApi } from "../../core/forge.js";
import { formatCorrection, type Correction } from "../../core/memory.js";

import {
  attributedClose,
  checkReversal,
  closeMarker,
  gateClose,
  isTrustedReopener,
  removedByAutomation,
} from "./outcome.js";

// Every stub here is hand-built rather than mocked from a real client, the
// same idiom `core/forge.test.ts` uses: each function under test reads a
// narrow slice of one port, and a stub that only answers that slice is what
// keeps a test from passing for the wrong reason.

const AT: Location = { owner: "acme", repo: "widgets", number: 42 };

function standingOf(over: Partial<Standing> = {}): Standing {
  return {
    title: "Dark mode setting is lost between sessions",
    body: "It resets every time I close the app.",
    labels: [],
    closed: false,
    author: { login: "reporter", isBot: false },
    milestone: null,
    assignees: [],
    createdAt: new Date(0),
    isPullRequest: false,
    ...over,
  };
}

function trackerOf(
  options: {
    events?: {
      event?: string;
      label?: { name?: string };
      actor?: { login?: string; type?: string } | null;
    }[][];
    permission?: string;
    permissionFails?: boolean;
  } = {},
): TrackerApi {
  const { events = [[]], permission = "none", permissionFails = false } = options;
  return {
    rest: {
      issues: {
        get: () => {
          throw new Error("not used by outcome.ts");
        },
        update: () => {
          throw new Error("not used by outcome.ts");
        },
        addLabels: () => {
          throw new Error("not used by outcome.ts");
        },
        createComment: () => {
          throw new Error("not used by outcome.ts");
        },
        addAssignees: () => {
          throw new Error("not used by outcome.ts");
        },
        listLabelsForRepo: () => {
          throw new Error("not used by outcome.ts");
        },
        listForRepo: () => {
          throw new Error("not used by outcome.ts");
        },
        removeLabel: () => {
          throw new Error("not used by outcome.ts");
        },
        createLabel: () => {
          throw new Error("not used by outcome.ts");
        },
        listEvents: (params: { page?: number }) =>
          Promise.resolve({ data: events[(params.page ?? 1) - 1] ?? [] }),
      },
      repos: {
        getCollaboratorPermissionLevel: () => {
          if (permissionFails) return Promise.reject(new Error("no relationship to this repo"));
          return Promise.resolve({ data: { permission } });
        },
      },
    },
  };
}

function githubOf(
  comments: { id: number; body: string; user?: { login?: string; type?: string } }[],
): GitHubApi {
  return {
    rest: {
      issues: {
        get: () => {
          throw new Error("not used by outcome.ts");
        },
        update: () => {
          throw new Error("not used by outcome.ts");
        },
        listComments: () => Promise.resolve({ data: comments }),
        updateComment: () => {
          throw new Error("not used by outcome.ts");
        },
        getComment: () => {
          throw new Error("not used by outcome.ts");
        },
      },
    },
  };
}

/** A `GitHubApi & TrackerApi`, built by combining the two stubs above. */
function combinedOf(
  comments: { id: number; body: string; user?: { login?: string; type?: string } }[],
  trackerOptions: Parameters<typeof trackerOf>[0] = {},
): GitHubApi & TrackerApi {
  const github = githubOf(comments);
  const tracker = trackerOf(trackerOptions);
  return {
    rest: {
      issues: { ...tracker.rest.issues, ...github.rest.issues },
      repos: tracker.rest.repos,
    },
  };
}

function contentsOf(files: Record<string, string>): ContentsApi {
  return {
    rest: {
      repos: {
        getContent: ({ path }: { path: string }) => {
          const file = files[path];
          if (file !== undefined) {
            return Promise.resolve({
              data: {
                sha: `sha-${path}`,
                content: Buffer.from(file, "utf8").toString("base64"),
                encoding: "base64",
              },
            });
          }
          const prefix = `${path.replace(/\/+$/, "")}/`;
          const children = Object.keys(files).filter((entry) => entry.startsWith(prefix));
          if (children.length > 0) {
            return Promise.resolve({
              data: children.map((entry) => ({
                name: entry.slice(prefix.length),
                path: entry,
                sha: `sha-${entry}`,
              })),
            });
          }
          return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
        },
        createOrUpdateFileContents: () => {
          throw new Error("not used by outcome.ts");
        },
      },
    },
  };
}

/** An unreadable (oversized) shard: present, but with no decodable content. */
function unreadableContentsOf(sha: string): ContentsApi {
  return {
    rest: {
      repos: {
        getContent: () => Promise.resolve({ data: { sha, content: "", encoding: "none" } }),
        createOrUpdateFileContents: () => {
          throw new Error("not used by outcome.ts");
        },
      },
    },
  };
}

function correction(over: Partial<Correction> = {}): Correction {
  return {
    repo: "acme/widgets",
    thread: 42,
    duty: "triage",
    at: "2026-08-01T00:00:00Z",
    title: "Dark mode setting is lost between sessions",
    excerpt: "It resets every time I close the app.",
    language: "en",
    proposed: [],
    decided: [],
    by: "maintainer",
    note: null,
    outcome: null,
    duplicateOf: null,
    pivot: null,
    ...over,
  };
}

describe("removedByAutomation", () => {
  it("is true when the last `labeled` event for the label was a bot's", async () => {
    const api = trackerOf({
      events: [
        [{ event: "labeled", label: { name: "bug" }, actor: { login: "reeve[bot]", type: "Bot" } }],
      ],
    });

    await expect(removedByAutomation(api, AT, "bug")).resolves.toBe(true);
  });

  it("is false when the last `labeled` event for the label was a human's", async () => {
    const api = trackerOf({
      events: [[{ event: "labeled", label: { name: "bug" }, actor: { login: "maintainer" } }]],
    });

    await expect(removedByAutomation(api, AT, "bug")).resolves.toBe(false);
  });

  it("follows the *last* application, not the first, across a relabel cycle", async () => {
    // Applied by the bot, removed, then reapplied by a human — removing it
    // again now is a human correcting a human, not a human correcting
    // automation.
    const api = trackerOf({
      events: [
        [
          { event: "labeled", label: { name: "bug" }, actor: { login: "reeve[bot]", type: "Bot" } },
          { event: "unlabeled", label: { name: "bug" }, actor: { login: "maintainer" } },
          { event: "labeled", label: { name: "bug" }, actor: { login: "maintainer" } },
        ],
      ],
    });

    await expect(removedByAutomation(api, AT, "bug")).resolves.toBe(false);
  });

  it("is false when there is no `labeled` event for this label at all", async () => {
    const api = trackerOf({ events: [[]] });

    await expect(removedByAutomation(api, AT, "bug")).resolves.toBe(false);
  });

  it("is false — never a guess — when the history could not be read completely", async () => {
    // Ten full pages: `listLabelEvents` reports `complete: false`.
    const fullPage = Array.from({ length: 100 }, () => ({
      event: "labeled" as const,
      label: { name: "other" },
      actor: { login: "x" },
    }));
    const api = trackerOf({ events: Array.from({ length: 10 }, () => fullPage) });

    await expect(removedByAutomation(api, AT, "bug")).resolves.toBe(false);
  });

  it("ignores events for a different label entirely", async () => {
    const api = trackerOf({
      events: [
        [
          {
            event: "labeled",
            label: { name: "docs" },
            actor: { login: "reeve[bot]", type: "Bot" },
          },
        ],
      ],
    });

    await expect(removedByAutomation(api, AT, "bug")).resolves.toBe(false);
  });
});

describe("attributedClose", () => {
  it("finds the target inside a bot-authored comment carrying the marker", async () => {
    const api = githubOf([
      {
        id: 1,
        body: `Closed as a duplicate of #7.\n\n${closeMarker.render(7)}`,
        user: { login: "reeve[bot]", type: "Bot" },
      },
    ]);

    await expect(attributedClose(api, AT)).resolves.toEqual({ duplicateOf: 7 });
  });

  it("returns null when no reply carries the marker", async () => {
    const api = githubOf([
      { id: 1, body: "Thanks for the report.", user: { login: "maintainer" } },
    ]);

    await expect(attributedClose(api, AT)).resolves.toBeNull();
  });

  it("ignores a stranger's comment forging the marker text — not bot-authored", async () => {
    const api = githubOf([{ id: 1, body: closeMarker.render(7), user: { login: "impersonator" } }]);

    await expect(attributedClose(api, AT)).resolves.toBeNull();
  });

  it("ignores a bot comment carrying no marker, even among other bot noise", async () => {
    const api = githubOf([
      { id: 1, body: "Housekeeping ping.", user: { login: "some-other-bot[bot]", type: "Bot" } },
    ]);

    await expect(attributedClose(api, AT)).resolves.toBeNull();
  });

  it("finds the most recent close-and-reopen cycle, not the first", async () => {
    const api = githubOf([
      { id: 1, body: closeMarker.render(7), user: { login: "reeve[bot]", type: "Bot" } },
      { id: 2, body: "Reopening, this isn't a duplicate.", user: { login: "maintainer" } },
      { id: 3, body: closeMarker.render(9), user: { login: "reeve[bot]", type: "Bot" } },
    ]);

    await expect(attributedClose(api, AT)).resolves.toEqual({ duplicateOf: 9 });
  });
});

describe("isTrustedReopener", () => {
  it("trusts admin", async () => {
    const api = trackerOf({ permission: "admin" });
    await expect(isTrustedReopener(api, AT, "maintainer")).resolves.toBe(true);
  });

  it("trusts write", async () => {
    const api = trackerOf({ permission: "write" });
    await expect(isTrustedReopener(api, AT, "maintainer")).resolves.toBe(true);
  });

  it("does not trust read, even though it is inside GitHub's own COLLABORATOR band", async () => {
    const api = trackerOf({ permission: "read" });
    await expect(isTrustedReopener(api, AT, "collaborator")).resolves.toBe(false);
  });

  it("does not trust none", async () => {
    const api = trackerOf({ permission: "none" });
    await expect(isTrustedReopener(api, AT, "stranger")).resolves.toBe(false);
  });

  it("fails closed on a lookup error, including a 404 for an unrelated account", async () => {
    const api = trackerOf({ permissionFails: true });
    await expect(isTrustedReopener(api, AT, "stranger")).resolves.toBe(false);
  });

  it("refuses an empty username without a network call", async () => {
    const api = trackerOf({ permission: "admin" });
    await expect(isTrustedReopener(api, AT, "")).resolves.toBe(false);
  });
});

describe("checkReversal", () => {
  it("is neither a reversal nor an author reopen when the close was not Reeve's own", async () => {
    const api = combinedOf([{ id: 1, body: "Reopening this.", user: { login: "maintainer" } }]);

    await expect(checkReversal(api, AT, standingOf(), "maintainer")).resolves.toEqual({
      reversal: null,
      authorReopen: false,
    });
  });

  it("surfaces, but never records, the thread's own author reopening it", async () => {
    const api = combinedOf(
      [{ id: 1, body: closeMarker.render(7), user: { login: "reeve[bot]", type: "Bot" } }],
      { permission: "admin" },
    );

    await expect(
      checkReversal(
        api,
        AT,
        standingOf({ author: { login: "reporter", isBot: false } }),
        "reporter",
      ),
    ).resolves.toEqual({ reversal: null, authorReopen: true });
  });

  it("does not record a reversal from an untrusted reopener", async () => {
    const api = combinedOf(
      [{ id: 1, body: closeMarker.render(7), user: { login: "reeve[bot]", type: "Bot" } }],
      { permission: "none" },
    );

    await expect(checkReversal(api, AT, standingOf(), "stranger")).resolves.toEqual({
      reversal: null,
      authorReopen: false,
    });
  });

  it("records a reversal from a trusted, non-author reopener", async () => {
    const api = combinedOf(
      [{ id: 1, body: closeMarker.render(7), user: { login: "reeve[bot]", type: "Bot" } }],
      { permission: "write" },
    );

    await expect(checkReversal(api, AT, standingOf(), "maintainer")).resolves.toEqual({
      reversal: { duplicateOf: 7 },
      authorReopen: false,
    });
  });
});

describe("gateClose", () => {
  it("does not refuse when the store carries no matching record", async () => {
    const files = { "corrections/2026-08.ndjson": `${formatCorrection(correction())}\n` };
    const contentsApi = contentsOf(files);

    const gate = await gateClose(contentsApi, AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({ refuse: false, found: false, unreadable: [] });
  });

  it("does not refuse an empty (never-recorded) store", async () => {
    const contentsApi = contentsOf({});

    const gate = await gateClose(contentsApi, AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({ refuse: false, found: false, unreadable: [] });
  });

  it("refuses when the store carries a matching overruled close reversal", async () => {
    const overruled = correction({ thread: 42, outcome: "overruled", duplicateOf: 7 });
    const files = { "corrections/2026-08.ndjson": `${formatCorrection(overruled)}\n` };

    const gate = await gateClose(contentsOf(files), AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({ refuse: true, found: true, unreadable: [] });
  });

  it("does not refuse an overruled record for a different thread or repo", async () => {
    const otherThread = correction({ thread: 99, outcome: "overruled", duplicateOf: 7 });
    const otherRepo = correction({ repo: "acme/other", outcome: "overruled", duplicateOf: 7 });
    const files = {
      "corrections/2026-08.ndjson": `${formatCorrection(otherThread)}\n${formatCorrection(otherRepo)}\n`,
    };

    const gate = await gateClose(contentsOf(files), AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({ refuse: false, found: false, unreadable: [] });
  });

  it("does not refuse an S1 label reversal — only a close reversal names `duplicateOf`", async () => {
    const s1 = correction({ thread: 42, outcome: "overruled", duplicateOf: null });
    const files = { "corrections/2026-08.ndjson": `${formatCorrection(s1)}\n` };

    const gate = await gateClose(contentsOf(files), AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({ refuse: false, found: false, unreadable: [] });
  });

  it("skips an unparseable line rather than refusing over it", async () => {
    const files = { "corrections/2026-08.ndjson": "{not json\n" };

    const gate = await gateClose(contentsOf(files), AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({ refuse: false, found: false, unreadable: [] });
  });

  it("refuses, and names the shard, on an unreadable (oversized) shard", async () => {
    const contentsApi = unreadableContentsOf("sha-1");
    // listCorrectionFiles needs a directory listing to find the shard first —
    // reuse the ordinary stub for that, then substitute the oversized read.
    const listing = contentsOf({ "corrections/2026-08.ndjson": "placeholder" });
    const combined: ContentsApi = {
      rest: {
        repos: {
          getContent: (params) =>
            params.path === "corrections"
              ? listing.rest.repos.getContent(params)
              : contentsApi.rest.repos.getContent(params),
          createOrUpdateFileContents: () => {
            throw new Error("not used by outcome.ts");
          },
        },
      },
    };

    const gate = await gateClose(combined, AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({
      refuse: true,
      found: false,
      unreadable: ["corrections/2026-08.ndjson"],
    });
  });

  it("reports `found`, not the unreadable shard, when a matching record turns up after one", async () => {
    // Two shards: an earlier one this run cannot decode at all, and a later
    // one that carries the matching reversal. `refuse` alone cannot tell a
    // caller which of those is why the close was refused — `found` is the
    // field that answers that, and this is the case that motivates it: an
    // unreadable shard elsewhere must not steal the explanation from an
    // actually-found record.
    const overruled = correction({ thread: 42, outcome: "overruled", duplicateOf: 7 });
    const listing = contentsOf({
      "corrections/2026-07.ndjson": "placeholder",
      "corrections/2026-08.ndjson": `${formatCorrection(overruled)}\n`,
    });
    const unreadableShard = unreadableContentsOf("sha-unreadable");
    const combined: ContentsApi = {
      rest: {
        repos: {
          getContent: (params) => {
            if (params.path === "corrections/2026-07.ndjson") {
              return unreadableShard.rest.repos.getContent(params);
            }
            return listing.rest.repos.getContent(params);
          },
          createOrUpdateFileContents: () => {
            throw new Error("not used by outcome.ts");
          },
        },
      },
    };

    const gate = await gateClose(combined, AT, "corrections", "acme/widgets", 42);

    expect(gate).toEqual({
      refuse: true,
      found: true,
      unreadable: ["corrections/2026-07.ndjson"],
    });
  });
});
