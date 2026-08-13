/**
 * Unit tests for the discover module — locale variant discovery.
 */
import { describe, expect, it } from "vitest";

import { parseLanguages } from "../../core/languages.js";

import { discoverGroups } from "./discover.js";

const SOURCE_LANGUAGE = parseLanguages("en")[0]!;
const TARGET_LANGUAGES = parseLanguages("vi, zh");

describe("discoverGroups", () => {
  it("groups source and locale files by base name", () => {
    const paths = [
      "docs/getting-started.md",
      "docs/getting-started.vi.md",
      "docs/getting-started.zh.md",
    ];

    const groups = discoverGroups(paths, SOURCE_LANGUAGE, TARGET_LANGUAGES, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("docs/getting-started");
    expect(groups[0]!.files.get("en")).toBe("docs/getting-started.md");
    expect(groups[0]!.files.get("vi")).toBe("docs/getting-started.vi.md");
    expect(groups[0]!.files.get("zh")).toBe("docs/getting-started.zh.md");
  });

  it("groups root-level files", () => {
    const paths = ["README.md", "README.vi.md"];

    const groups = discoverGroups(paths, SOURCE_LANGUAGE, TARGET_LANGUAGES, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("README");
    expect(groups[0]!.files.get("en")).toBe("README.md");
    expect(groups[0]!.files.get("vi")).toBe("README.vi.md");
  });

  it("skips locale variants not in the configured target languages", () => {
    const paths = [
      "docs/guide.md",
      "docs/guide.vi.md",
      "docs/guide.fr.md", // fr not configured
    ];

    const groups = discoverGroups(paths, SOURCE_LANGUAGE, TARGET_LANGUAGES, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.has("fr")).toBe(false);
  });

  it("skips groups with no source file", () => {
    const paths = ["docs/guide.vi.md"]; // No source (en) file

    const groups = discoverGroups(paths, SOURCE_LANGUAGE, TARGET_LANGUAGES, []);
    expect(groups).toHaveLength(0);
  });

  it("returns empty when no target languages configured", () => {
    const groups = discoverGroups(["docs/guide.md"], SOURCE_LANGUAGE, [], []);
    expect(groups).toHaveLength(0);
  });

  it("scopes to paths filter when provided", () => {
    const paths = ["docs/guide.md", "docs/guide.vi.md", "README.md", "README.vi.md"];

    const groups = discoverGroups(paths, SOURCE_LANGUAGE, TARGET_LANGUAGES, ["docs/"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("docs/guide");
  });

  it("ignores non-markdown files", () => {
    const paths = ["docs/guide.md", "docs/guide.vi.md", "docs/guide.ts"];

    const groups = discoverGroups(paths, SOURCE_LANGUAGE, TARGET_LANGUAGES, []);
    expect(groups).toHaveLength(1);
  });

  it("handles multiple document groups", () => {
    const paths = ["docs/a.md", "docs/a.vi.md", "docs/b.md", "docs/b.vi.md", "docs/b.zh.md"];

    const groups = discoverGroups(paths, SOURCE_LANGUAGE, TARGET_LANGUAGES, []);
    expect(groups).toHaveLength(2);
  });
});
