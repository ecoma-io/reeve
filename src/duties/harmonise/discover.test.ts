/**
 * Unit tests for the discover module — locale variant discovery.
 */
import { describe, expect, it } from "vitest";

import { parseLanguages } from "../../core/languages.js";

import { discoverGroups, unmatchedFilters } from "./discover.js";

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

describe("the paths filter scopes document groups", () => {
  const FILES = [
    "README.md",
    "README.vi.md",
    "README.zh.md",
    "docs/guide.md",
    "docs/guide.vi.md",
    "docs/guide.notes.md",
    "docs/guide.notes.vi.md",
  ];

  it("an entry naming the source file keeps its whole group — variants included", () => {
    // The confirmed dogfood failure: `paths: "README.md"` used to string-prefix
    // raw files, silently dropping README.vi.md / README.zh.md and with them
    // the entire group, green.
    const groups = discoverGroups(FILES, SOURCE_LANGUAGE, TARGET_LANGUAGES, ["README.md"]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.get("vi")).toBe("README.vi.md");
    expect(groups[0]!.files.get("zh")).toBe("README.zh.md");
  });

  it("an entry naming a locale file keeps the whole group, source included", () => {
    // A group cannot be half-synced — a variant without its source is
    // undefined. Restricting which locales sync is `languages:`'s job.
    const groups = discoverGroups(FILES, SOURCE_LANGUAGE, TARGET_LANGUAGES, ["README.vi.md"]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.get("en")).toBe("README.md");
    expect(groups[0]!.files.get("zh")).toBe("README.zh.md");
  });

  it("an entry naming a file does not select a sibling group with a longer base", () => {
    const groups = discoverGroups(FILES, SOURCE_LANGUAGE, TARGET_LANGUAGES, ["docs/guide.md"]);

    expect(groups.map((g) => g.id)).toEqual(["docs/guide"]);
  });

  it("a directory entry keeps its prefix semantics unchanged", () => {
    const groups = discoverGroups(FILES, SOURCE_LANGUAGE, TARGET_LANGUAGES, ["docs/"]);

    expect(groups.map((g) => g.id).sort()).toEqual(["docs/guide", "docs/guide.notes"]);
  });

  it("matching stays case-sensitive — a wrong-case entry selects nothing", () => {
    const groups = discoverGroups(FILES, SOURCE_LANGUAGE, TARGET_LANGUAGES, ["readme.md"]);

    expect(groups).toHaveLength(0);
  });
});

describe("unmatchedFilters", () => {
  const FILES = ["README.md", "README.vi.md"];

  it("names the entries that selected no group", () => {
    const groups = discoverGroups(FILES, SOURCE_LANGUAGE, TARGET_LANGUAGES, [
      "README.md",
      "docs/missing.md",
      "readme.md",
    ]);

    expect(unmatchedFilters(groups, ["README.md", "docs/missing.md", "readme.md"])).toEqual([
      "docs/missing.md",
      "readme.md",
    ]);
  });

  it("is empty when every entry selected a group, and for an empty filter", () => {
    const groups = discoverGroups(FILES, SOURCE_LANGUAGE, TARGET_LANGUAGES, ["README.md"]);

    expect(unmatchedFilters(groups, ["README.md"])).toEqual([]);
    expect(unmatchedFilters(groups, [])).toEqual([]);
  });
});

describe("discoverGroups with bootstrap", () => {
  it("keeps a source-only group and derives the missing locale paths", () => {
    const groups = discoverGroups(["docs/guide.md"], SOURCE_LANGUAGE, TARGET_LANGUAGES, [], true);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.get("en")).toBe("docs/guide.md");
    expect(groups[0]!.files.get("vi")).toBe("docs/guide.vi.md");
    expect(groups[0]!.files.get("zh")).toBe("docs/guide.zh.md");
  });

  it("fills only the missing locales of a partially translated group", () => {
    const groups = discoverGroups(
      ["docs/guide.md", "docs/guide.vi.md"],
      SOURCE_LANGUAGE,
      TARGET_LANGUAGES,
      [],
      true,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.get("vi")).toBe("docs/guide.vi.md");
    expect(groups[0]!.files.get("zh")).toBe("docs/guide.zh.md");
  });

  it("derives paths in the locale's own case, matching the suffix convention", () => {
    const hans = parseLanguages("zh-Hans");
    const groups = discoverGroups(["docs/guide.md"], SOURCE_LANGUAGE, hans, [], true);

    expect(groups[0]!.files.get("zh-hans")).toBe("docs/guide.zh-Hans.md");
  });

  it("still requires a source file", () => {
    const groups = discoverGroups(
      ["docs/guide.vi.md"],
      SOURCE_LANGUAGE,
      TARGET_LANGUAGES,
      [],
      true,
    );
    expect(groups).toHaveLength(0);
  });

  it("still honours the paths filter", () => {
    const groups = discoverGroups(
      ["docs/guide.md", "README.md"],
      SOURCE_LANGUAGE,
      TARGET_LANGUAGES,
      ["docs/"],
      true,
    );
    expect(groups.map((g) => g.id)).toEqual(["docs/guide"]);
  });

  it("changes nothing when bootstrap is off — the documented contract", () => {
    const groups = discoverGroups(["docs/guide.md"], SOURCE_LANGUAGE, TARGET_LANGUAGES, [], false);
    expect(groups).toHaveLength(0);
  });

  it("lets a filter entry name a file the sync is about to create", () => {
    // Derived paths are members before the filter runs — the filter is the
    // last gate, so scoping by the missing variant's path selects the group.
    const groups = discoverGroups(
      ["docs/guide.md"],
      SOURCE_LANGUAGE,
      TARGET_LANGUAGES,
      ["docs/guide.vi.md"],
      true,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.get("vi")).toBe("docs/guide.vi.md");
  });

  it("a source-file entry keeps a bootstrap group whole, derived paths included", () => {
    const groups = discoverGroups(
      ["docs/guide.md"],
      SOURCE_LANGUAGE,
      TARGET_LANGUAGES,
      ["docs/guide.md"],
      true,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.files.get("zh")).toBe("docs/guide.zh.md");
  });
});
