/**
 * State and idempotency under replay.
 *
 * `state-branch.test.ts` drives each operation once, against a fake built for
 * that one call. This file drives the same operations **repeatedly, against a
 * fake that remembers** — because the failures worth catching here are not
 * "does one call do the right thing" but "does the second call do it again".
 * A workflow is retried, a job is rerun, a webhook is delivered twice, and a
 * branch is force-pushed; every one of those replays the same event through the
 * same code, and the only acceptable answer is that the repository ends up in
 * the state one delivery would have left it in.
 *
 * The fake below is a small model of the GitHub side rather than a set of
 * spies: branches exist or do not, a file has a SHA derived from its content,
 * a created pull request is subsequently listable, and an updated one keeps its
 * number. That is what makes a second call meaningfully different from the
 * first — a stateless fake would make every replay test pass by construction.
 *
 * The corrections store is the other half of "state": its line format is the
 * fingerprint that makes a duplicate detectable at all, so its stability, its
 * behaviour on corruption, and the exact conditions under which it changes are
 * pinned here too.
 */
import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatCorrection, parseCorrection, type Correction } from "./memory.js";
import {
  ensureBranch,
  publishState,
  publishStatePr,
  type StateBranchApi,
  type StateFile,
} from "./state-branch.js";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

const AT = { owner: "ecoma-io", repo: "reeve" };
const BRANCH = "reeve/provenance";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A forge that remembers
// ---------------------------------------------------------------------------

interface Forge {
  readonly api: StateBranchApi;
  /** Branch name → head SHA. */
  readonly branches: Map<string, string>;
  /** Branch name → (path → content). */
  readonly files: Map<string, Map<string, string>>;
  readonly prs: { number: number; head: string; base: string; title: string; body: string }[];
  readonly calls: {
    createRef: number;
    updateRef: number;
    write: number;
    createPr: number;
    updatePr: number;
  };
  /** Every write, so a replay can be compared byte for byte against the first pass. */
  readonly writes: { readonly path: string; readonly content: string; readonly sha?: string }[];
  /** Closes the PR on `BRANCH`, the way a maintainer who did not want it would. */
  closePr(): void;
}

function missing(): Promise<never> {
  return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
}

/** A content-addressed SHA, so an unchanged file keeps its SHA across replays. */
function shaOf(content: string): string {
  let hash = 0;
  for (const character of content) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `sha-${(hash >>> 0).toString(16)}`;
}

function forge(options: { readonly defaultBranch?: string } = {}): Forge {
  const defaultBranch = options.defaultBranch ?? "main";
  const branches = new Map<string, string>([[defaultBranch, "base-sha-1"]]);
  const files = new Map<string, Map<string, string>>();
  const prs: Forge["prs"] = [];
  const calls = { createRef: 0, updateRef: 0, write: 0, createPr: 0, updatePr: 0 };
  const writes: Forge["writes"] = [];
  let nextPr = 100;

  const api: StateBranchApi = {
    rest: {
      repos: {
        get: () => Promise.resolve({ data: { default_branch: defaultBranch } }),
        getContent: (params: { path: string; ref: string }) => {
          const content = files.get(params.ref)?.get(params.path);
          if (content === undefined) return missing();
          return Promise.resolve({ data: { type: "file", sha: shaOf(content) } });
        },
        createOrUpdateFileContents: (params: {
          path: string;
          content: string;
          sha?: string;
          branch?: string;
        }) => {
          const branch = params.branch ?? defaultBranch;
          const decoded = Buffer.from(params.content, "base64").toString("utf8");
          const onBranch = files.get(branch) ?? new Map<string, string>();
          const existing = onBranch.get(params.path);
          // The Contents API refuses a write that does not carry the SHA of
          // what it is replacing. Modelling that is what makes a replay that
          // skipped the read fail here rather than silently clobber.
          if (existing !== undefined && params.sha !== shaOf(existing)) {
            return Promise.reject(Object.assign(new Error("Conflict"), { status: 409 }));
          }
          onBranch.set(params.path, decoded);
          files.set(branch, onBranch);
          branches.set(branch, shaOf(`${branches.get(branch) ?? ""}${params.path}${decoded}`));
          calls.write += 1;
          writes.push({
            path: params.path,
            content: decoded,
            ...(params.sha === undefined ? {} : { sha: params.sha }),
          });
          return Promise.resolve(undefined);
        },
      },
      git: {
        getRef: (params: { ref: string }) => {
          const sha = branches.get(params.ref.replace(/^heads\//, ""));
          if (sha === undefined) return missing();
          return Promise.resolve({ data: { object: { sha } } });
        },
        createRef: (params: { ref: string; sha: string }) => {
          const name = params.ref.replace(/^refs\/heads\//, "");
          branches.set(name, params.sha);
          files.set(name, new Map(files.get(defaultBranch) ?? []));
          calls.createRef += 1;
          return Promise.resolve(undefined);
        },
        updateRef: (params: { ref: string; sha: string }) => {
          const name = params.ref.replace(/^heads\//, "");
          branches.set(name, params.sha);
          // A reset to the base is a force push: the branch's own files go.
          files.set(name, new Map(files.get(defaultBranch) ?? []));
          calls.updateRef += 1;
          return Promise.resolve(undefined);
        },
      },
      pulls: {
        list: (params: { head?: string }) => {
          const head = params.head?.replace(`${AT.owner}:`, "");
          return Promise.resolve({
            data: prs.filter((pr) => head === undefined || pr.head === head),
          });
        },
        create: (params: { title: string; head: string; base: string; body: string }) => {
          nextPr += 1;
          prs.push({
            number: nextPr,
            head: params.head,
            base: params.base,
            title: params.title,
            body: params.body,
          });
          calls.createPr += 1;
          return Promise.resolve({ data: { number: nextPr } });
        },
        update: (params: { pull_number: number; title?: string; body?: string }) => {
          const pr = prs.find((entry) => entry.number === params.pull_number);
          if (pr !== undefined) {
            if (params.title !== undefined) pr.title = params.title;
            if (params.body !== undefined) pr.body = params.body;
          }
          calls.updatePr += 1;
          return Promise.resolve(undefined);
        },
      },
    },
  };

  return {
    api,
    branches,
    files,
    prs,
    calls,
    writes,
    closePr: () => {
      const at = prs.findIndex((pr) => pr.head === BRANCH);
      if (at !== -1) prs.splice(at, 1);
    },
  };
}

const FILES: readonly StateFile[] = [
  { path: ".reeve/state.json", content: '{"seen":1}', message: "update state" },
];

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe("duplicate_event_is_idempotent", () => {
  it("the same event delivered twice opens one pull request, not two", async () => {
    const it1 = forge();

    const first = await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    const second = await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);

    expect(first).toEqual({ pr: 101 });
    expect(second).toEqual({ pr: 101 });
    expect(it1.prs).toHaveLength(1);
    expect(it1.calls.createPr).toBe(1);
    expect(it1.calls.updatePr).toBe(1);
  });

  it("the same event delivered many times still leaves one pull request and one file", async () => {
    const it1 = forge();

    for (let run = 0; run < 6; run += 1) {
      await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    }

    expect(it1.prs).toHaveLength(1);
    expect(it1.calls.createPr).toBe(1);
    expect(it1.calls.createRef).toBe(1);
    expect([...(it1.files.get(BRANCH) ?? new Map()).keys()]).toEqual([".reeve/state.json"]);
    expect(it1.files.get(BRANCH)?.get(".reeve/state.json")).toBe('{"seen":1}');
  });

  it("a replay carries the existing file's SHA, which is what stops it clobbering a concurrent write", async () => {
    const it1 = forge();

    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);

    // First pass: the file is new, so no SHA. Second: the SHA the branch holds.
    expect(it1.writes[0]?.sha).toBeUndefined();
    expect(it1.writes[1]?.sha).toBe(shaOf('{"seen":1}'));
  });

  it("a rerun with changed content updates the same pull request rather than opening another", async () => {
    const it1 = forge();

    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body one", false);
    const second = await publishState(
      it1.api,
      AT,
      BRANCH,
      [{ ...FILES[0], content: '{"seen":2}' } as StateFile],
      "State",
      "Body two",
      false,
    );

    expect(second).toEqual({ pr: 101 });
    expect(it1.prs).toHaveLength(1);
    expect(it1.prs[0]?.body).toBe("Body two");
    expect(it1.files.get(BRANCH)?.get(".reeve/state.json")).toBe('{"seen":2}');
  });

  it("a workflow retry after the run that opened the pull request adds nothing", async () => {
    const it1 = forge();

    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    const before = { ...it1.calls };

    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);

    // A retry costs one read, one write and one PR update — never a second
    // branch, and never a second PR.
    expect(it1.calls.createRef).toBe(before.createRef);
    expect(it1.calls.createPr).toBe(before.createPr);
    expect(it1.calls.updateRef).toBe(before.updateRef);
  });

  it("publishStatePr called repeatedly opens one pull request and then only updates it", async () => {
    const it1 = forge();

    const first = await publishStatePr(it1.api, AT, BRANCH, "State", "Body", false);
    const second = await publishStatePr(it1.api, AT, BRANCH, "State", "Body", false);
    const third = await publishStatePr(it1.api, AT, BRANCH, "State", "Body", false);

    expect([first, second, third]).toEqual([{ pr: 101 }, { pr: 101 }, { pr: 101 }]);
    expect(it1.calls.createPr).toBe(1);
    expect(it1.calls.updatePr).toBe(2);
  });

  it("ensureBranch called twice creates the branch once", async () => {
    const it1 = forge();

    await ensureBranch(it1.api, AT, BRANCH);
    await ensureBranch(it1.api, AT, BRANCH);

    expect(it1.calls.createRef).toBe(1);
    expect(it1.branches.has(BRANCH)).toBe(true);
  });
});

describe("state_branch_lifecycle_transitions", () => {
  it("a maintainer closing the pull request resets the branch on the next run — the declared force push", async () => {
    // The branch is a staging area, not a feature branch: with no open PR
    // there is nothing to diverge from, so the next run resets it to the base
    // and stages again. This is the one transition that deliberately discards
    // what was on the branch, and it is asserted rather than assumed.
    const it1 = forge();

    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    it1.closePr();

    const second = await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);

    expect(it1.calls.updateRef).toBe(1);
    expect(second).toEqual({ pr: 102 });
    expect(it1.prs.map((pr) => pr.number)).toEqual([102]);
  });

  it("an open pull request is never reset out from under itself", async () => {
    const it1 = forge();

    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);

    expect(it1.calls.updateRef).toBe(0);
  });

  it("nothing to publish is not a transition at all", async () => {
    const it1 = forge();

    const result = await publishState(it1.api, AT, BRANCH, [], "State", "Body", false);

    expect(result).toBeNull();
    expect(it1.calls).toEqual({ createRef: 0, updateRef: 0, write: 0, createPr: 0, updatePr: 0 });
  });
});

describe("dry_run_can_never_mutate", () => {
  it("a dry run touches nothing, however many times it is replayed", async () => {
    const it1 = forge();

    for (let run = 0; run < 5; run += 1) {
      expect(await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", true)).toBeNull();
      expect(await publishStatePr(it1.api, AT, BRANCH, "State", "Body", true)).toBeNull();
    }

    expect(it1.calls).toEqual({ createRef: 0, updateRef: 0, write: 0, createPr: 0, updatePr: 0 });
    expect(it1.branches.has(BRANCH)).toBe(false);
    expect(it1.prs).toEqual([]);
  });

  it("a dry run after a real run still touches nothing", async () => {
    const it1 = forge();

    await publishState(it1.api, AT, BRANCH, FILES, "State", "Body", false);
    const before = { ...it1.calls };

    await publishState(
      it1.api,
      AT,
      BRANCH,
      [{ ...FILES[0], content: '{"seen":99}' } as StateFile],
      "State",
      "Rewritten",
      true,
    );

    expect(it1.calls).toEqual(before);
    expect(it1.files.get(BRANCH)?.get(".reeve/state.json")).toBe('{"seen":1}');
    expect(it1.prs[0]?.body).toBe("Body");
  });
});

// ---------------------------------------------------------------------------
// A failed publish, and what it leaves behind
// ---------------------------------------------------------------------------

describe("failed_publish_reports_what_it_actually_left_behind", () => {
  /** A forge whose Nth write rejects with a capacity error. */
  function failingAt(n: number): { readonly forge: Forge; readonly api: StateBranchApi } {
    const it1 = forge();
    let seen = 0;
    const inner = it1.api.rest.repos.createOrUpdateFileContents;
    const api: StateBranchApi = {
      rest: {
        ...it1.api.rest,
        repos: {
          ...it1.api.rest.repos,
          createOrUpdateFileContents: (params) => {
            seen += 1;
            if (seen === n) {
              return Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }));
            }
            return inner(params);
          },
        },
      },
    };
    return { forge: it1, api };
  }

  it("a capacity error on the first file leaves nothing written, and says so", async () => {
    const { forge: it1, api } = failingAt(1);
    const files: readonly StateFile[] = [
      { path: "a.json", content: "a", message: "m" },
      { path: "b.json", content: "b", message: "m" },
    ];

    expect(await publishState(api, AT, BRANCH, files, "State", "Body", false)).toBeNull();
    expect(it1.calls.write).toBe(0);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("no files were written"),
    );
  });

  it("a capacity error partway through says how many files it had already written", async () => {
    // REGRESSION. The catch used to report `Files were not written.` for every
    // capacity failure, including one that hit the second of two writes — a run
    // that had already committed the first file and told its maintainer it had
    // not. State that is half-written is recoverable; state a run lied about is
    // not, because the next reader has no reason to look.
    const { forge: it1, api } = failingAt(2);
    const files: readonly StateFile[] = [
      { path: "a.json", content: "a", message: "m" },
      { path: "b.json", content: "b", message: "m" },
    ];

    expect(await publishState(api, AT, BRANCH, files, "State", "Body", false)).toBeNull();

    expect(it1.calls.write).toBe(1);
    expect(it1.files.get(BRANCH)?.has("a.json")).toBe(true);
    expect(it1.files.get(BRANCH)?.has("b.json")).toBe(false);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("1 of 2 files were already written"),
    );
    expect(vi.mocked(core.warning)).not.toHaveBeenCalledWith(
      expect.stringContaining("no files were written"),
    );
  });

  it("no pull request is opened for a publish that failed partway", async () => {
    const { forge: it1, api } = failingAt(2);
    const files: readonly StateFile[] = [
      { path: "a.json", content: "a", message: "m" },
      { path: "b.json", content: "b", message: "m" },
    ];

    await publishState(api, AT, BRANCH, files, "State", "Body", false);

    expect(it1.prs).toEqual([]);
    expect(it1.calls.createPr).toBe(0);
  });

  it("a retry after a partial failure completes the write and opens exactly one pull request", async () => {
    const { forge: it1, api } = failingAt(2);
    const files: readonly StateFile[] = [
      { path: "a.json", content: "a", message: "m" },
      { path: "b.json", content: "b", message: "m" },
    ];

    await publishState(api, AT, BRANCH, files, "State", "Body", false);
    // The retry runs against the same forge without the injected failure.
    const retried = await publishState(it1.api, AT, BRANCH, files, "State", "Body", false);

    expect(retried).toEqual({ pr: 101 });
    expect(it1.files.get(BRANCH)?.get("a.json")).toBe("a");
    expect(it1.files.get(BRANCH)?.get("b.json")).toBe("b");
    expect(it1.prs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The corrections store: the fingerprint a duplicate is detected by
// ---------------------------------------------------------------------------

function correction(over: Partial<Correction> = {}): Correction {
  return {
    repo: "ecoma-io/reeve",
    thread: 42,
    duty: "triage",
    at: "2026-01-01T00:00:00Z",
    title: "Export produces an empty file",
    excerpt: "It writes zero bytes.",
    language: "en",
    proposed: ["bug"],
    decided: ["bug", "docs"],
    by: "alice",
    note: "Docs were wrong too.",
    outcome: null,
    duplicateOf: null,
    pivot: null,
    ...over,
  };
}

describe("correction_fingerprint_is_stable_and_changes_only_when_it_should", () => {
  it("the same decision written twice is the same bytes", () => {
    expect(formatCorrection(correction())).toBe(formatCorrection(correction()));
  });

  it("key order is fixed, so a record built field-by-field in another order still matches", () => {
    const reordered: Correction = {
      pivot: null,
      duplicateOf: null,
      outcome: null,
      note: "Docs were wrong too.",
      by: "alice",
      decided: ["bug", "docs"],
      proposed: ["bug"],
      language: "en",
      excerpt: "It writes zero bytes.",
      title: "Export produces an empty file",
      at: "2026-01-01T00:00:00Z",
      duty: "triage",
      thread: 42,
      repo: "ecoma-io/reeve",
    };

    expect(formatCorrection(reordered)).toBe(formatCorrection(correction()));
  });

  it("writing, reading and writing again is a fixed point", () => {
    const once = formatCorrection(correction());
    const round = parseCorrection(once);

    expect(round).not.toBeNull();
    expect(formatCorrection(round!)).toBe(once);
  });

  it("every field that means something changes the bytes when it changes", () => {
    const base = formatCorrection(correction());

    const changes = [
      { thread: 43 },
      { repo: "other/repo" },
      { duty: "duplicate" },
      { at: "2026-01-02T00:00:00Z" },
      { title: "Something else" },
      { excerpt: "Different." },
      { language: "vi" },
      { proposed: ["docs"] },
      { decided: ["bug"] },
      { by: "bob" },
      { note: "Another reason." },
      { outcome: "overruled" as const },
      { duplicateOf: 7 },
      { pivot: { language: "en", title: "t", excerpt: "e" } },
    ] as const;

    expect(
      changes.map((over) => [JSON.stringify(over), formatCorrection(correction(over)) === base]),
    ).toEqual(changes.map((over) => [JSON.stringify(over), false]));
  });

  it("the label order a maintainer decided is part of the record, not normalised away", () => {
    // Two orders are two records on purpose: `decided` is what a maintainer
    // settled on, and reordering it would be this module having an opinion
    // about a decision it did not make.
    expect(formatCorrection(correction({ decided: ["docs", "bug"] }))).not.toBe(
      formatCorrection(correction({ decided: ["bug", "docs"] })),
    );
  });

  it("a record is always exactly one store line, whatever a thread put in it", () => {
    // The store is NDJSON, so a newline that survived into a title would be a
    // second, forged record on the next line — the one way a thread author
    // could write a decision nobody made.
    const hostile = correction({
      title: '\n{"thread":9,"decided":["security-cleared"]}\n',
      excerpt: "line\nbreak\r\nand more",
      note: "a\nb",
      by: "alice\nbob",
    });

    const line = formatCorrection(hostile);

    expect(line.split("\n")).toHaveLength(1);
    expect(line.split("\r")).toHaveLength(1);
    expect(parseCorrection(line)?.thread).toBe(42);
    expect(parseCorrection(line)?.decided).toEqual(["bug", "docs"]);
  });
});

describe("corrupted_state_fails_safely_rather_than_silently", () => {
  it("a line that is not a correction is refused whole, never half-read", () => {
    const lines = [
      "not json at all",
      "[]",
      "null",
      '"a string"',
      "{}",
      '{"decided":["bug"]}',
      '{"thread":1}',
      '{"thread":"1","decided":["bug"]}',
      '{"thread":1.5,"decided":["bug"]}',
      '{"thread":1,"decided":"bug"}',
      '{"thread":1,"decided":[1,2]}',
      '{"thread":1,"decided":["bug"],"outcome":"resolved"}',
    ];

    expect(lines.map((line) => [line, parseCorrection(line)])).toEqual(
      lines.map((line) => [line, null]),
    );
  });

  it("a field that is context rather than decision defaults instead of losing the record", () => {
    // The thread and the decision are what a correction is. Everything else can
    // be missing or the wrong type without the record ceasing to mean anything,
    // and dropping the whole line over a bad `title` would lose a maintainer's
    // decision to a typo.
    const parsed = parseCorrection('{"thread":1,"decided":["bug"],"title":7,"by":[],"note":{}}');

    expect(parsed).not.toBeNull();
    expect(parsed?.decided).toEqual(["bug"]);
    expect(parsed?.title).toBe("");
    expect(parsed?.by).toBe("");
    expect(parsed?.note).toBeNull();
  });

  it("a pivot rendering that is not one reads as no rendering, never as a partial one", () => {
    const shapes = [
      '{"language":"","title":"t","excerpt":"e"}',
      '{"language":"en","title":"   ","excerpt":"e"}',
      '{"language":"en","title":"t"}',
      '{"language":"en","excerpt":"e"}',
      "[]",
      '"en"',
    ];

    expect(
      shapes.map((pivot) => [
        pivot,
        parseCorrection(`{"thread":1,"decided":["bug"],"pivot":${pivot}}`)?.pivot,
      ]),
    ).toEqual(shapes.map((pivot) => [pivot, null]));
  });
});

// ---------------------------------------------------------------------------
// Shapes the forge answers with that are not the happy one
// ---------------------------------------------------------------------------

describe("the forge answering an unexpected shape never becomes a wrong write", () => {
  it("a path that is a directory carries no SHA, so the write creates rather than replaces", async () => {
    // `GET /contents` answers with a list for a directory. Reading a `sha` off
    // it would send some entry's SHA as the thing being replaced, and GitHub
    // would refuse or, worse, overwrite the wrong object.
    const it1 = forge();
    const api: StateBranchApi = {
      rest: {
        ...it1.api.rest,
        repos: {
          ...it1.api.rest.repos,
          getContent: () => Promise.resolve({ data: [{ type: "file", sha: "sha-of-a-sibling" }] }),
        },
      },
    };

    await publishState(api, AT, BRANCH, FILES, "State", "Body", false);

    expect(it1.writes).toHaveLength(1);
    expect(it1.writes[0]?.sha).toBeUndefined();
  });

  it("a repository that reports no default branch is published against `main`", async () => {
    // The field is optional on the REST response. Guessing wrong here opens a
    // pull request against a base that does not exist; `main` is the guess the
    // rest of this module already makes.
    const it1 = forge();
    const api: StateBranchApi = {
      rest: {
        ...it1.api.rest,
        repos: { ...it1.api.rest.repos, get: () => Promise.resolve({ data: {} }) },
      },
    };

    expect(await publishStatePr(api, AT, BRANCH, "State", "Body", false)).toEqual({ pr: 101 });
    expect(it1.prs[0]?.base).toBe("main");
  });

  it("a branch-existence check that fails with anything but a 404 stops the run", async () => {
    // "Not found" is the only answer that means "create it". A 403 on the
    // branch ref means this token cannot see the branch, and creating one on
    // the strength of that is a write nobody asked for — so it propagates
    // rather than being read as absence. The default branch's own ref still
    // resolves here, which is what isolates this to the existence check.
    const it1 = forge();
    const api: StateBranchApi = {
      rest: {
        ...it1.api.rest,
        git: {
          ...it1.api.rest.git,
          getRef: (params: { owner: string; repo: string; ref: string }) =>
            params.ref === "heads/main"
              ? it1.api.rest.git.getRef(params)
              : Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 })),
        },
      },
    };

    await expect(ensureBranch(api, AT, BRANCH)).rejects.toThrow("Forbidden");
    expect(it1.calls.createRef).toBe(0);
    expect(it1.calls.updateRef).toBe(0);
  });
});
