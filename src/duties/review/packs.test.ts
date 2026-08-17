import { describe, expect, it } from "vitest";

import { MAX_PACK_CHARS, UnreadablePacks, parsePack, type Pack } from "./packs.js";
import { composeRules, parseRules, readPackRefs, type PackRef } from "./rules.js";

/** Builds a pack with a `fragment` of the given shape. */
function packFor(fragment: Partial<Pack["fragment"]> = {}): Pack {
  return {
    ref: "test/pack@1.0",
    version: { major: 1, minor: 0 },
    fragment: {
      rules: [],
      ignoreFiles: [],
      ignorePaths: [],
      generatedExtensions: [],
      blocked: [],
      ...fragment,
    },
    raw: "",
    warnings: [],
  };
}

describe("parsePack", () => {
  it("parses a full pack file", () => {
    const pack = parsePack(
      [
        "name: Go concurrency",
        "description: Concurrency rules.",
        "version: 1.2",
        "rules:",
        "  - id: goroutine-leak",
        "    name: Unbounded goroutine",
        "    marker: goroutine",
        "    body: Flag a goroutine spawned without a bound.",
        "    severity: warning",
        "ignore:",
        "  files: [vendor/gorums.md]",
        "  paths: ['**/generated/**']",
        "generated: ['.pb.go']",
        "blocked:",
        "  - phrase: TODO-FIXME",
        "    severity: critical",
      ].join("\n"),
      "go/concurrency@1.2",
    );

    expect(pack.version).toEqual({ major: 1, minor: 2 });
    expect(pack.fragment.rules).toHaveLength(1);
    expect(pack.fragment.rules[0]?.id).toBe("goroutine-leak");
    expect(pack.fragment.ignoreFiles).toEqual(["vendor/gorums.md"]);
    expect(pack.fragment.ignorePaths).toEqual(["**/generated/**"]);
    expect(pack.fragment.generatedExtensions).toEqual([".pb.go"]);
    expect(pack.fragment.blocked).toEqual([
      { phrase: "TODO-FIXME", severity: "critical", note: "" },
    ]);
    expect(pack.warnings).toEqual([]);
  });

  it("accepts version 1, 1.0 and '1.0' mean the same two-component version", () => {
    expect(parsePack("version: 1\n", "x/y").version).toEqual({ major: 1, minor: 0 });
    expect(parsePack("version: 1.0\n", "x/y").version).toEqual({ major: 1, minor: 0 });
    expect(parsePack("version: '1.0'\n", "x/y").version).toEqual({ major: 1, minor: 0 });
  });

  it("keeps a trailing-zero minor — 1.10 stays 1.10, never YAML's 1.1", () => {
    expect(parsePack("version: 1.10\n", "x/y").version).toEqual({ major: 1, minor: 10 });
    expect(parsePack('version: "1.10"\n', "x/y").version).toEqual({ major: 1, minor: 10 });
  });

  it("accepts a pack without a version (unpinned references tolerate it)", () => {
    expect(parsePack("rules: []\n", "x/y").version).toBeNull();
  });

  it("refuses a three-part version", () => {
    expect(() => parsePack("version: 1.2.3\n", "x/y")).toThrow(UnreadablePacks);
  });

  it("refuses an unknown top-level key, naming it and quoting D2", () => {
    expect(() => parsePack("duties:\n  review: [comment]\n", "evil/pack")).toThrow(/`duties`/);
    expect(() => parsePack("duties:\n  review: [comment]\n", "evil/pack")).toThrow(
      /cannot grant authority.*D2|D2.*cannot grant authority/,
    );
  });

  it("refuses every non-policy top-level key", () => {
    for (const key of ["capabilities", "warrant", "labels", "packs"]) {
      expect(() => parsePack(`${key}: []\n`, "x/y")).toThrow(UnreadablePacks);
    }
  });

  it("refuses a YAML alias or merge key via maxAliasCount: 0", () => {
    expect(() => parsePack("a: &x 1\nb: *x\n", "x/y")).toThrow(UnreadablePacks);
    expect(() => parsePack("base: &b {x: 1}\nderived:\n  <<: *b\n", "x/y")).toThrow(
      UnreadablePacks,
    );
  });

  it("throws UnreadablePacks on invalid YAML and on a non-mapping", () => {
    expect(() => parsePack(":not: [valid", "x/y")).toThrow(UnreadablePacks);
    expect(() => parsePack("- just\n- a\n- list", "x/y")).toThrow(UnreadablePacks);
  });

  it("warns on malformed sub-entries and drops them", () => {
    const pack = parsePack(
      "rules:\n  - 42\n  - id: ok\n    name: Fine\nblocked:\n  - {phrase: x, severity: bogus}\n",
      "x/y",
    );
    expect(pack.fragment.rules).toHaveLength(1);
    expect(pack.fragment.rules[0]?.id).toBe("ok");
    expect(pack.warnings.length).toBeGreaterThan(0);
  });
});

describe("readPackRefs", () => {
  it("parses unpinned, major-pinned and exact-pinned references", () => {
    const { refs } = readPackRefs([
      { pack: "go/concurrency" },
      { pack: "security/owasp@1" },
      { pack: "typescript/safety@1.2" },
    ]);
    expect(refs).toEqual<readonly PackRef[]>([
      { namespace: "go", name: "concurrency", major: null, minor: null, raw: "go/concurrency" },
      { namespace: "security", name: "owasp", major: 1, minor: null, raw: "security/owasp@1" },
      { namespace: "typescript", name: "safety", major: 1, minor: 2, raw: "typescript/safety@1.2" },
    ]);
  });

  it("fails red on a reference outside the grammar", () => {
    for (const bad of ["../x/y", "a/b/c", "UPPER/lower", "a/b.yml", "a@1/b", "a/b@", "a//b@1.2"]) {
      expect(() => readPackRefs([{ pack: bad }])).toThrow(UnreadablePacks);
    }
  });

  it("dedupes duplicate references with a warning", () => {
    const { refs, warnings } = readPackRefs([{ pack: "a/b" }, { pack: "a/b" }]);
    expect(refs).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("fails red when packs is not a list or entries lack a pack key", () => {
    expect(() => readPackRefs("not a list")).toThrow(UnreadablePacks);
    expect(() => readPackRefs([{ rules: [] }])).toThrow(UnreadablePacks);
  });
});

describe("composeRules", () => {
  it("keeps the local rules file authoritative over pack rules by id", () => {
    const local = parseRules(
      [
        "version: 1",
        "rules:",
        "  - id: dedup",
        "    name: Local dedup",
        "    body: Repeated code.",
        "  - id: local-only",
        "    name: Local",
        "    body: Local only.",
      ].join("\n"),
    );
    const packs: Pack[] = [
      packFor({
        rules: [
          {
            id: "dedup",
            name: "Pack dedup",
            body: "From pack.",
            severity: "warning",
            marker: "",
          },
          { id: "pack-only", name: "Pack", body: "Pack only.", severity: "info", marker: "" },
        ],
      }),
    ];
    const composed = composeRules(local, packs);

    expect(composed.rules.map((r) => r.id)).toEqual(["dedup", "local-only", "pack-only"]);
    expect(composed.rules[0]?.name).toBe("Local dedup");
    expect(composed.warnings.some((w) => w.includes("dedup"))).toBe(true);
  });

  it("gives pack[0] precedence over pack[1] when they disagree", () => {
    const local = parseRules("version: 1\nrules: []\n");
    const packs: Pack[] = [
      packFor({
        rules: [
          {
            id: "shared",
            name: "First pack",
            body: "First wins.",
            severity: "warning",
            marker: "",
          },
        ],
      }),
      packFor({
        rules: [
          {
            id: "shared",
            name: "Second pack",
            body: "Second loses.",
            severity: "info",
            marker: "",
          },
        ],
      }),
    ];
    const composed = composeRules(local, packs);

    expect(composed.rules.find((r) => r.id === "shared")?.name).toBe("First pack");
    expect(composed.warnings.some((w) => w.includes("shared"))).toBe(true);
  });

  it("includes the built-in dedup rule only when no source wrote a rules list", () => {
    const empty = parseRules("version: 1");
    expect(composeRules(empty, []).rules.map((r) => r.id)).toEqual(["dedup"]);

    // A pack that contributes rules replaces the bare pool — dedup is not
    // auto-included.
    const withPack = composeRules(empty, [
      packFor({
        rules: [
          { id: "goroutine", name: "Goroutine", body: "B.", severity: "warning", marker: "" },
        ],
      }),
    ]);
    expect(withPack.rules.map((r) => r.id)).toEqual(["goroutine"]);
  });

  it("unions ignore files, ignore paths, generated and blocked, first-wins per phrase", () => {
    const local = parseRules(
      [
        "version: 1",
        "ignore:",
        "  files: [local.md]",
        "  paths: ['local/**']",
        "generated: ['.local']",
        "blocked:",
        "  - {phrase: shared, severity: info, note: local}",
        "  - {phrase: local-only, severity: warning, note: ''}",
      ].join("\n"),
    );
    const packs: Pack[] = [
      packFor({
        ignoreFiles: ["pack.md"],
        ignorePaths: ["pack/**"],
        generatedExtensions: [".pack", ".local"],
        blocked: [{ phrase: "shared", severity: "critical", note: "pack", phrase2: "" } as never],
      }),
    ];
    const composed = composeRules(local, packs);

    expect(composed.ignoreFiles).toEqual(["local.md", "pack.md"]);
    expect(composed.ignorePaths).toEqual(["local/**", "pack/**"]);
    expect(composed.generatedExtensions).toContain(".local");
    expect(composed.generatedExtensions).toContain(".pack");
    const shared = composed.blocked.find((b) => b.phrase === "shared");
    expect(shared?.severity).toBe("info");
    expect(composed.blocked.length).toBe(2);
  });

  it("with zero packs reproduces today's composition exactly", () => {
    const local = parseRules(
      "version: 1\nignore:\n  paths: ['vendor/**']\ngenerated: ['.gen']\nblocked:\n  - phrase: TODO\n",
    );
    const composed = composeRules(local, []);
    expect(composed).toEqual(local);
  });

  it("carries local warnings and prefixes pack warnings with the pack's ref", () => {
    const local = parseRules("version: 1\nbogusKey: x\n");
    const packs: Pack[] = [
      {
        ref: "go/concurrency",
        version: { major: 1, minor: 0 },
        fragment: {
          rules: [],
          ignoreFiles: [],
          ignorePaths: [],
          generatedExtensions: [],
          blocked: [],
        },
        raw: "",
        warnings: ["go/concurrency: rule entry 1 is not a mapping; dropped"],
      },
    ];
    const composed = composeRules(local, packs);
    expect(composed.warnings.some((w) => w.includes("bogusKey"))).toBe(true);
    expect(composed.warnings.some((w) => w.includes("go/concurrency"))).toBe(true);
  });

  it("keeps dedup when the local rules list is explicit and packs add nothing", () => {
    const local = parseRules("version: 1\nrules:\n  - id: dedup\n    name: R\n    body: B\n");
    const composed = composeRules(local, []);
    expect(composed.rules.map((r) => r.id)).toEqual(["dedup"]);
    expect(composed.warnings).toEqual([]);
  });
});

describe("parseRules packs key", () => {
  it("records pack references on the Rules object", () => {
    const rules = parseRules(["version: 1", "packs:", "  - pack: go/concurrency@1.2"].join("\n"));
    expect(rules.packRefs).toHaveLength(1);
    expect(rules.packRefs[0]?.raw).toBe("go/concurrency@1.2");
  });

  it("treats an absent packs key as a no-op", () => {
    const rules = parseRules("version: 1");
    expect(rules.packRefs).toEqual([]);
  });
});

describe("MAX_PACK_CHARS", () => {
  it("is a documented cap", () => {
    expect(MAX_PACK_CHARS).toBe(8_000);
  });
});
