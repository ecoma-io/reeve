import { describe, expect, it } from "vitest";

import type { Atlas, Package } from "../../core/atlas.js";
import type { Listed } from "../../core/forge.js";
import { markerFor } from "../../core/marker.js";
import {
  parseWarrant,
  type Label,
  type ProposeWorkspace,
  type Warrant,
} from "../../core/warrant.js";

import {
  applyChangeSet,
  buildEntries,
  detectAdditions,
  detectRetirements,
  gateByEvidence,
  proposeSection,
  report,
  runPropose,
  type Entry,
  type ProposalsApi,
} from "./propose.js";

const AT = { owner: "acme", repo: "widgets" };
const PATH = ".github/reeve.yml";
const MARKER = markerFor("propose");

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

function pkg(over: Partial<Package> = {}): Package {
  return { name: "widgets", path: "packages/widgets", description: "Widgets package.", ...over };
}

function label(over: Partial<Label> = {}): Label {
  return {
    name: "area:widgets",
    description: "Widgets work.",
    not: null,
    examples: [],
    owner: null,
    exclusiveWith: [],
    confidence: null,
    paths: [],
    create: false,
    color: null,
    ...over,
  };
}

function atlasOf(packages: readonly Package[], truncated = false): Atlas {
  return { packages, truncated };
}

function issue(over: Partial<Listed> = {}): Listed {
  return {
    number: 1,
    title: "",
    body: "",
    labels: [],
    createdAt: new Date("2026-06-01T00:00:00Z"),
    isPullRequest: false,
    ...over,
  };
}

function warrantWith(labels: readonly Label[], propose?: Partial<ProposeWorkspace>): Warrant {
  const byName = new Map(labels.map((l) => [l.name, l]));
  return {
    path: PATH,
    labels,
    languages: null,
    pivot: null,
    memory: null,
    about: null,
    lifecycle: null,
    propose: cfg(propose),
    granted: (_duty, fallback) => fallback,
    unnamed: () => false,
    labelNamed: (name) => byName.get(name),
  };
}

describe("detectAdditions", () => {
  it("proposes a package the taxonomy has no label for", () => {
    const { candidates, notes } = detectAdditions(
      [],
      atlasOf([pkg({ name: "billing", path: "apps/billing" })]),
      cfg(),
    );
    expect(candidates).toEqual([
      { labelName: "area:billing", pkg: pkg({ name: "billing", path: "apps/billing" }) },
    ]);
    expect(notes).toEqual([]);
  });

  it("strips an npm scope and lowercases when building the label name", () => {
    const { candidates } = detectAdditions(
      [],
      atlasOf([pkg({ name: "@acme/Billing", path: "apps/billing" })]),
      cfg(),
    );
    expect(candidates[0]?.labelName).toBe("area:billing");
  });

  it("skips a package already covered by an existing label's paths:", () => {
    const { candidates } = detectAdditions(
      [label({ paths: ["apps/billing"] })],
      atlasOf([pkg({ name: "billing", path: "apps/billing" })]),
      cfg(),
    );
    expect(candidates).toEqual([]);
  });

  it("skips a package covered by a paths: prefix one directory up", () => {
    const { candidates } = detectAdditions(
      [label({ paths: ["apps"] })],
      atlasOf([pkg({ name: "billing", path: "apps/billing" })]),
      cfg(),
    );
    expect(candidates).toEqual([]);
  });

  it("skips a package matched by an except: glob", () => {
    const { candidates } = detectAdditions(
      [],
      atlasOf([pkg({ name: "internal-tools", path: "apps/internal-tools" })]),
      cfg({ except: ["apps/internal-*"] }),
    );
    expect(candidates).toEqual([]);
  });

  it("skips a package with no manifest description, and says why", () => {
    const { candidates, notes } = detectAdditions(
      [],
      atlasOf([pkg({ name: "billing", path: "apps/billing", description: "" })]),
      cfg(),
    );
    expect(candidates).toEqual([]);
    expect(notes[0]).toContain("no manifest description");
  });

  it("skips a computed label name longer than 50 characters, and says why", () => {
    const longName = "x".repeat(60);
    const { candidates, notes } = detectAdditions(
      [],
      atlasOf([pkg({ name: longName, path: `apps/${longName}` })]),
      cfg(),
    );
    expect(candidates).toEqual([]);
    expect(notes[0]).toContain("longer than 50 characters");
  });

  it("skips a package whose computed label name already exists in the taxonomy", () => {
    const { candidates } = detectAdditions(
      [label({ name: "area:billing" })],
      atlasOf([pkg({ name: "billing", path: "apps/billing" })]),
      cfg(),
    );
    expect(candidates).toEqual([]);
  });

  it("refuses a computed label name that could break the PR body or the marker grammar (B4.1)", () => {
    const { candidates, notes } = detectAdditions(
      [],
      atlasOf([pkg({ name: "billing --> injected", path: "apps/billing" })]),
      cfg(),
    );
    expect(candidates).toEqual([]);
    expect(notes[0]).toContain("not safe to propose");
  });

  it("refuses both candidates when two manifests compute the same label name, rather than overwriting (B4.6)", () => {
    const { candidates, notes } = detectAdditions(
      [],
      atlasOf([
        pkg({ name: "Billing", path: "apps/billing" }),
        pkg({ name: "@internal/billing", path: "services/billing" }),
      ]),
      cfg(),
    );
    expect(candidates).toEqual([]);
    expect(notes.some((n) => n.includes("would both compute the label `area:billing`"))).toBe(true);
  });
});

describe("detectRetirements", () => {
  it("proposes nothing unless retire: true", () => {
    const out = detectRetirements(
      [label({ name: "area:billing" })],
      atlasOf([]),
      cfg({ retire: false }),
    );
    expect(out).toEqual([]);
  });

  it("proposes a label whose template slot no current package fills", () => {
    const out = detectRetirements(
      [label({ name: "area:billing" })],
      atlasOf([pkg({ name: "shipping" })]),
      cfg({ retire: true }),
    );
    expect(out).toEqual([{ labelName: "area:billing" }]);
  });

  it("does not retire a label whose own paths: still cover a current package under a new name (B4.5)", () => {
    // `billing` was renamed to `billing-core` — the template-slot match on
    // the name alone would call this a removal, but the label's own
    // `paths:` claim on `apps/billing` still resolves to a real package.
    const out = detectRetirements(
      [label({ name: "area:billing", paths: ["apps/billing"] })],
      atlasOf([pkg({ name: "billing-core", path: "apps/billing" })]),
      cfg({ retire: true }),
    );
    expect(out).toEqual([]);
  });

  it("still retires a label with paths: once nothing atlas sees is covered by them", () => {
    const out = detectRetirements(
      [label({ name: "area:billing", paths: ["apps/billing"] })],
      atlasOf([pkg({ name: "shipping", path: "apps/shipping" })]),
      cfg({ retire: true }),
    );
    expect(out).toEqual([{ labelName: "area:billing" }]);
  });

  it("does not retire a label whose slot still matches a current package", () => {
    const out = detectRetirements(
      [label({ name: "area:billing" })],
      atlasOf([pkg({ name: "billing" })]),
      cfg({ retire: true }),
    );
    expect(out).toEqual([]);
  });

  it("ignores a label that does not have the naming template's shape", () => {
    const out = detectRetirements([label({ name: "bug" })], atlasOf([]), cfg({ retire: true }));
    expect(out).toEqual([]);
  });
});

describe("gateByEvidence", () => {
  const candidates = [
    { labelName: "area:billing", pkg: pkg({ name: "billing", path: "apps/billing" }) },
  ];
  const now = new Date("2026-08-01T00:00:00Z");

  it("waives the gate entirely when evidence: 0", () => {
    const out = gateByEvidence(candidates, [], cfg({ evidence: 0 }), now);
    expect(out).toEqual([{ ...candidates[0], issues: [] }]);
  });

  it("rejects a candidate short of the configured evidence count", () => {
    const issues = [issue({ number: 1, body: "apps/billing/x.ts" })];
    const out = gateByEvidence(candidates, issues, cfg({ evidence: 2 }), now);
    expect(out).toEqual([]);
  });

  it("accepts a candidate once enough distinct issues mention its path", () => {
    const issues = [
      issue({ number: 1, body: "apps/billing/x.ts" }),
      issue({ number: 2, title: "apps/billing broke" }),
    ];
    const out = gateByEvidence(candidates, issues, cfg({ evidence: 2 }), now);
    expect(out).toEqual([{ ...candidates[0], issues: [1, 2] }]);
  });

  it("excludes an issue created outside the configured window", () => {
    const issues = [
      issue({ number: 1, body: "apps/billing/x.ts", createdAt: new Date("2020-01-01T00:00:00Z") }),
      issue({ number: 2, body: "apps/billing/y.ts" }),
    ];
    const out = gateByEvidence(candidates, issues, cfg({ evidence: 2 }), now);
    expect(out).toEqual([]);
  });
});

describe("buildEntries", () => {
  it("orders additions before retirements, each block name-sorted", () => {
    const entries = buildEntries(
      [
        { labelName: "area:z", pkg: pkg({ name: "z", path: "apps/z" }), issues: [] },
        { labelName: "area:a", pkg: pkg({ name: "a", path: "apps/a" }), issues: [] },
      ],
      [{ labelName: "area:m" }, { labelName: "area:b" }],
    );
    expect(entries.map((e) => `${e.action}:${e.name}`)).toEqual([
      "add:area:a",
      "add:area:z",
      "retire:area:b",
      "retire:area:m",
    ]);
  });
});

describe("applyChangeSet", () => {
  const SOURCE =
    "version: 1\n" +
    "labels:\n" +
    "  - name: bug\n" +
    "    description: A defect.\n" +
    "  - name: area:web\n" +
    "    description: Web work.\n" +
    "    paths:\n" +
    "      - apps/web\n" +
    "capabilities:\n" +
    "  triage: [label]\n";

  it("returns null when there is no labels: block", () => {
    expect(applyChangeSet("version: 1\n", [])).toBeNull();
  });

  it("appends an addition as a minimal new item, inside the block", () => {
    const entries: readonly Entry[] = [
      {
        action: "add",
        name: "area:billing",
        description: "Billing.",
        path: "apps/billing",
        issues: [],
      },
    ];
    const edited = applyChangeSet(SOURCE, entries);
    expect(edited).not.toBeNull();
    expect(edited).toContain('"area:billing"');
    expect(edited).toContain("create: true");
  });

  it("leaves everything outside the labels: block byte-identical", () => {
    const entries: readonly Entry[] = [
      {
        action: "add",
        name: "area:billing",
        description: "Billing.",
        path: "apps/billing",
        issues: [],
      },
    ];
    const edited = applyChangeSet(SOURCE, entries) ?? "";
    expect(edited).toContain("capabilities:\n  triage: [label]");
  });

  it("removes a retired item's whole span", () => {
    const entries: readonly Entry[] = [
      { action: "retire", name: "area:web", description: "", path: "", issues: [] },
    ];
    const edited = applyChangeSet(SOURCE, entries);
    expect(edited).not.toBeNull();
    expect(edited).not.toContain("area:web");
    expect(edited).toContain("name: bug");
  });

  it("returns null when a retirement's own item cannot be found", () => {
    const entries: readonly Entry[] = [
      { action: "retire", name: "not-there", description: "", path: "", issues: [] },
    ];
    expect(applyChangeSet(SOURCE, entries)).toBeNull();
  });

  it("re-parses cleanly, keeping every field the edit did not touch", () => {
    const entries: readonly Entry[] = [
      {
        action: "add",
        name: "area:billing",
        description: "Billing.",
        path: "apps/billing",
        issues: [],
      },
    ];
    const edited = applyChangeSet(SOURCE, entries);
    expect(edited).not.toBeNull();
    const reparsed = parseWarrant(PATH, edited ?? "");
    expect(reparsed.labels.map((l) => l.name)).toEqual(["bug", "area:web", "area:billing"]);
    expect(reparsed.granted("triage", [])).toEqual(["label"]);
  });
});

interface Recorder {
  writes: { readonly content: string; readonly sha?: string }[];
  createdPr: {
    readonly title: string;
    readonly body: string;
    readonly head: string;
    readonly base: string;
  } | null;
  updatedPr: { readonly number: number; readonly title?: string; readonly body?: string } | null;
  createdRef: boolean;
  /**
   * Every `git.updateRef` call the run made — `resetBranch`'s own trace,
   * kept as a list rather than a last-write-wins field so a test can assert
   * both that the reset happened and what it moved `reeve/propose` to.
   */
  updateRefCalls: { readonly ref: string; readonly sha: string; readonly force: boolean }[];
}

const PROPOSE_BRANCH = "reeve/propose";

/** One ref's state, as this fake tracks it — the file it holds and the commit sha it names. */
interface BranchState {
  sha: string;
  content: string;
}

function notFoundError(): { status: number } & Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

/**
 * A ref-aware fake: `getContent`/`createOrUpdateFileContents` read and write
 * whichever branch the call actually named, and `reeve/propose` starts out
 * either absent or holding its own content — never silently the same object
 * as the default branch's. This is what makes a reset (or the lack of one)
 * observable at all; a fake that answered every ref with the same one string
 * could not have caught `ensureBranch` never resetting a stale branch (see
 * the "does not brick itself" test below), because a stale copy and a fresh
 * one would have looked identical to it.
 */
function makeApi(opts: {
  readonly content: string;
  readonly contentSha?: string;
  readonly defaultBranch?: string;
  readonly branchExists?: boolean;
  /**
   * What `reeve/propose` already holds, when `branchExists` is true and it
   * differs from the default branch's own current content — the stale-branch
   * scenario a reset has to overwrite. Defaults to `content`, i.e. a branch
   * indistinguishable from a freshly-created one.
   */
  readonly branchContent?: string;
  readonly branchSha?: string;
  readonly openPrs?: readonly {
    readonly number: number;
    readonly body: string;
    readonly headSha: string;
  }[];
  readonly closedPrs?: readonly {
    readonly number: number;
    readonly body: string;
    readonly merged?: boolean;
  }[];
  readonly commitAuthor?: { readonly login?: string | null; readonly type?: string | null } | null;
  readonly listClosedError?: Error;
  readonly writeError?: Error;
}): { readonly api: ProposalsApi; readonly recorder: Recorder } {
  const recorder: Recorder = {
    writes: [],
    createdPr: null,
    updatedPr: null,
    createdRef: false,
    updateRefCalls: [],
  };
  const defaultBranch = opts.defaultBranch ?? "main";
  const branches = new Map<string, BranchState>();
  branches.set(defaultBranch, { sha: "base-sha", content: opts.content });
  if (opts.branchExists ?? false) {
    branches.set(PROPOSE_BRANCH, {
      sha: opts.branchSha ?? "propose-sha",
      content: opts.branchContent ?? opts.content,
    });
  }

  const api: ProposalsApi = {
    rest: {
      repos: {
        get: () => Promise.resolve({ data: { default_branch: defaultBranch } }),
        getContent: (params) => {
          const state = branches.get(params.ref);
          if (state === undefined) return Promise.reject(notFoundError());
          return Promise.resolve({
            data: {
              content: Buffer.from(state.content, "utf8").toString("base64"),
              encoding: "base64",
              sha: opts.contentSha ?? state.sha,
            },
          });
        },
        createOrUpdateFileContents: (params) => {
          if (opts.writeError !== undefined) return Promise.reject(opts.writeError);
          const content = Buffer.from(params.content, "base64").toString("utf8");
          const ref = params.branch ?? defaultBranch;
          branches.set(ref, { sha: `${ref}-written`, content });
          recorder.writes.push({
            content,
            ...(params.sha === undefined ? {} : { sha: params.sha }),
          });
          return Promise.resolve(undefined);
        },
        getCommit: () =>
          Promise.resolve({
            data: { author: opts.commitAuthor ?? { login: "reeve[bot]", type: "Bot" } },
          }),
      },
      git: {
        getRef: (params) => {
          const name = params.ref.replace(/^heads\//, "");
          const state = branches.get(name);
          if (state === undefined) return Promise.reject(notFoundError());
          return Promise.resolve({ data: { object: { sha: state.sha } } });
        },
        createRef: (params) => {
          const name = params.ref.replace(/^refs\/heads\//, "");
          const source = branches.get(defaultBranch);
          branches.set(name, { sha: params.sha, content: source?.content ?? opts.content });
          recorder.createdRef = true;
          return Promise.resolve(undefined);
        },
        updateRef: (params) => {
          const name = params.ref.replace(/^heads\//, "");
          recorder.updateRefCalls.push({
            ref: name,
            sha: params.sha,
            force: params.force ?? false,
          });
          if (!branches.has(name)) return Promise.reject(notFoundError());
          const source = branches.get(defaultBranch);
          branches.set(name, { sha: params.sha, content: source?.content ?? opts.content });
          return Promise.resolve(undefined);
        },
      },
      pulls: {
        list: ({ state }) => {
          if (state === "closed") {
            if (opts.listClosedError !== undefined) return Promise.reject(opts.listClosedError);
            return Promise.resolve({
              data: (opts.closedPrs ?? []).map((p) => ({
                number: p.number,
                body: p.body,
                merged_at: p.merged === true ? "2026-01-01T00:00:00Z" : null,
                head: { sha: "closed-sha" },
              })),
            });
          }
          return Promise.resolve({
            data: (opts.openPrs ?? []).map((p) => ({
              number: p.number,
              body: p.body,
              head: { sha: p.headSha },
            })),
          });
        },
        create: (params) => {
          recorder.createdPr = {
            title: params.title,
            body: params.body,
            head: params.head,
            base: params.base,
          };
          return Promise.resolve({ data: { number: 99 } });
        },
        update: (params) => {
          recorder.updatedPr = {
            number: params.pull_number,
            ...(params.title === undefined ? {} : { title: params.title }),
            ...(params.body === undefined ? {} : { body: params.body }),
          };
          return Promise.resolve(undefined);
        },
      },
    },
  };

  return { api, recorder };
}

const WARRANT_SOURCE = "version: 1\nlabels:\n";
const NOW = new Date("2026-08-01T00:00:00Z");

function billingIssues(): readonly Listed[] {
  return [
    issue({ number: 1, title: "billing bug", body: "apps/billing/src/index.ts is broken" }),
    issue({ number: 2, title: "another", body: "apps/billing seen again" }),
    issue({ number: 3, title: "third", body: "apps/billing once more" }),
  ];
}

function billingAtlas(description = "Billing package."): Atlas {
  return atlasOf([pkg({ name: "billing", path: "apps/billing", description })]);
}

describe("runPropose", () => {
  it("does nothing under an implicit warrant, and says why", async () => {
    const { api } = makeApi({ content: WARRANT_SOURCE });
    const result = await runPropose(api, AT, warrantWith([]), true, atlasOf([]), [], NOW, false);
    expect(result.eligible).toBe(false);
    expect(result.pr).toBeNull();
  });

  it("reports no drift and touches nothing when the workspace matches the taxonomy", async () => {
    const { api, recorder } = makeApi({ content: WARRANT_SOURCE });
    const result = await runPropose(api, AT, warrantWith([]), false, atlasOf([]), [], NOW, false);
    expect(result.pr).toBeNull();
    expect(result.notes.some((n) => n.includes("No workspace drift"))).toBe(true);
    expect(recorder.writes).toEqual([]);
  });

  it("notes candidates that did not clear the evidence gate", async () => {
    const { api } = makeApi({ content: WARRANT_SOURCE });
    const result = await runPropose(
      api,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      [],
      NOW,
      false,
    );
    expect(result.pr).toBeNull();
    expect(result.notes.some((n) => n.includes("did not reach"))).toBe(true);
  });

  it("opens a fresh proposal PR once a drift candidate clears the evidence gate", async () => {
    const { api, recorder } = makeApi({ content: WARRANT_SOURCE, branchExists: false });
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
    expect(result.pr).toBe(99);
    expect(result.additions).toBe(1);
    expect(recorder.createdRef).toBe(true);
    expect(recorder.writes).toHaveLength(1);
    expect(recorder.writes[0]?.content).toContain("area:billing");
    expect(recorder.createdPr?.body).toContain("Package: `apps/billing`");
    expect(recorder.createdPr?.base).toBe("main");
  });

  it(
    "resets a stale reeve/propose branch to base's current content before " +
      "writing, rather than bricking itself on it forever (B1)",
    async () => {
      // `reeve/propose` still exists from an earlier, now-gone round (a PR
      // hand-closed without merging, say) and never got the `area:widgets`
      // item that has since landed on the base branch some other way. Before
      // the reset fix, `writeProposal` read this stale text, tried to remove
      // an item it does not contain, and `applyChangeSet` returned null —
      // propose reporting "would not parse back cleanly" and doing nothing,
      // every round, forever. Resetting `reeve/propose` to base's current
      // content first is what lets the retirement resolve.
      const staleBranch = WARRANT_SOURCE;
      const currentBase =
        "version: 1\nlabels:\n  - name: area:widgets\n    description: Widgets work.\n";
      const { api, recorder } = makeApi({
        content: currentBase,
        branchExists: true,
        branchContent: staleBranch,
        branchSha: "stale-sha",
      });
      const result = await runPropose(
        api,
        AT,
        warrantWith([label({ name: "area:widgets" })], { retire: true }),
        false,
        atlasOf([]),
        [],
        NOW,
        false,
      );
      expect(result.notes.some((n) => n.includes("would not parse"))).toBe(false);
      expect(result.retirements).toBe(1);
      expect(result.pr).not.toBeNull();
      expect(recorder.writes).toHaveLength(1);
      expect(recorder.writes[0]?.content).not.toContain("area:widgets");
      // The reset itself, visible in the recorder: a forced move of
      // `reeve/propose` onto the base branch's current head.
      expect(recorder.updateRefCalls).toHaveLength(1);
      expect(recorder.updateRefCalls[0]).toEqual({
        ref: PROPOSE_BRANCH,
        sha: "base-sha",
        force: true,
      });
    },
  );

  it("falls back to creating reeve/propose when a reset finds no branch to move (B1)", async () => {
    const { api, recorder } = makeApi({ content: WARRANT_SOURCE, branchExists: false });
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
    expect(result.pr).toBe(99);
    // No pre-existing ref to move — `updateRef` 404s and `resetBranch`
    // falls back to `createRef`, exactly as it does for a repository where
    // `reeve/propose` has never existed at all.
    expect(recorder.updateRefCalls).toHaveLength(1);
    expect(recorder.createdRef).toBe(true);
  });

  it("does not write anything on a dry run, but still says what it would do", async () => {
    const { api, recorder } = makeApi({ content: WARRANT_SOURCE });
    const result = await runPropose(
      api,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      true,
    );
    expect(result.dryRun).toBe(true);
    expect(result.pr).toBeNull();
    expect(recorder.writes).toEqual([]);
    expect(recorder.createdRef).toBe(false);
    expect(result.notes.some((n) => n.includes("Dry run"))).toBe(true);
  });

  it("recognises its own open proposal as unchanged, and writes nothing again", async () => {
    const { api: firstApi, recorder: firstRecorder } = makeApi({ content: WARRANT_SOURCE });
    const first = await runPropose(
      firstApi,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      false,
    );
    expect(first.pr).toBe(99);
    const body = firstRecorder.createdPr?.body ?? "";
    expect(MARKER.split(body).fingerprint).not.toBeNull();

    const { api: secondApi, recorder: secondRecorder } = makeApi({
      content: WARRANT_SOURCE,
      openPrs: [{ number: 99, body, headSha: "head-sha" }],
    });
    const second = await runPropose(
      secondApi,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      false,
    );
    expect(second.unchanged).toBe(true);
    expect(second.pr).toBe(99);
    expect(secondRecorder.writes).toEqual([]);
  });

  it("updates the open proposal when the change-set has moved on", async () => {
    const { recorder: firstRecorder } = await (async () => {
      const { api, recorder } = makeApi({ content: WARRANT_SOURCE });
      await runPropose(
        api,
        AT,
        warrantWith([]),
        false,
        billingAtlas(),
        billingIssues(),
        NOW,
        false,
      );
      return { recorder };
    })();
    const body = firstRecorder.createdPr?.body ?? "";

    const { api: secondApi, recorder: secondRecorder } = makeApi({
      content: WARRANT_SOURCE,
      openPrs: [{ number: 99, body, headSha: "head-sha" }],
      commitAuthor: { login: "reeve[bot]", type: "Bot" },
    });
    const changedAtlas = billingAtlas("Billing package, now with more detail.");
    const second = await runPropose(
      secondApi,
      AT,
      warrantWith([]),
      false,
      changedAtlas,
      billingIssues(),
      NOW,
      false,
    );
    expect(second.unchanged).toBe(false);
    expect(second.frozen).toBe(false);
    expect(second.pr).toBe(99);
    expect(secondRecorder.updatedPr?.number).toBe(99);
    expect(secondRecorder.writes).toHaveLength(1);
  });

  it("leaves a branch alone once a foreign commit lands on it", async () => {
    const { recorder: firstRecorder } = await (async () => {
      const { api, recorder } = makeApi({ content: WARRANT_SOURCE });
      await runPropose(
        api,
        AT,
        warrantWith([]),
        false,
        billingAtlas(),
        billingIssues(),
        NOW,
        false,
      );
      return { recorder };
    })();
    const body = firstRecorder.createdPr?.body ?? "";

    const { api: secondApi, recorder: secondRecorder } = makeApi({
      content: WARRANT_SOURCE,
      openPrs: [{ number: 99, body, headSha: "head-sha" }],
      commitAuthor: { login: "octocat", type: "User" },
    });
    const changedAtlas = billingAtlas("Billing package, now with more detail.");
    const second = await runPropose(
      secondApi,
      AT,
      warrantWith([]),
      false,
      changedAtlas,
      billingIssues(),
      NOW,
      false,
    );
    expect(second.frozen).toBe(true);
    expect(secondRecorder.writes).toEqual([]);
    expect(secondRecorder.updatedPr).toBeNull();
  });

  it("does not re-propose an entry a maintainer already rejected by closing its PR", async () => {
    const { recorder: firstRecorder } = await (async () => {
      const { api, recorder } = makeApi({ content: WARRANT_SOURCE });
      await runPropose(
        api,
        AT,
        warrantWith([]),
        false,
        billingAtlas(),
        billingIssues(),
        NOW,
        false,
      );
      return { recorder };
    })();
    const rejectedBody = firstRecorder.createdPr?.body ?? "";

    const { api: secondApi } = makeApi({
      content: WARRANT_SOURCE,
      closedPrs: [{ number: 99, body: rejectedBody, merged: false }],
    });
    const second = await runPropose(
      secondApi,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      false,
    );
    expect(second.pr).toBeNull();
    expect(second.struck).toBe(1);
    expect(second.notes.some((n) => n.includes("already struck"))).toBe(true);
  });

  it("does not treat a merged PR's entries as struck", async () => {
    const { recorder: firstRecorder } = await (async () => {
      const { api, recorder } = makeApi({ content: WARRANT_SOURCE });
      await runPropose(
        api,
        AT,
        warrantWith([]),
        false,
        billingAtlas(),
        billingIssues(),
        NOW,
        false,
      );
      return { recorder };
    })();
    const mergedBody = firstRecorder.createdPr?.body ?? "";

    const { api: secondApi, recorder: secondRecorder } = makeApi({
      content: WARRANT_SOURCE,
      closedPrs: [{ number: 99, body: mergedBody, merged: true }],
    });
    const second = await runPropose(
      secondApi,
      AT,
      warrantWith([]),
      false,
      billingAtlas(),
      billingIssues(),
      NOW,
      false,
    );
    expect(second.struck).toBe(0);
    expect(second.pr).toBe(99);
    expect(secondRecorder.createdPr).not.toBeNull();
  });

  it("downgrades a capacity error to a green report rather than throwing", async () => {
    const weather: { status: number } & Error = Object.assign(new Error("Service Unavailable"), {
      status: 503,
    });
    const { api } = makeApi({ content: WARRANT_SOURCE, listClosedError: weather });
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
    expect(result.eligible).toBe(true);
    expect(result.pr).toBeNull();
    expect(result.notes.some((n) => n.includes("capacity error"))).toBe(true);
  });

  it("propagates an authentication failure rather than swallowing it", async () => {
    const authFailure: { status: number } & Error = Object.assign(new Error("Forbidden"), {
      status: 403,
    });
    const { api } = makeApi({ content: WARRANT_SOURCE, listClosedError: authFailure });
    await expect(
      runPropose(api, AT, warrantWith([]), false, billingAtlas(), billingIssues(), NOW, false),
    ).rejects.toThrow(/Forbidden/);
  });

  it("proposes no retirement off a truncated atlas — a package it never saw is out of scope, not gone (B4.2)", async () => {
    const { api, recorder } = makeApi({ content: WARRANT_SOURCE });
    const result = await runPropose(
      api,
      AT,
      warrantWith([label({ name: "area:widgets" })], { retire: true }),
      false,
      { packages: [], truncated: true },
      [],
      NOW,
      false,
    );
    expect(result.retirements).toBe(0);
    expect(result.pr).toBeNull();
    expect(recorder.writes).toEqual([]);
    expect(result.notes.some((n) => n.includes("truncated"))).toBe(true);
  });
});

describe("proposeSection", () => {
  it("renders nothing when propose was never reachable this run", () => {
    expect(proposeSection(null)).toBe("");
  });

  it("renders the decline note when the warrant made propose ineligible", () => {
    const text = proposeSection(report({ eligible: false, notes: ["no explicit warrant"] }));
    expect(text).toContain("### propose");
    expect(text).toContain("no explicit warrant");
  });

  it("renders what a dry run would have done", () => {
    const text = proposeSection(
      report({ dryRun: true, notes: ["Dry run — would open a new proposal."] }),
    );
    expect(text).toContain("Dry run");
  });

  it("renders the opened proposal's number and change-set size", () => {
    const text = proposeSection(report({ notes: [], pr: 12, additions: 2, retirements: 1 }));
    expect(text).toContain("#12");
    expect(text).toContain("2 additions");
    expect(text).toContain("1 retirement");
  });

  it("says a frozen branch was left untouched", () => {
    const text = proposeSection(report({ notes: [], pr: 12, frozen: true }));
    expect(text).toContain("left untouched");
  });
});
