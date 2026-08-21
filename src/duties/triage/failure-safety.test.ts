/**
 * Failure safety tests — read-path fail-closed invariants across the outcome
 * module.
 *
 * Every read path in `outcome.ts` that checks GitHub's API to answer a
 * question about attribution or standing must fail **closed**: an unreadable
 * answer must not become authority it never was. These tests verify that each
 * such path returns the safe value on error rather than propagating the
 * failure or defaulting to a more permissive answer.
 *
 * The three read paths and their safe values:
 *
 * | Function              | Safe value | Meaning                                      |
 * |-----------------------|-----------|----------------------------------------------|
 * | `removedByAutomation` | `false`   | No enrichment; S2 correction is still written |
 * | `attributedClose`     | `null`    | No attribution; reopen falls through to triage |
 * | `isTrustedReopener`   | `false`   | No standing; reopen is not recorded as reversal |
 *
 * `gateClose` is also fail-closed but is tested in `outcome.test.ts` and in
 * `main.integration.test.ts` — its unreadable-shard refusal is already
 * verified there. This file covers the three API-read paths above.
 *
 * The existing functional tests in `outcome.test.ts` verify correct behaviour
 * on valid data; these tests verify correct behaviour when the data cannot be
 * read at all.
 */
import { describe, expect, it } from "vitest";

import type { ContentsApi, GitHubApi, Location, TrackerApi } from "../../core/forge.js";

import { attributedClose, gateClose, isTrustedReopener, removedByAutomation } from "./outcome.js";

const AT: Location = { owner: "acme", repo: "widgets", number: 42 };

// ---------------------------------------------------------------------------
// Stubs that fail on demand
// ---------------------------------------------------------------------------

/** A tracker API whose `listEvents` rejects with a network error. */
function trackerWithLabelEventError(): TrackerApi {
  return {
    rest: {
      issues: {
        get: () => {
          throw new Error("not used by these tests");
        },
        update: () => {
          throw new Error("not used by these tests");
        },
        addLabels: () => {
          throw new Error("not used by these tests");
        },
        createComment: () => {
          throw new Error("not used by these tests");
        },
        addAssignees: () => {
          throw new Error("not used by these tests");
        },
        listLabelsForRepo: () => {
          throw new Error("not used by these tests");
        },
        listForRepo: () => {
          throw new Error("not used by these tests");
        },
        removeLabel: () => {
          throw new Error("not used by these tests");
        },
        createLabel: () => {
          throw new Error("not used by these tests");
        },
        listEvents: () => Promise.reject(new Error("network timeout")),
      },
      repos: {
        getCollaboratorPermissionLevel: () => {
          throw new Error("not used by these tests");
        },
      },
    },
  };
}

/** A GitHub API whose `listComments` rejects with a network error. */
function githubWithCommentsError(): GitHubApi {
  return {
    rest: {
      issues: {
        get: () => {
          throw new Error("not used by these tests");
        },
        update: () => {
          throw new Error("not used by these tests");
        },
        listComments: () => Promise.reject(new Error("network timeout")),
        updateComment: () => {
          throw new Error("not used by these tests");
        },
        getComment: () => {
          throw new Error("not used by these tests");
        },
      },
    },
  };
}

/** A tracker API whose `getCollaboratorPermissionLevel` rejects. */
function trackerWithPermissionError(): TrackerApi {
  return {
    rest: {
      issues: {
        get: () => {
          throw new Error("not used by these tests");
        },
        update: () => {
          throw new Error("not used by these tests");
        },
        addLabels: () => {
          throw new Error("not used by these tests");
        },
        createComment: () => {
          throw new Error("not used by these tests");
        },
        addAssignees: () => {
          throw new Error("not used by these tests");
        },
        listLabelsForRepo: () => {
          throw new Error("not used by these tests");
        },
        listForRepo: () => {
          throw new Error("not used by these tests");
        },
        removeLabel: () => {
          throw new Error("not used by these tests");
        },
        createLabel: () => {
          throw new Error("not used by these tests");
        },
        listEvents: () => {
          throw new Error("not used by these tests");
        },
      },
      repos: {
        getCollaboratorPermissionLevel: () => Promise.reject(new Error("404 Not Found")),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("removedByAutomation", () => {
  it("returns false on a label events API failure — fail-closed, no enrichment", async () => {
    const api = trackerWithLabelEventError();

    // An unreadable history answers `false`, not "unknown". The S2
    // correction is still written — only the `outcome: "overruled"`
    // enrichment is forgone.
    await expect(removedByAutomation(api, AT, "bug")).resolves.toBe(false);
  });
});

describe("attributedClose", () => {
  it("returns null on a comments API failure — fail-closed, no attribution", async () => {
    const api = githubWithCommentsError();

    // An unreadable comment section is not evidence that the close was
    // Reeve's own. Returning `null` lets the reopen fall through to an
    // ordinary verdict.
    await expect(attributedClose(api, AT)).resolves.toBeNull();
  });
});

describe("isTrustedReopener", () => {
  it("returns false on a collaborator permission API failure — fail-closed", async () => {
    const api = trackerWithPermissionError();

    // A stranger reopening a thread is the case this function exists to
    // refuse. A failed lookup is not evidence of standing — it answers
    // the same way a "none" permission would.
    await expect(isTrustedReopener(api, AT, "stranger")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `gateClose` reads the corrections store through the Contents API, and its
// own doc comment draws a line: a shard it could not DECODE is ambiguity and
// holds the close, while everything else is somebody else's problem to
// classify. `outcome.test.ts` covers both sides of that line. What it does not
// cover is what the read does when the API itself misbehaves — and the two
// answers are deliberately different, so neither may be assumed from the
// other.
// ---------------------------------------------------------------------------

/** A store whose listing works and whose shard read fails however the case says. */
function contentsWhoseShardRead(failure: Error): ContentsApi {
  const shard = "corrections/2026-08.ndjson";
  return {
    rest: {
      repos: {
        getContent: ({ path }: { path: string }) => {
          if (path === "corrections") {
            return Promise.resolve({
              data: [{ name: "2026-08.ndjson", path: shard, sha: "sha-1" }],
            });
          }
          return Promise.reject(failure);
        },
        createOrUpdateFileContents: () => {
          throw new Error("not used by these tests");
        },
      },
    },
  };
}

describe("gateClose", () => {
  it("propagates a transport failure rather than reading it as an unreadable shard", async () => {
    // A 500 is not the same fact as "this shard cannot be decoded": one is the
    // API having a bad minute, the other is a file whose contents might hold
    // the very record the gate is looking for. Folding the first into the
    // second would turn every outage into a silent, permanent refusal to
    // close anything — green runs, no closes, and nothing saying why.
    const api = contentsWhoseShardRead(Object.assign(new Error("Server Error"), { status: 500 }));

    await expect(gateClose(api, AT, "corrections", "acme/widgets", 42)).rejects.toThrow(
      "Server Error",
    );
  });

  it("skips a shard that disappeared between the listing and the read", async () => {
    // A 404 on a file the listing named a moment ago is a race with another
    // writer, not ambiguity: the shard is gone, so it holds no record, and the
    // gate neither refuses nor reports it unreadable.
    const api = contentsWhoseShardRead(Object.assign(new Error("Not Found"), { status: 404 }));

    await expect(gateClose(api, AT, "corrections", "acme/widgets", 42)).resolves.toEqual({
      refuse: false,
      found: false,
      unreadable: [],
    });
  });
});
