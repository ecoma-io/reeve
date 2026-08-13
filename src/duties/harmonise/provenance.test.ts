/**
 * Unit tests for the provenance module — state file management.
 */
import { describe, expect, it } from "vitest";

import { findOrCreate, markStale, markSynced, type DocumentState } from "./provenance.js";

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
