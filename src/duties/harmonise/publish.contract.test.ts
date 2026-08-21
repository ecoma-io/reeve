/**
 * `publishSync` — the write path, and the dry-run that must stop it.
 *
 * `publish.test.ts` imports `buildPrBody` and `sanitizeBranchSegment` only:
 * the two pure renderers. `publishSync` — which creates a branch, commits
 * files onto it and opens or updates a pull request — has never been driven,
 * and neither has the `if (dryRun)` at `publish.ts:139`. That is the gap this
 * closes, and it is the one that matters most: harmonise's dry-run is the only
 * duty's dry-run with no case anywhere asserting it writes nothing, and a
 * dry-run that writes is not a lesser bug than a wrong translation.
 *
 * The API stub records every call. A case's assertions are about which calls
 * were made and with what, so "wrote nothing" is a claim about the recording
 * rather than about a flag.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "@actions/core";

import type { Score } from "../../core/score.js";
import type { DocumentGroup } from "./discover.js";
import type { Draft } from "./draft.js";
import { publishSync, type PublishApi, type SyncResult } from "./publish.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  info: vi.fn(),
  warning: vi.fn(),
}));

const AT = { owner: "acme", repo: "widgets" };

function score(): Score {
  return { value: 1, admissible: true, reason: null, checks: [] };
}

function draft(text = "Bản dịch."): Draft {
  return { model: "m", text, score: score() };
}

function group(): DocumentGroup {
  return {
    id: "docs/getting-started",
    files: new Map([
      ["en", "docs/getting-started.md"],
      ["vi", "docs/getting-started.vi.md"],
    ]),
  };
}

function result(over: Partial<SyncResult> = {}): SyncResult {
  return {
    group: group(),
    drafts: new Map([["vi", draft()]]),
    conflicts: [],
    created: [],
    ...over,
  };
}

/** Everything the stub was asked to do, in order, so a case can assert on it. */
interface Recorded {
  readonly createdRefs: string[];
  readonly writes: {
    path: string;
    branch: string | undefined;
    sha: string | undefined;
    content: string;
  }[];
  readonly createdPrs: { head: string; base: string; title: string }[];
  readonly updatedPrs: number[];
}

function apiOf(
  options: {
    /** Refs that already exist. `heads/main` is always present. */
    readonly refs?: readonly string[];
    /** Paths whose file already exists on the branch, with the sha to report. */
    readonly files?: Record<string, string>;
    /** An open PR already on the branch, by number. */
    readonly openPr?: number;
    /** A PR on the branch that a maintainer closed WITHOUT merging. */
    readonly closedUnmergedPr?: number;
    /** A PR on the branch that was closed because it merged. */
    readonly mergedPr?: number;
  } = {},
): { api: PublishApi; recorded: Recorded } {
  const refs = new Set<string>(["heads/main", ...(options.refs ?? [])]);
  const recorded: Recorded = { createdRefs: [], writes: [], createdPrs: [], updatedPrs: [] };
  const missing = (): never => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  };

  return {
    recorded,
    api: {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: "main" } }),
          getContent: ({ path }) => {
            const sha = options.files?.[path];
            if (sha === undefined) missing();
            return Promise.resolve({ data: { sha: sha! } });
          },
          createOrUpdateFileContents: (params) => {
            recorded.writes.push({
              path: params.path,
              branch: params.branch,
              sha: params.sha,
              content: Buffer.from(params.content, "base64").toString("utf8"),
            });
            return Promise.resolve({ data: { content: { sha: `sha-${params.path}` } } });
          },
        },
        git: {
          getRef: ({ ref }) => {
            if (!refs.has(ref)) missing();
            return Promise.resolve({ data: { object: { sha: "base-sha" } } });
          },
          createRef: (params) => {
            recorded.createdRefs.push(params.ref);
            refs.add(params.ref.replace("refs/", ""));
            return Promise.resolve({});
          },
        },
        pulls: {
          list: (params) => {
            if (params.state === "closed") {
              const closed = [
                ...(options.closedUnmergedPr === undefined
                  ? []
                  : [{ number: options.closedUnmergedPr, head: { sha: "s" }, merged: false }]),
                ...(options.mergedPr === undefined
                  ? []
                  : [{ number: options.mergedPr, head: { sha: "s" }, merged: true }]),
              ];
              return Promise.resolve({ data: closed });
            }
            return Promise.resolve({
              data:
                options.openPr === undefined
                  ? []
                  : [{ number: options.openPr, head: { sha: "head-sha" } }],
            });
          },
          create: (params) => {
            recorded.createdPrs.push({
              head: params.head,
              base: params.base,
              title: params.title,
            });
            return Promise.resolve({ data: { number: 101 } });
          },
          update: (params) => {
            recorded.updatedPrs.push(params.pull_number);
            return Promise.resolve({});
          },
        },
      },
    },
  };
}

beforeEach(() => {
  vi.mocked(core.info).mockReset();
});

describe("dry-run writes nothing at all", () => {
  it("creates_no_branch_commits_no_file_and_opens_no_pull_request", async () => {
    // The whole of harmonise's dry-run contract, asserted on the recording
    // rather than on the flag: a dry run that reached any of these three would
    // have changed somebody's repository while claiming it would not.
    const { api, recorded } = apiOf();

    const published = await publishSync(api, AT, result(), true);

    expect(published).toBeNull();
    expect(recorded.createdRefs).toEqual([]);
    expect(recorded.writes).toEqual([]);
    expect(recorded.createdPrs).toEqual([]);
    expect(recorded.updatedPrs).toEqual([]);
  });

  it("says_what_it_would_have_done_rather_than_staying_silent", async () => {
    // A dry run whose output is nothing is indistinguishable from a run that
    // found nothing to do, which is the one thing a dry run must not be.
    const { api } = apiOf();

    await publishSync(api, AT, result(), true);

    expect(vi.mocked(core.info).mock.calls.flat().join("\n")).toContain(
      "dry-run: would create/update branch `reeve/harmonise/docs-getting-started`",
    );
  });

  it("writes_nothing_even_when_the_branch_and_the_pull_request_already_exist", async () => {
    // The update path is the one where "nothing to create" could be mistaken
    // for "nothing to do".
    const { api, recorded } = apiOf({
      refs: ["heads/reeve/harmonise/docs-getting-started"],
      openPr: 7,
    });

    expect(await publishSync(api, AT, result(), true)).toBeNull();
    expect(recorded.writes).toEqual([]);
    expect(recorded.updatedPrs).toEqual([]);
  });

  it("does_nothing_and_reports_nothing_when_there_are_no_drafts_to_publish", async () => {
    const { api, recorded } = apiOf();

    expect(await publishSync(api, AT, result({ drafts: new Map() }), false)).toBeNull();
    expect(recorded.writes).toEqual([]);
    expect(recorded.createdPrs).toEqual([]);
  });
});

describe("a real publish", () => {
  it("creates_the_branch_when_it_does_not_exist_and_commits_onto_it", async () => {
    const { api, recorded } = apiOf();

    const published = await publishSync(api, AT, result(), false);

    expect(recorded.createdRefs).toEqual(["refs/heads/reeve/harmonise/docs-getting-started"]);
    expect(recorded.writes).toEqual([
      {
        path: "docs/getting-started.vi.md",
        branch: "reeve/harmonise/docs-getting-started",
        sha: undefined,
        content: "Bản dịch.",
      },
    ]);
    expect(published?.pr).toBe(101);
  });

  it("reuses_an_existing_branch_rather_than_creating_it_twice", async () => {
    const { api, recorded } = apiOf({ refs: ["heads/reeve/harmonise/docs-getting-started"] });

    await publishSync(api, AT, result(), false);

    expect(recorded.createdRefs).toEqual([]);
    expect(recorded.writes).toHaveLength(1);
  });

  it("passes_the_existing_blob_sha_when_the_file_is_already_on_the_branch", async () => {
    // Without the sha, GitHub refuses the update: this is the difference
    // between "create" and "update" on the Contents API.
    const { api, recorded } = apiOf({
      files: { "docs/getting-started.vi.md": "old-sha" },
    });

    await publishSync(api, AT, result(), false);

    expect(recorded.writes[0]?.sha).toBe("old-sha");
  });

  it("records_the_new_sha_of_every_file_it_wrote", async () => {
    // The provenance state records the real revision a sync left behind, so a
    // later human edit reads as a conflict rather than being re-drafted over.
    const { api } = apiOf();

    const published = await publishSync(api, AT, result(), false);

    expect(published?.shas.get("vi")).toBe("sha-docs/getting-started.vi.md");
  });

  it("updates_the_open_pull_request_instead_of_opening_a_second_one", async () => {
    // Idempotency: a second run over the same document group must not leave
    // two pull requests behind.
    const { api, recorded } = apiOf({ openPr: 7 });

    const published = await publishSync(api, AT, result(), false);

    expect(recorded.updatedPrs).toEqual([7]);
    expect(recorded.createdPrs).toEqual([]);
    expect(published?.pr).toBe(7);
  });

  it("skips_a_locale_the_document_group_has_no_file_for", async () => {
    // A draft for a locale the group never discovered has nowhere to go, and
    // inventing a path for it would create a file nobody asked for.
    const { api, recorded } = apiOf();

    await publishSync(
      api,
      AT,
      result({
        drafts: new Map([
          ["vi", draft()],
          ["zz", draft("Nope.")],
        ]),
      }),
      false,
    );

    expect(recorded.writes.map((write) => write.path)).toEqual(["docs/getting-started.vi.md"]);
  });

  it("opens_the_pull_request_against_the_repository_default_branch", async () => {
    const { api, recorded } = apiOf();

    await publishSync(api, AT, result(), false);

    expect(recorded.createdPrs).toEqual([
      {
        head: "reeve/harmonise/docs-getting-started",
        base: "main",
        title: "harmonise: sync docs/getting-started",
      },
    ]);
  });
});

describe("D3 — never reopening what a maintainer closed", () => {
  /**
   * A maintainer who closes a sync pull request without merging it has made a
   * decision, and D3 (`docs/doctrine/north-star.md:247`) is repository-wide:
   * "It never reopens or reassigns or closes what a maintainer decided."
   *
   * `dependa/publish.ts:210-224` implements exactly this refusal and names the
   * doctrine in its own comment. harmonise did not: with the branch still
   * present and no OPEN pull request on it, it wrote the locale files again
   * and opened a NEW pull request — re-proposing precisely what the maintainer
   * had just rejected, on every scheduled run, for ever.
   *
   * Not adjudicated as intentional, because nothing declares it: no comment,
   * no doc, and the sibling duty does the opposite while citing the rule.
   */
  it("refuses to publish when a pull request on the branch was closed unmerged", async () => {
    const { api, recorded } = apiOf({
      refs: ["heads/reeve/harmonise/docs-getting-started"],
      closedUnmergedPr: 9,
    });

    const published = await publishSync(api, AT, result(), false);

    expect(published).toBeNull();
    expect(recorded.writes).toEqual([]);
    expect(recorded.createdPrs).toEqual([]);
    expect(recorded.updatedPrs).toEqual([]);
  });

  it("says which pull request it is refusing on behalf of", async () => {
    // Silence would read as "nothing to sync", which is the opposite of what
    // happened and leaves the maintainer with no way to find out why their
    // documentation stopped being synchronised.
    const { api } = apiOf({
      refs: ["heads/reeve/harmonise/docs-getting-started"],
      closedUnmergedPr: 9,
    });

    await publishSync(api, AT, result(), false);

    const said = vi
      .mocked(core.info)
      .mock.calls.map(([message]) => message)
      .join("\n");
    expect(said).toContain("#9");
    expect(said).toContain("closed without merge");
  });

  it("publishes again after a pull request that was closed BY MERGING", async () => {
    // The other half. A merged pull request is work accepted, not work
    // refused, so the next source change gets a new sync — otherwise one
    // successful merge would stop the duty for that document permanently.
    const { api, recorded } = apiOf({ mergedPr: 8 });

    const published = await publishSync(api, AT, result(), false);

    expect(published?.pr).toBe(101);
    expect(recorded.createdPrs).toHaveLength(1);
  });

  it("still publishes normally when the branch has no closed pull request at all", async () => {
    const { api, recorded } = apiOf();

    await publishSync(api, AT, result(), false);

    expect(recorded.createdPrs).toHaveLength(1);
  });
});
