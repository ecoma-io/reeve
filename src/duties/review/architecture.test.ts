import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  architectureFindings,
  assess,
  emptyArchitecture,
  extractEdges,
  MAX_ARCH_FINDINGS,
  resolveTarget,
  type Architecture,
} from "./architecture.js";

// `@actions/core` is stubbed so the cap warning can be asserted without
// writing workflow commands to this worker's stdout.
vi.mock("@actions/core", () => ({
  warning: vi.fn(),
}));
import * as core from "@actions/core";

beforeEach(() => {
  vi.clearAllMocks();
});

/** A file-shaped snapshot entry for `extractEdges`. */
function file(path: string, lines: Readonly<Record<number, string>>) {
  return { path, lines: new Map(Object.entries(lines).map(([n, t]) => [Number(n), t])) };
}

const NO_ALIASES: Readonly<Record<string, string>> = {};

describe("extractEdges", () => {
  it("extracts the ESM import forms with their kinds and line numbers", () => {
    const edges = extractEdges(
      file("src/a.ts", {
        1: `import x from "./a";`,
        2: `import * as ns from "./b";`,
        3: `import {a, b} from "./c";`,
        4: `import "side-effect";`,
        5: `import type {T} from "./d";`,
        6: `import type X from "./e";`,
      }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      { fromFile: "src/a.ts", line: 1, specifier: "./a", kind: "import", target: "src/a" },
      { fromFile: "src/a.ts", line: 2, specifier: "./b", kind: "import", target: "src/b" },
      { fromFile: "src/a.ts", line: 3, specifier: "./c", kind: "import", target: "src/c" },
      { fromFile: "src/a.ts", line: 4, specifier: "side-effect", kind: "import", target: null },
      { fromFile: "src/a.ts", line: 5, specifier: "./d", kind: "type", target: "src/d" },
      { fromFile: "src/a.ts", line: 6, specifier: "./e", kind: "type", target: "src/e" },
    ]);
  });

  it("extracts export-from clauses as export edges", () => {
    const edges = extractEdges(
      file("src/b.ts", { 1: `export {x} from "./f";`, 2: `export * from "./g";` }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      { fromFile: "src/b.ts", line: 1, specifier: "./f", kind: "export", target: "src/f" },
      { fromFile: "src/b.ts", line: 2, specifier: "./g", kind: "export", target: "src/g" },
    ]);
  });

  it("extracts dynamic imports, capturing only the first string argument", () => {
    const edges = extractEdges(
      file("src/c.ts", {
        1: `const m = import("./h");`,
        2: `await import("./i");`,
        3: `import("./j", {assert: {type: "json"}});`,
      }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      { fromFile: "src/c.ts", line: 1, specifier: "./h", kind: "dynamic", target: "src/h" },
      { fromFile: "src/c.ts", line: 2, specifier: "./i", kind: "dynamic", target: "src/i" },
      { fromFile: "src/c.ts", line: 3, specifier: "./j", kind: "dynamic", target: "src/j" },
    ]);
  });

  it("extracts CJS require and require.resolve", () => {
    const edges = extractEdges(
      file("src/d.ts", { 1: `const x = require("./k");`, 2: `require.resolve("./l");` }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      { fromFile: "src/d.ts", line: 1, specifier: "./k", kind: "require", target: "src/k" },
      { fromFile: "src/d.ts", line: 2, specifier: "./l", kind: "require", target: "src/l" },
    ]);
  });

  it("extracts the import from a multiline import's from-clause line", () => {
    const edges = extractEdges(
      file("src/e.ts", {
        1: `import {`,
        2: `  a,`,
        3: `} from "./m";`,
      }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      { fromFile: "src/e.ts", line: 3, specifier: "./m", kind: "import", target: "src/m" },
    ]);
  });

  it("does not extract imports that live inside strings, templates, comments, or prose", () => {
    const edges = extractEdges(
      file("src/f.ts", {
        1: `const s = "import x from './fake';";`,
        2: `// import x from "./comment"`,
        3: `/* import x from "./c2" */`,
        4: 'const code = `import x from "./t"`;',
        5: `import of this file is 5`,
        6: `const s2 = "require('./fake')";`,
        7: `/// <reference path="./x" />`,
        8: `declare module "./ambient"`,
      }),
      NO_ALIASES,
    );

    const lines = edges.map((edge) => edge.line).sort((a, b) => a - b);
    expect(lines).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("extracts each of two imports on one line with the same proven line", () => {
    const edges = extractEdges(
      file("src/g.ts", { 1: `import a from "./x"; import b from "./y";` }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      { fromFile: "src/g.ts", line: 1, specifier: "./x", kind: "import", target: "src/x" },
      { fromFile: "src/g.ts", line: 1, specifier: "./y", kind: "import", target: "src/y" },
    ]);
  });

  it("extracts a dynamic import with a second argument as a dynamic edge", () => {
    const edges = extractEdges(
      file("src/h.ts", { 1: `import("./not-really", {with: {type: "json"}});` }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      {
        fromFile: "src/h.ts",
        line: 1,
        specifier: "./not-really",
        kind: "dynamic",
        target: "src/not-really",
      },
    ]);
  });

  it("never extracts an interior line of a plain multi-line block comment", () => {
    const edges = extractEdges(
      file("src/domain/svc.ts", {
        1: "/*",
        2: '   import "./infra/db" is forbidden here',
        3: "   and the line carries no comment marker of its own",
        4: "*/",
        5: "export function run(): void {}",
      }),
      NO_ALIASES,
    );
    expect(edges).toEqual([]);
  });

  it("keeps extracting after a closed multi-line block comment", () => {
    const edges = extractEdges(
      file("src/domain/svc.ts", {
        1: "/*",
        2: '   import "./infra/db" is forbidden here',
        3: "*/",
        4: `import real from "./ok";`,
      }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      {
        fromFile: "src/domain/svc.ts",
        line: 4,
        specifier: "./ok",
        kind: "import",
        target: "src/domain/ok",
      },
    ]);
  });

  it("skips a block comment opened and closed on one line but keeps the code after it", () => {
    const edges = extractEdges(
      file("src/domain/svc.ts", { 1: `/* note */ import real from "./ok";` }),
      NO_ALIASES,
    );
    expect(edges).toEqual([
      {
        fromFile: "src/domain/svc.ts",
        line: 1,
        specifier: "./ok",
        kind: "import",
        target: "src/domain/ok",
      },
    ]);
  });
});

describe("resolveTarget", () => {
  it("resolves relative specifiers against the importing file's directory", () => {
    expect(resolveTarget("src/domain/svc.ts", "./a", NO_ALIASES)).toBe("src/domain/a");
    expect(resolveTarget("src/domain/svc.ts", "../shared/x", NO_ALIASES)).toBe("src/shared/x");
    expect(resolveTarget("src/domain/x", "../../outside", NO_ALIASES)).toBe("outside");
  });

  it("returns null when a relative path escapes above the repository root", () => {
    expect(resolveTarget("a.ts", "../../x", NO_ALIASES)).toBeNull();
  });

  it("applies the longest matching alias prefix first", () => {
    const aliases = { "@/": "src/", "@/domain/": "src/domain/" };
    expect(resolveTarget("src/domain/x.ts", "@/foo", aliases)).toBe("src/foo");
    expect(resolveTarget("src/domain/x.ts", "@/domain/bar", aliases)).toBe("src/domain/bar");
  });

  it("maps absolute specifiers to repo-root-relative paths", () => {
    expect(resolveTarget("src/domain/x.ts", "/src/foo", NO_ALIASES)).toBe("src/foo");
  });

  it("returns null for external and bare-package specifiers", () => {
    expect(resolveTarget("src/a.ts", "node:fs", NO_ALIASES)).toBeNull();
    expect(resolveTarget("src/a.ts", "nodejs:path", NO_ALIASES)).toBeNull();
    expect(resolveTarget("src/a.ts", "https://x/y", NO_ALIASES)).toBeNull();
    expect(resolveTarget("src/a.ts", "#import", NO_ALIASES)).toBeNull();
    expect(resolveTarget("src/a.ts", "pkg", NO_ALIASES)).toBeNull();
    expect(resolveTarget("src/a.ts", "@scope/pkg", NO_ALIASES)).toBeNull();
    expect(resolveTarget("src/a.ts", "pkg/sub", NO_ALIASES)).toBeNull();
  });
});

function architecture(overrides: Partial<Architecture> = {}): Architecture {
  return { ...emptyArchitecture(), ...overrides };
}

describe("assess", () => {
  const edges = [
    {
      fromFile: "src/domain/svc.ts",
      line: 1,
      specifier: "../infra/db.ts",
      kind: "import" as const,
      target: "src/infra/db.ts",
    },
    {
      fromFile: "src/infra/db.ts",
      line: 1,
      specifier: "../domain/svc.ts",
      kind: "import" as const,
      target: "src/domain/svc.ts",
    },
    {
      fromFile: "src/domain/a.ts",
      line: 1,
      specifier: "./b.ts",
      kind: "import" as const,
      target: "src/domain/b.ts",
    },
    {
      fromFile: "src/domain/c.ts",
      line: 1,
      specifier: "pkg",
      kind: "import" as const,
      target: null,
    },
  ];

  it("fires on the layer rule only in its direction", () => {
    const arch = architecture({
      layers: { domain: ["src/domain/**"], infrastructure: ["src/infra/**"] },
      edges: [{ from: "domain", to: "infrastructure", severity: "critical", note: "" }],
    });
    const violations = assess(edges, arch);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleIndex: 0,
      fromMatched: "domain",
      toMatched: "infrastructure",
    });
    expect(violations[0]?.edge.fromFile).toBe("src/domain/svc.ts");
  });

  it("fires on a glob-to-glob rule", () => {
    const arch = architecture({
      edges: [{ from: "packages/a/**", to: "packages/b/**", severity: "warning", note: "" }],
    });
    const packageEdges = [
      {
        fromFile: "packages/a/x.ts",
        line: 1,
        specifier: "../../b/y.ts",
        kind: "import" as const,
        target: "packages/b/y.ts",
      },
    ];
    expect(assess(packageEdges, arch)).toHaveLength(1);
  });

  it("never fires same-layer edges without a rule saying so", () => {
    const arch = architecture({
      layers: { domain: ["src/domain/**"], infrastructure: ["src/infra/**"] },
      edges: [{ from: "domain", to: "infrastructure", severity: "warning", note: "" }],
    });
    const sameLayer = [edges[2]].filter((edge) => edge !== undefined);
    expect(assess(sameLayer, arch)).toHaveLength(0);
  });

  it("never fires on null targets even when a rule matches **", () => {
    const arch = architecture({
      edges: [{ from: "**", to: "**", severity: "warning", note: "" }],
    });
    expect(
      assess(
        [edges[3]].filter((edge) => edge !== undefined),
        arch,
      ),
    ).toHaveLength(0);
  });

  it("supports a layer-name from with a glob to", () => {
    const arch = architecture({
      layers: { domain: ["src/domain/**"] },
      edges: [{ from: "domain", to: "src/legacy/**", severity: "warning", note: "" }],
    });
    const legacyEdge = {
      fromFile: "src/domain/x.ts",
      line: 1,
      specifier: "../legacy/old.ts",
      kind: "import" as const,
      target: "src/legacy/old.ts",
    };
    expect(assess([legacyEdge], arch)).toHaveLength(1);
  });

  it("dedupes identical rule+file+line violations", () => {
    const arch = architecture({
      layers: { domain: ["src/domain/**"], infrastructure: ["src/infra/**"] },
      edges: [{ from: "domain", to: "infrastructure", severity: "warning", note: "" }],
    });
    const dup = [
      edges[0],
      { ...edges[0] }, // same fromFile, line, and ruleIndex
    ].filter((edge): edge is (typeof edges)[number] => edge !== undefined);
    expect(assess(dup, arch)).toHaveLength(1);
  });

  it("reports each matching rule as its own violation", () => {
    const arch = architecture({
      layers: {
        domain: ["src/domain/**"],
        infrastructure: ["src/infra/**"],
      },
      edges: [
        { from: "domain", to: "infrastructure", severity: "warning", note: "" },
        { from: "src/domain/**", to: "src/infra/**", severity: "info", note: "Also caught." },
      ],
    });
    const violations = assess(
      [edges[0]].filter((edge) => edge !== undefined),
      arch,
    );
    expect(violations).toHaveLength(2);
  });
});

describe("architectureFindings", () => {
  const rules = (arch: Architecture) => ({ architecture: arch });
  const arch = architecture({
    layers: { domain: ["src/domain/**"], infrastructure: ["src/infra/**"] },
    edges: [
      {
        from: "domain",
        to: "infrastructure",
        severity: "critical",
        note: "Domain must not depend on infra.",
      },
    ],
  });

  it("produces a deterministic finding with the evidence in the body", () => {
    const findings = architectureFindings(
      {
        shown: [file("src/domain/svc.ts", { 1: `import { db } from "../infra/db";` })],
      },
      rules(arch),
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding).toMatchObject({
      // Rule index, file and line — the same id shape a model finding carries,
      // so the lifecycle can tell two breaches of two rules apart.
      id: "review-arch:0:src/domain/svc.ts:1",
      ruleId: "review-arch:0",
      kind: "architecture",
      path: "src/domain/svc.ts",
      line: 1,
      severity: "critical",
      marker: "preflight:arch",
    });
    expect(finding?.body).toContain("imports src/infra/db");
    expect(finding?.body).toContain("domain must not depend on infrastructure");
    expect(finding?.body).toContain("Domain must not depend on infra.");
  });

  it("gives two rules breached at one import two identities, not one", () => {
    // Both rows of the table fire on the same line: the layer-named one and
    // the glob-named one. They are two breaches of two rules, and the finding
    // lifecycle keys on `(ruleId, path)` — so if they shared an id they would
    // share a disposition, a comment thread and a code-scanning alert, and a
    // `wont-fix` on either would silence the other.
    const findings = architectureFindings(
      {
        shown: [file("src/domain/svc.ts", { 1: `import { db } from "../infra/db";` })],
      },
      rules({
        ...arch,
        edges: [
          ...arch.edges,
          { from: "src/domain/**", to: "src/infra/**", severity: "warning", note: "by glob" },
        ],
      }),
    );

    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((entry) => entry.ruleId)).size).toBe(2);
    expect(new Set(findings.map((entry) => entry.id)).size).toBe(2);
  });

  it("gives one rule breached in two files two identities", () => {
    const findings = architectureFindings(
      {
        shown: [
          file("src/domain/a.ts", { 1: `import { db } from "../infra/db";` }),
          file("src/domain/b.ts", { 1: `import { db } from "../infra/db";` }),
        ],
      },
      rules(arch),
    );

    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((entry) => entry.id)).size).toBe(2);
  });

  it("caps findings and warns past the cap", () => {
    const repeated = architecture({
      layers: { domain: ["src/domain/**"], infrastructure: ["src/infra/**"] },
      edges: [{ from: "domain", to: "infrastructure", severity: "warning", note: "" }],
    });
    const files = Array.from({ length: 50 }, (_, index) =>
      file(`src/domain/f${String(index)}.ts`, { 1: `import "../infra/db";` }),
    );
    const findings = architectureFindings({ shown: files }, rules(repeated));
    expect(findings).toHaveLength(MAX_ARCH_FINDINGS);
    expect(core.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("capped at 40"));
  });

  it("produces zero findings when the rules file has no architecture section", () => {
    const findings = architectureFindings(
      { shown: [file("src/domain/svc.ts", { 1: `import "../infra/db";` })] },
      rules(emptyArchitecture()),
    );
    expect(findings).toEqual([]);
  });

  it("produces zero findings on an empty shown list", () => {
    expect(architectureFindings({ shown: [] }, rules(arch))).toEqual([]);
  });
});
