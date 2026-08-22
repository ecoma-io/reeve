/**
 * Unit tests for the provenance module — state file management.
 */
import { describe, expect, it, vi } from "vitest";

import { type ContentsApi } from "../../core/forge.js";
import {
  findOrCreate,
  markPartial,
  markStale,
  markSynced,
  readState,
  serialiseState,
  sharedBaseline,
  type DocumentState,
} from "./provenance.js";

const AT = { owner: "ecoma-io", repo: "reeve" };
const STATE_PATH = ".reeve/provenance/state.json";

/** The shape GitHub answers a 404 with — the one status `isMissing` treats as "not there yet". */
function notFound(): Promise<never> {
  return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
}

/** A hand-built Contents API, the same style as `forge.test.ts`'s `contentsOf`. */
function contentsOf(getContent: ReturnType<typeof vi.fn>) {
  return { rest: { repos: { getContent, createOrUpdateFileContents: vi.fn() } } } as ContentsApi;
}

function encode(text: string, sha = "default-sha") {
  return {
    data: {
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
      sha,
    },
  };
}

describe("findOrCreate", () => {
  it("creates a new document state when none exists", () => {
    const state: DocumentState[] = [];
    const files = new Map([
      ["en", "docs/guide.md"],
      ["vi", "docs/guide.vi.md"],
    ]);

    const doc = findOrCreate(state, "docs/guide", files);
    expect(doc.id).toBe("docs/guide");
    expect(doc.sourceRevision).toBe("");
    expect(doc.stale).toHaveLength(0);
    expect(doc.conflicts).toHaveLength(0);
    expect(state).toHaveLength(1);
  });

  it("returns existing document state when it exists", () => {
    const existing: DocumentState = {
      id: "docs/guide",
      files: new Map([["en", "docs/guide.md"]]),
      sourceRevision: "abc123",
      synced: new Map(),
      syncedRevision: new Map(),
      stale: [],
      conflicts: [],
    };
    const state = [existing];

    const doc = findOrCreate(state, "docs/guide", new Map());
    expect(doc).toBe(existing);
    expect(state).toHaveLength(1);
  });
});

describe("markStale", () => {
  it("marks target locales stale when source revision changes", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
      ]),
      sourceRevision: "old123",
      synced: new Map([["vi", "sha-vi-old"]]),
      syncedRevision: new Map(),
      stale: [],
      conflicts: [],
    };

    markStale(doc, "new456", new Map([["vi", "sha-vi-old"]]), "en");

    expect(doc.stale).toContain("vi");
    expect(doc.conflicts).toHaveLength(0);
    expect(doc.sourceRevision).toBe("new456");
  });

  it("detects conflicts when target has human edits", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
      ]),
      sourceRevision: "old123",
      synced: new Map([["vi", "sha-vi-old"]]),
      syncedRevision: new Map(),
      stale: [],
      conflicts: [],
    };

    // Target SHA differs from last synced — human edit
    markStale(doc, "new456", new Map([["vi", "sha-vi-human-edit"]]), "en");

    expect(doc.conflicts).toContain("vi");
    expect(doc.stale).toHaveLength(0);
  });

  it("does nothing when source revision unchanged", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
      ]),
      sourceRevision: "same123",
      synced: new Map([["vi", "sha-vi"]]),
      syncedRevision: new Map([["vi", "same123"]]),
      stale: [],
      conflicts: [],
    };

    markStale(doc, "same123", new Map([["vi", "sha-vi"]]), "en");

    expect(doc.stale).toHaveLength(0);
    expect(doc.conflicts).toHaveLength(0);
  });

  it("marks all targets stale on first run (empty source revision)", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
        ["zh", "docs/guide.zh.md"],
      ]),
      sourceRevision: "",
      synced: new Map(),
      syncedRevision: new Map(),
      stale: [],
      conflicts: [],
    };

    markStale(doc, "first123", new Map(), "en");

    expect(doc.stale).toHaveLength(2);
    expect(doc.stale).toContain("vi");
    expect(doc.stale).toContain("zh");
  });

  it("treats 'pending' synced SHA as stale (not conflict)", () => {
    // "pending" means the locale was just synced by the bot but the real file SHA
    // wasn't recorded yet. On the next run, the target file has a real SHA that
    // differs from "pending" — this is NOT a human edit, just a SHA that hasn't
    // been updated. It should be marked stale, not conflicting.
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
      ]),
      sourceRevision: "old123",
      synced: new Map([["vi", "pending"]]),
      syncedRevision: new Map(),
      stale: [],
      conflicts: [],
    };

    markStale(doc, "new456", new Map([["vi", "sha-vi-real"]]), "en");

    expect(doc.stale).toContain("vi");
    expect(doc.conflicts).toHaveLength(0);
  });

  it("detects a human edit once the real synced SHA has been recorded", () => {
    // The regression this guards: `markSynced` used to be called with the
    // literal "pending" and the real SHA from the write was never recorded —
    // so every locale stayed forever in the "pending" branch above, and a
    // human edit was pushed to `stale` and re-drafted instead of to `conflicts`
    // (D3 — human work is inviolable). Now that `publishSync` returns the
    // written SHA and `main.ts` records it, a real synced SHA means an
    // afterwards-different target SHA is a human edit, not a stale locale.
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
      ]),
      sourceRevision: "old123",
      synced: new Map(),
      syncedRevision: new Map(),
      stale: [],
      conflicts: [],
    };

    // Sync: the real SHA the write returned, replacing the "pending" placeholder.
    markSynced(doc, "vi", "sha-vi-synced", "old123");

    // The source changes next run, and a human has meanwhile edited the target.
    markStale(doc, "new456", new Map([["vi", "sha-vi-human-edit"]]), "en");

    expect(doc.conflicts).toContain("vi");
    expect(doc.stale).toHaveLength(0);
  });
});

describe("markSynced", () => {
  it("records a successful sync and removes from stale", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([["en", "docs/guide.md"]]),
      sourceRevision: "abc",
      synced: new Map(),
      syncedRevision: new Map(),
      stale: ["vi"],
      conflicts: [],
    };

    markSynced(doc, "vi", "sha-new", "abc");

    expect(doc.synced.get("vi")).toBe("sha-new");
    expect(doc.stale).toHaveLength(0);
  });

  it("removes from conflicts when synced", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([["en", "docs/guide.md"]]),
      sourceRevision: "abc",
      synced: new Map(),
      syncedRevision: new Map(),
      stale: [],
      conflicts: ["vi"],
    };

    markSynced(doc, "vi", "sha-new", "abc");

    expect(doc.conflicts).toHaveLength(0);
  });
});

describe("serialiseState", () => {
  it("serialises a document state to pretty-printed JSON", () => {
    const state: DocumentState[] = [
      {
        id: "docs/guide",
        files: new Map([["en", "docs/guide.md"]]),
        sourceRevision: "abc123",
        synced: new Map([["vi", "sha-vi"]]),
        syncedRevision: new Map([["vi", "abc123"]]),
        stale: ["zh"],
        conflicts: [],
      },
    ];

    const json = serialiseState(state);
    const parsed: unknown = JSON.parse(json);

    expect(parsed).toEqual([
      {
        id: "docs/guide",
        files: { en: "docs/guide.md" },
        sourceRevision: "abc123",
        synced: { vi: "sha-vi" },
        syncedRevision: { vi: "abc123" },
        stale: ["zh"],
        conflicts: [],
      },
    ]);
    // Pretty-printed with trailing newline
    expect(json.endsWith("\n")).toBe(true);
  });

  it("serialises an empty state as an empty array", () => {
    const json = serialiseState([]);
    expect(JSON.parse(json)).toEqual([]);
  });
});

describe("readState", () => {
  it("reads state from the default branch when the file exists there", async () => {
    const text = JSON.stringify([
      { id: "docs/guide", sourceRevision: "abc", files: {}, synced: {}, stale: [], conflicts: [] },
    ]);
    const getContent = vi.fn(() => Promise.resolve(encode(text, "sha-123")));
    const api = contentsOf(getContent);

    const result = await readState(api, AT, STATE_PATH);

    expect(result.sha).toBe("sha-123");
    expect(result.branchSha).toBeNull();
    expect(result.state).toHaveLength(1);
    expect(result.state[0]?.id).toBe("docs/guide");
  });

  it("reads a state file written before per-locale revisions as fully caught up", async () => {
    // The migration, and the reason it is not "nothing is synced": the old
    // shape carried exactly one fact — this group was last synced at this
    // revision — and reading it faithfully means every locale it recorded as
    // synced was synced there. Reading it as unknown would be safe and would
    // re-sync every locale of every document the first time a repository runs
    // this version, for no information gained.
    const text = JSON.stringify([
      {
        id: "docs/guide",
        sourceRevision: "abc",
        files: { en: "docs/guide.md", vi: "docs/guide.vi.md" },
        synced: { vi: "sha-vi" },
        stale: [],
        conflicts: [],
      },
    ]);
    const api = contentsOf(vi.fn(() => Promise.resolve(encode(text, "sha-123"))));

    const result = await readState(api, AT, STATE_PATH);

    expect(result.state[0]?.syncedRevision.get("vi")).toBe("abc");
  });

  it("prefers a per-locale revision the file actually carries over the migration reading", async () => {
    const text = JSON.stringify([
      {
        id: "docs/guide",
        sourceRevision: "rev-2",
        files: { en: "docs/guide.md", vi: "docs/guide.vi.md", zh: "docs/guide.zh.md" },
        synced: { vi: "sha-vi", zh: "sha-zh" },
        syncedRevision: { vi: "rev-2", zh: "rev-1" },
        stale: [],
        conflicts: [],
      },
    ]);
    const api = contentsOf(vi.fn(() => Promise.resolve(encode(text, "sha-123"))));

    const result = await readState(api, AT, STATE_PATH);

    expect(result.state[0]?.syncedRevision.get("vi")).toBe("rev-2");
    expect(result.state[0]?.syncedRevision.get("zh")).toBe("rev-1");
  });

  it("returns empty state when the file does not exist and no state branch is given", async () => {
    const getContent = vi.fn(notFound);
    const api = contentsOf(getContent);

    const result = await readState(api, AT, STATE_PATH);

    expect(result.state).toEqual([]);
    expect(result.sha).toBeNull();
    expect(result.branchSha).toBeNull();
  });

  it("falls back to the state branch when the file is not on the default branch", async () => {
    const branchText = JSON.stringify([
      { id: "docs/api", sourceRevision: "def", files: {}, synced: {}, stale: [], conflicts: [] },
    ]);
    const getContent = vi.fn((params: Record<string, unknown>) => {
      if (params.ref === "reeve/provenance") {
        return Promise.resolve(encode(branchText, "branch-sha-456"));
      }
      return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
    });
    const api = contentsOf(getContent);

    const result = await readState(api, AT, STATE_PATH, "reeve/provenance");

    expect(result.sha).toBeNull();
    expect(result.branchSha).toBe("branch-sha-456");
    expect(result.state).toHaveLength(1);
    expect(result.state[0]?.id).toBe("docs/api");
  });

  it("prefers the default branch over the state branch when both exist", async () => {
    const defaultText = JSON.stringify([
      {
        id: "docs/default",
        sourceRevision: "abc",
        files: {},
        synced: {},
        stale: [],
        conflicts: [],
      },
    ]);
    const branchText = JSON.stringify([
      { id: "docs/branch", sourceRevision: "def", files: {}, synced: {}, stale: [], conflicts: [] },
    ]);
    const getContent = vi.fn((params: Record<string, unknown>) => {
      if (params.ref === "reeve/provenance") {
        return Promise.resolve(encode(branchText, "branch-sha"));
      }
      // Default branch — no ref param
      return Promise.resolve(encode(defaultText, "default-sha"));
    });
    const api = contentsOf(getContent);

    const result = await readState(api, AT, STATE_PATH, "reeve/provenance");

    expect(result.sha).toBe("default-sha");
    expect(result.branchSha).toBeNull();
    expect(result.state[0]?.id).toBe("docs/default");
  });

  it("does not try the state branch when an empty string is given", async () => {
    const getContent = vi.fn(notFound);
    const api = contentsOf(getContent);

    const result = await readState(api, AT, STATE_PATH, "");

    expect(result.state).toEqual([]);
    // Only one call — for the default branch; no fallback attempt
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("throws when the state file contains malformed JSON", async () => {
    const getContent = vi.fn(() => Promise.resolve(encode("not json at all")));
    const api = contentsOf(getContent);

    await expect(readState(api, AT, STATE_PATH)).rejects.toThrow(/could not be parsed as JSON/);
  });

  it("throws when the state file is not a JSON array", async () => {
    const getContent = vi.fn(() => Promise.resolve(encode('{"id":"oops"}')));
    const api = contentsOf(getContent);

    await expect(readState(api, AT, STATE_PATH)).rejects.toThrow(/not a JSON array/);
  });

  it("returns empty state when the file is on neither branch", async () => {
    const getContent = vi.fn(notFound);
    const api = contentsOf(getContent);

    const result = await readState(api, AT, STATE_PATH, "reeve/provenance");

    expect(result.state).toEqual([]);
    expect(result.sha).toBeNull();
    expect(result.branchSha).toBeNull();
    // Two calls: default branch, then state branch
    expect(getContent).toHaveBeenCalledTimes(2);
  });
});

describe("findOrCreate folding in newly discovered locales", () => {
  it("adds a locale the stored entry has never seen", () => {
    const state: DocumentState[] = [
      {
        id: "docs/guide",
        files: new Map([
          ["en", "docs/guide.md"],
          ["vi", "docs/guide.vi.md"],
        ]),
        sourceRevision: "rev-1",
        synced: new Map([["vi", "sha-vi"]]),
        syncedRevision: new Map(),
        stale: [],
        conflicts: [],
      },
    ];

    const doc = findOrCreate(
      state,
      "docs/guide",
      new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
        ["zh", "docs/guide.zh.md"],
      ]),
    );

    expect(doc.files.get("zh")).toBe("docs/guide.zh.md");
    expect(doc.synced.get("vi")).toBe("sha-vi");
  });

  it("keeps the entry unchanged when nothing new was discovered", () => {
    const files = new Map([["en", "docs/guide.md"]]);
    const state: DocumentState[] = [
      {
        id: "docs/guide",
        files,
        sourceRevision: "rev-1",
        synced: new Map(),
        syncedRevision: new Map(),
        stale: [],
        conflicts: [],
      },
    ];

    const doc = findOrCreate(state, "docs/guide", new Map([["en", "docs/guide.md"]]));
    expect(doc.files).toBe(files);
  });
});

describe("markStale on an unchanged source", () => {
  it("marks a never-synced locale with no file stale — the bootstrap case", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
        ["zh", "docs/guide.zh.md"],
      ]),
      sourceRevision: "rev-1",
      synced: new Map([["vi", "sha-vi"]]),
      syncedRevision: new Map([["vi", "rev-1"]]),
      stale: [],
      conflicts: [],
    };

    // Source unchanged; vi exists and is synced; zh has no file and no sync.
    markStale(doc, "rev-1", new Map([["vi", "sha-vi"]]), "en");

    expect(doc.stale).toEqual(["zh"]);
    expect(doc.conflicts).toEqual([]);
  });

  it("does not resurrect a locale that was synced and then deleted", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
      ]),
      sourceRevision: "rev-1",
      synced: new Map([["vi", "sha-vi"]]),
      syncedRevision: new Map([["vi", "rev-1"]]),
      stale: [],
      conflicts: [],
    };

    // The file is gone from the tree, but its synced entry survives: a
    // maintainer deleted it, and that decision stands until the source moves.
    markStale(doc, "rev-1", new Map(), "en");

    expect(doc.stale).toEqual([]);
  });

  it("keeps a locale that missed an earlier run stale, though the source has not moved", () => {
    // The defect this pair of fields exists to fix. A run took the document to
    // `rev-2`, synced `vi` and lost `zh` — a refused draft, a roster out of
    // capacity, either way `zh` never saw the change. The group's own revision
    // advanced regardless, because `markStale` advances it before any drafting.
    //
    // Under the old shape the next run compared that one revision against the
    // tree, found them equal, and returned early: `zh` was indistinguishable
    // from a locale that had taken the change. The hunk it missed was never
    // propagated, and nothing anywhere said so.
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["vi", "docs/guide.vi.md"],
        ["zh", "docs/guide.zh.md"],
      ]),
      sourceRevision: "rev-2",
      synced: new Map([
        ["vi", "sha-vi"],
        ["zh", "sha-zh"],
      ]),
      syncedRevision: new Map([
        ["vi", "rev-2"],
        ["zh", "rev-1"],
      ]),
      stale: [],
      conflicts: [],
    };

    markStale(
      doc,
      "rev-2",
      new Map([
        ["vi", "sha-vi"],
        ["zh", "sha-zh"],
      ]),
      "en",
    );

    expect(doc.stale).toEqual(["zh"]);
    expect(doc.conflicts).toEqual([]);
  });

  it("does not double-mark a locale already stale", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([
        ["en", "docs/guide.md"],
        ["zh", "docs/guide.zh.md"],
      ]),
      sourceRevision: "rev-1",
      synced: new Map(),
      syncedRevision: new Map(),
      stale: ["zh"],
      conflicts: [],
    };

    markStale(doc, "rev-1", new Map(), "en");

    expect(doc.stale).toEqual(["zh"]);
  });
});

describe("sharedBaseline", () => {
  function doc(syncedRevision: Map<string, string>): DocumentState {
    return {
      id: "docs/guide",
      files: new Map([["en", "docs/guide.md"]]),
      sourceRevision: "rev-2",
      synced: new Map(),
      syncedRevision,
      stale: [],
      conflicts: [],
    };
  }

  it("names the revision when every locale is at the same one", () => {
    const revisions = new Map([
      ["vi", "rev-1"],
      ["zh", "rev-1"],
    ]);

    expect(sharedBaseline(doc(revisions), ["vi", "zh"])).toBe("rev-1");
  });

  it("answers null when the locales disagree, which is what a short run leaves", () => {
    // No way exists to order two blob SHAs by age — git hands out content
    // digests and nothing in them says which came first. So a caller cannot
    // pick "the older one" and has to treat the document as new, which is the
    // only reading that cannot drop a change one locale still needs.
    const revisions = new Map([
      ["vi", "rev-2"],
      ["zh", "rev-1"],
    ]);

    expect(sharedBaseline(doc(revisions), ["vi", "zh"])).toBeNull();
  });

  it("answers null for a locale with no revision at all — the cold start", () => {
    expect(sharedBaseline(doc(new Map()), ["vi"])).toBeNull();
  });
});

describe("markPartial", () => {
  it("records what was written without recording that the locale caught up", () => {
    // A draft one of whose chunks is the original text is still the better
    // file and is still published — its SHA has to be recorded or a later
    // human edit cannot be told from Reeve's own bytes. What must not be
    // recorded is a revision, or the next run diffs from a revision this
    // locale never fully saw.
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([["vi", "docs/guide.vi.md"]]),
      sourceRevision: "rev-2",
      synced: new Map(),
      syncedRevision: new Map([["vi", "rev-1"]]),
      stale: ["vi"],
      conflicts: ["vi"],
    };

    markPartial(doc, "vi", "sha-written");

    expect(doc.synced.get("vi")).toBe("sha-written");
    expect(doc.syncedRevision.get("vi")).toBe("rev-1");
    expect(doc.conflicts).toEqual([]);
    // Still behind, and still reported as such by this run.
    expect(doc.stale).toEqual(["vi"]);
  });
});
