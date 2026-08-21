/**
 * What `propose` does when the write path fights back.
 *
 * `propose.test.ts` covers detection, the evidence gate, and the rounds that
 * succeed. This file covers the rounds that do not, because this is the one
 * capability in `triage` that edits a file in the repository — and the whole
 * doctrine of the module is that its failure mode is doing nothing:
 *
 * - a freshness check that cannot be answered treats the branch as frozen,
 *   because "unknown" is not permission to clobber a maintainer's commit;
 * - a write that lost a race on the file's `sha` is re-read and re-applied,
 *   never re-sent blind and never abandoned half-done;
 * - a rejection that is not a lost race propagates, rather than being retried
 *   as though it were one;
 * - a change-set that cannot be applied to the file it was computed against is
 *   abandoned before a single write.
 *
 * The fake below is deliberately its own, small, and ref-aware: every case
 * here turns on which call failed and how many times it was made, which a
 * shared happy-path fake cannot express.
 */
import { describe, expect, it } from "vitest";

import type { Atlas, Package } from "../../core/atlas.js";
import type { Listed } from "../../core/forge.js";
import { markerFor } from "../../core/marker.js";
import type { Label, ProposeWorkspace, Warrant } from "../../core/warrant.js";

import { runPropose, type ProposalsApi } from "./propose.js";

const AT = { owner: "acme", repo: "widgets" };
const PATH = ".github/reeve.yml";
const BRANCH = "reeve/propose";
const MARKER = markerFor("propose");
const NOW = new Date("2026-08-01T00:00:00Z");
/** A warrant file with a `labels:` block a change-set can be written into. */
const WARRANT_SOURCE = "version: 1\nlabels:\n";

function cfg(over: Partial<ProposeWorkspace> = {}): ProposeWorkspace {
  return {
    name: "area:{package}",
    except: [],
    evidence: 3,
    window: 90 * 24 * 60 * 60 * 1000,
    retire: false,
    ...over,
  };
}

function warrantWith(labels: readonly Label[]): Warrant {
  const byName = new Map(labels.map((label) => [label.name, label]));
  return {
    path: PATH,
    labels,
    languages: null,
    pivot: null,
    memory: null,
    about: null,
    lifecycle: null,
    dependa: null,
    propose: cfg(),
    granted: (_duty, fallback) => fallback,
    unnamed: () => false,
    labelNamed: (name) => byName.get(name),
  };
}

function pkg(description: string): Package {
  return { name: "billing", path: "apps/billing", description };
}

function billingAtlas(description = "Billing package."): Atlas {
  return { packages: [pkg(description)], truncated: false };
}

/** Three open issues naming the package — exactly the evidence gate's floor. */
function billingIssues(): readonly Listed[] {
  return [1, 2, 3].map((number) => ({
    number,
    title: "billing",
    body: "apps/billing is involved",
    labels: [],
    createdAt: new Date("2026-06-01T00:00:00Z"),
    isPullRequest: false,
  }));
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

interface Recorder {
  /** Every write the API accepted — a rejected attempt is not one. */
  readonly writes: string[];
  /** Every write ATTEMPT, accepted or not — what a retry is counted with. */
  attempts: number;
  /** Every read of the warrant file — a retry that re-reads makes a second one. */
  reads: number;
  createdPr: { title: string; body: string } | null;
  updatedPr: number | null;
  createdRef: boolean;
  updatedRef: boolean;
}

function makeApi(opts: {
  readonly content?: string;
  readonly branchExists?: boolean;
  readonly openPrs?: readonly { number: number; body: string; headSha: string }[];
  /** Answers `repos.getCommit` with a rejection — the freshness check failing. */
  readonly commitError?: Error;
  /** One entry per write attempt: an error rejects it, `null` accepts it. */
  readonly writeOutcomes?: readonly (Error | null)[];
}): { api: ProposalsApi; recorder: Recorder } {
  const recorder: Recorder = {
    writes: [],
    attempts: 0,
    reads: 0,
    createdPr: null,
    updatedPr: null,
    createdRef: false,
    updatedRef: false,
  };
  const content = opts.content ?? WARRANT_SOURCE;
  const branches = new Map<string, string>([["main", content]]);
  if (opts.branchExists ?? false) branches.set(BRANCH, content);

  const api: ProposalsApi = {
    rest: {
      repos: {
        get: () => Promise.resolve({ data: { default_branch: "main" } }),
        getContent: (params) => {
          recorder.reads += 1;
          const held = branches.get(params.ref);
          if (held === undefined) return Promise.reject(statusError(404, "Not Found"));
          return Promise.resolve({
            data: {
              content: Buffer.from(held, "utf8").toString("base64"),
              encoding: "base64",
              sha: `${params.ref}-sha`,
            },
          });
        },
        createOrUpdateFileContents: (params) => {
          const outcome = opts.writeOutcomes?.[recorder.attempts] ?? null;
          recorder.attempts += 1;
          if (outcome !== null) return Promise.reject(outcome);
          const text = Buffer.from(params.content, "base64").toString("utf8");
          branches.set(params.branch ?? "main", text);
          recorder.writes.push(text);
          return Promise.resolve(undefined);
        },
        getCommit: () =>
          opts.commitError === undefined
            ? Promise.resolve({ data: { author: { login: "reeve[bot]", type: "Bot" } } })
            : Promise.reject(opts.commitError),
      },
      git: {
        getRef: (params) => {
          const name = params.ref.replace(/^heads\//, "");
          if (!branches.has(name)) return Promise.reject(statusError(404, "Not Found"));
          return Promise.resolve({ data: { object: { sha: `${name}-sha` } } });
        },
        createRef: (params) => {
          branches.set(params.ref.replace(/^refs\/heads\//, ""), content);
          recorder.createdRef = true;
          return Promise.resolve(undefined);
        },
        updateRef: (params) => {
          const name = params.ref.replace(/^heads\//, "");
          if (!branches.has(name)) return Promise.reject(statusError(404, "Not Found"));
          recorder.updatedRef = true;
          branches.set(name, content);
          return Promise.resolve(undefined);
        },
      },
      pulls: {
        list: ({ state }) =>
          Promise.resolve({
            data:
              state === "closed"
                ? []
                : (opts.openPrs ?? []).map((pr) => ({
                    number: pr.number,
                    body: pr.body,
                    head: { sha: pr.headSha },
                  })),
          }),
        create: (params) => {
          recorder.createdPr = { title: params.title, body: params.body };
          return Promise.resolve({ data: { number: 99 } });
        },
        update: (params) => {
          recorder.updatedPr = params.pull_number;
          return Promise.resolve(undefined);
        },
      },
    },
  };

  return { api, recorder };
}

/** One clean round, so its proposal body carries a real marker for the next one. */
async function existingProposalBody(): Promise<string> {
  const { api, recorder } = makeApi({});
  await runPropose(api, AT, warrantWith([]), false, billingAtlas(), billingIssues(), NOW, false);
  const body = recorder.createdPr?.body ?? "";
  expect(MARKER.split(body).fingerprint).not.toBeNull();
  return body;
}

/** A round against a workspace whose drift has moved on since `body` was written. */
function rerun(
  api: ProposalsApi,
  atlas: Atlas = billingAtlas("Billing package, now with more detail."),
): ReturnType<typeof runPropose> {
  return runPropose(api, AT, warrantWith([]), false, atlas, billingIssues(), NOW, false);
}

describe("a freshness check that cannot be answered", () => {
  it("leaves the branch untouched and says the check failed, not that the branch was foreign", async () => {
    // Failing open here would let a read that merely timed out authorise
    // overwriting a commit a maintainer pushed by hand. The note has to
    // distinguish the two, because they call for different responses.
    const body = await existingProposalBody();
    const { api, recorder } = makeApi({
      openPrs: [{ number: 99, body, headSha: "head-sha" }],
      branchExists: true,
      commitError: statusError(502, "Bad Gateway"),
    });

    const result = await rerun(api);

    expect(result.frozen).toBe(true);
    expect(result.pr).toBe(99);
    expect(result.notes.join("\n")).toContain("freshness could not be checked");
    expect(result.notes.join("\n")).toContain("Bad Gateway");
    expect(recorder.writes).toEqual([]);
    expect(recorder.updatedPr).toBeNull();
  });
});

describe("a write that lost a race on the file's sha", () => {
  it("re-reads and re-applies it, and the proposal still lands", async () => {
    // 409 is the Contents API's answer to two writers on one file. The
    // change-set is recomputed from the file as it now stands rather than the
    // same blind body being re-sent.
    const { api, recorder } = makeApi({
      writeOutcomes: [statusError(409, "sha does not match"), null],
    });

    const result = await runPropose(
      api,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      false,
    );

    expect(recorder.attempts).toBe(2);
    // Re-read, not re-sent: the second attempt computes its edit from the file
    // as it now stands, so a change another writer landed is not overwritten.
    expect(recorder.reads).toBe(2);
    expect(recorder.writes).toHaveLength(1);
    expect(result.pr).toBe(99);
  });

  it("reads a 422 that names the sha as the same lost race", async () => {
    // GitHub answers a stale `sha` with 422 as often as 409, and the message
    // is the only thing separating it from a validation failure.
    const { api, recorder } = makeApi({
      writeOutcomes: [statusError(422, "Validation failed: SHA does not match"), null],
    });

    const result = await runPropose(
      api,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      false,
    );

    expect(recorder.attempts).toBe(2);
    expect(result.pr).toBe(99);
  });

  it("propagates a 422 that is not a lost race rather than retrying it", async () => {
    // A protected branch, a path the token may not write: retrying is how a
    // configuration error becomes three identical failures and a green-looking
    // log. It goes red on the first one instead.
    const { api, recorder } = makeApi({
      writeOutcomes: [statusError(422, "Validation failed: branch is protected")],
    });

    await expect(
      runPropose(api, AT, warrantWith([]), false, billingAtlas(), billingIssues(), NOW, false),
    ).rejects.toThrow("branch is protected");
    expect(recorder.attempts).toBe(1);
    expect(recorder.createdPr).toBeNull();
  });

  it("gives up red against a file that never stops conflicting, rather than looping", async () => {
    const conflict = (): Error => statusError(409, "sha does not match");
    const { api, recorder } = makeApi({
      writeOutcomes: [conflict(), conflict(), conflict(), conflict()],
    });

    await expect(
      runPropose(api, AT, warrantWith([]), false, billingAtlas(), billingIssues(), NOW, false),
    ).rejects.toThrow("sha does not match");
    // Bounded: three attempts, then the failure is the runner's to see.
    expect(recorder.attempts).toBe(3);
    expect(recorder.createdPr).toBeNull();
  });
});

describe("a change-set that cannot be written into the file it was computed against", () => {
  it("abandons the proposal before any write when the file has no labels block to edit", async () => {
    // A warrant that grants duties but declares no taxonomy has nowhere for an
    // addition to go. Appending one anywhere else would rewrite a file the
    // maintainer owns into something they did not write.
    const { api, recorder } = makeApi({ content: "version: 1\nduties:\n  triage: [label]\n" });

    const result = await runPropose(
      api,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      false,
    );

    expect(result.notes.join("\n")).toContain("would not parse back cleanly");
    expect(result.notes.join("\n")).toContain("nothing was written");
    expect(recorder.writes).toEqual([]);
    expect(recorder.attempts).toBe(0);
    expect(recorder.createdPr).toBeNull();
    expect(result.pr).toBeNull();
  });
});

describe("the proposal branch across runs", () => {
  it("reuses the branch an open proposal already has instead of creating it again", async () => {
    // The update path only ensures the branch exists. Creating a ref that is
    // already there is a 422, so a rerun against a live proposal would fail on
    // the branch rather than on anything about the proposal.
    const body = await existingProposalBody();
    const { api, recorder } = makeApi({
      openPrs: [{ number: 99, body, headSha: "head-sha" }],
      branchExists: true,
    });

    const result = await rerun(api);

    expect(recorder.createdRef).toBe(false);
    expect(recorder.updatedPr).toBe(99);
    expect(result.pr).toBe(99);
  });
});
