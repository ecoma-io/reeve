import { describe, expect, it } from "vitest";

import { parseRules, preflight, UnreadableRules, type Rules } from "./rules.js";

describe("parseRules", () => {
  it("parses a complete rules file", () => {
    const rules = parseRules(
      [
        "version: 1",
        "rules:",
        "  - id: no-console",
        "    name: No console calls",
        "    marker: console",
        "    body: Do not call console.",
        "    severity: critical",
        "ignore:",
        "  files:",
        "    - lockfile.json",
        "  paths:",
        "    - docs/generated/**",
        "generated:",
        "  - .lock",
        "blocked:",
        "  - phrase: TODO-FIXME",
        "    severity: critical",
        "    note: Must be resolved.",
      ].join("\n"),
    );

    expect(rules.version).toBe(1);
    expect(rules.rules).toHaveLength(1);
    expect(rules.rules[0]).toMatchObject({
      id: "no-console",
      severity: "critical",
      marker: "console",
    });
    expect(rules.ignoreFiles).toEqual(["lockfile.json"]);
    expect(rules.ignorePaths).toEqual(["docs/generated/**"]);
    expect(rules.generatedExtensions).toEqual([".lock"]);
    expect(rules.blocked).toEqual([
      { phrase: "TODO-FIXME", severity: "critical", note: "Must be resolved." },
    ]);
    expect(rules.warnings).toEqual([]);
  });

  it("falls back to defaults where the file is silent", () => {
    const rules = parseRules("version: 1");
    expect(rules.rules[0]?.id).toBe("dedup");
    expect(rules.generatedExtensions).toContain(".min.js");
    expect(rules.blocked).toEqual([]);
    expect(rules.ignoreFiles).toEqual([]);
  });

  it("drops empty and whitespace-only generated suffixes with a warning, keeping the valid ones", () => {
    // An empty suffix matches every path (`"src/a.ts".endsWith("")` is true), so
    // `generated: [""]` would silently skip the whole diff as machine-made and
    // stamp an unread diff as clean. Empty/whitespace-only is never a
    // legitimate suffix: it is dropped at the parse boundary, so `[""]` behaves
    // exactly like `generated:` (falls back to `DEFAULT_GENERATED`).
    const onlyEmpty = parseRules("version: 1\ngenerated: ['']\n");
    expect(onlyEmpty.generatedExtensions).toEqual([".min.js", ".min.css", ".map"]);
    expect(onlyEmpty.warnings).toEqual(["`generated` entry 1 is empty; dropped"]);

    const whitespace = parseRules("version: 1\ngenerated: [' ']\n");
    expect(whitespace.generatedExtensions).toEqual([".min.js", ".min.css", ".map"]);
    expect(whitespace.warnings).toEqual(["`generated` entry 1 is empty; dropped"]);

    const mixed = parseRules("version: 1\ngenerated: ['', '.lock']\n");
    expect(mixed.generatedExtensions).toEqual([".lock"]);
    expect(mixed.warnings).toEqual(["`generated` entry 1 is empty; dropped"]);
  });

  it("throws UnreadableRules on invalid YAML", () => {
    expect(() => parseRules(":not: [valid")).toThrow(UnreadableRules);
  });

  it("throws UnreadableRules when the file is not a mapping", () => {
    expect(() => parseRules("- just\n- a\n- list")).toThrow(UnreadableRules);
  });

  it("warns on unknown top-level keys and keeps the known ones", () => {
    const rules = parseRules("version: 1\nlabels: bad\n");
    expect(rules.warnings[0]).toContain("labels");
    expect(rules.version).toBe(1);
  });

  it("warns on malformed entries and drops them", () => {
    const rules = parseRules(
      "rules:\n  - 42\n  - id: ok\n    name: Fine\nblocked:\n  - 42\nversion: 7\n",
    );
    expect(rules.rules).toHaveLength(1);
    expect(rules.rules[0]?.id).toBe("ok");
    expect(rules.warnings.length).toBeGreaterThan(0);
  });

  it("treats version 1 and '1' as supported", () => {
    expect(parseRules("version: '1'").version).toBe(1);
    expect(parseRules("version: 1").version).toBe(1);
    expect(parseRules("version: 5").version).toBe(1);
  });

  it("parses a complete architecture section", () => {
    const rules = parseRules(
      [
        "version: 1",
        "architecture:",
        "  layers:",
        "    domain:",
        "      - src/domain/**",
        "    infrastructure:",
        "      - src/infra/**",
        "  edges:",
        "    - from: domain",
        "      to: infrastructure",
        "      severity: critical",
        "      note: Domain must not depend on infra.",
        "  aliases:",
        '    "@/": "src/"',
      ].join("\n"),
    );
    expect(rules.architecture).toEqual({
      layers: { domain: ["src/domain/**"], infrastructure: ["src/infra/**"] },
      edges: [
        {
          from: "domain",
          to: "infrastructure",
          severity: "critical",
          note: "Domain must not depend on infra.",
        },
      ],
      aliases: { "@/": "src/" },
    });
    expect(rules.warnings).toEqual([]);
  });

  it("treats an absent architecture section as empty", () => {
    const rules = parseRules("version: 1\nblocked:\n  - phrase: x\n");
    expect(rules.architecture).toEqual({ layers: {}, edges: [], aliases: {} });
    expect(rules.warnings).toEqual([]);
  });

  it("warns and drops malformed layers, edges, and aliases", () => {
    const rules = parseRules(
      [
        "version: 1",
        "architecture:",
        "  layers:",
        "    domain: not-a-list",
        "    infra:",
        "      - 42",
        "    ok:",
        "      - src/ok/**",
        "  edges: not-a-list",
        "  aliases:",
        '    "@/": 42',
      ].join("\n"),
    );
    expect(rules.architecture.layers).toEqual({ ok: ["src/ok/**"] });
    expect(rules.architecture.edges).toEqual([]);
    expect(rules.architecture.aliases).toEqual({});
    expect(rules.warnings.length).toBeGreaterThan(0);
  });

  it("warns and drops an edge missing from or to, and defaults severity to warning", () => {
    const rules = parseRules(
      [
        "version: 1",
        "architecture:",
        "  edges:",
        "    - to: infrastructure",
        "    - from: domain",
        "      to: infra",
        "      note: default severity",
      ].join("\n"),
    );
    expect(rules.architecture.edges).toEqual([
      { from: "domain", to: "infra", severity: "warning", note: "default severity" },
    ]);
    expect(rules.warnings).toHaveLength(1);
  });

  it("warns on an unknown severity and keeps the parsed edge at warning", () => {
    const rules = parseRules(
      [
        "version: 1",
        "architecture:",
        "  edges:",
        "    - from: a",
        "      to: b",
        "      severity: fatal",
      ].join("\n"),
    );
    expect(rules.architecture.edges[0]?.severity).toBe("warning");
    expect(rules.warnings.some((w) => w.includes("fatal"))).toBe(true);
  });

  it("warns when architecture is present but not a mapping, keeping it empty", () => {
    const rules = parseRules("version: 1\narchitecture: [not, a, mapping]\n");
    expect(rules.architecture).toEqual({ layers: {}, edges: [], aliases: {} });
    expect(rules.warnings[0]).toContain("not a mapping");
  });
});

function rulesFor(overrides: Partial<Rules> = {}): Rules {
  const base = parseRules("version: 1");
  return { ...base, ...overrides };
}

describe("preflight", () => {
  const shown = [
    {
      path: "src/a.ts",
      lines: new Map([
        [1, "const x = TODO-FIXME;"],
        [2, "fine"],
      ]),
    },
    { path: "bundle.min.js", lines: new Map([[1, "minified"]]) },
  ];

  it("flags a generated file outside the ignore list", () => {
    const findings = preflight({ shown }, rulesFor());
    expect(findings.some((f) => f.kind === "generated" && f.path === "bundle.min.js")).toBe(true);
  });

  it("does not flag a generated file the rules claim is noise", () => {
    const rules = rulesFor({ generatedExtensions: [".generated"] });
    const findings = preflight({ shown }, rules);
    expect(findings.some((f) => f.kind === "generated")).toBe(false);
  });

  it("flags a blocked phrase with the line the patch proves", () => {
    const rules = rulesFor({
      blocked: [{ phrase: "TODO-FIXME", severity: "critical" as const, note: "" }],
    });
    const findings = preflight({ shown }, rules);
    expect(findings).toContainEqual(
      expect.objectContaining({ kind: "blocked", path: "src/a.ts", line: 1 }),
    );
  });

  it("caps the same phrase per file so a vendored diff is a class, not a thousand entries", () => {
    const lines = new Map<number, string>();
    for (let i = 1; i <= 100; i += 1) lines.set(i, "x TODO-FIXME y");
    const findings = preflight(
      { shown: [{ path: "big.ts", lines }] },
      rulesFor({ blocked: [{ phrase: "TODO-FIXME", severity: "warning" as const, note: "" }] }),
    );
    expect(findings.filter((f) => f.kind === "blocked")).toHaveLength(40);
  });
});
