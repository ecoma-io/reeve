/**
 * Unit tests for the provenance module — state file management.
 */
import { describe, expect, it, vi } from "vitest";

import { type ContentsApi } from "../../core/forge.js";
import {
  findOrCreate,
  markStale,
  markSynced,
  readState,
  serialiseState,
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
      stale: [],
      conflicts: [],
    };

    markStale(doc, "new456", new Map([["vi", "sha-vi-real"]]), "en");

    expect(doc.stale).toContain("vi");
    expect(doc.conflicts).toHaveLength(0);
  });
});

describe("markSynced", () => {
  it("records a successful sync and removes from stale", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([["en", "docs/guide.md"]]),
      sourceRevision: "abc",
      synced: new Map(),
      stale: ["vi"],
      conflicts: [],
    };

    markSynced(doc, "vi", "sha-new");

    expect(doc.synced.get("vi")).toBe("sha-new");
    expect(doc.stale).toHaveLength(0);
  });

  it("removes from conflicts when synced", () => {
    const doc: DocumentState = {
      id: "docs/guide",
      files: new Map([["en", "docs/guide.md"]]),
      sourceRevision: "abc",
      synced: new Map(),
      stale: [],
      conflicts: ["vi"],
    };

    markSynced(doc, "vi", "sha-new");

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
