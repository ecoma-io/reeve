/**
 * Architecture / dependency-boundary review: a deterministic check that reads
 * import edges off the diff and fires a finding when one crosses a forbidden
 * layer or package boundary configured in the rules file's `architecture:`
 * section (see `rules.ts`).
 *
 * The check is a pure function over edges: `extractEdges` turns a file's
 * proven lines into import edges, `assess` decides which violate the
 * architecture, and `architectureFindings` wraps both for the review pipeline.
 * An external architecture tool that already produces edges in the same shape
 * can feed them straight into `assess` — the adapter seam aligned with the
 * evidence surface PR03 lays out. `ArchEvidence` is that seam's record type;
 * this module's findings carry the same evidence into the finding model via
 * the `marker` and `body` fields.
 *
 * Import statements are scanned line-by-line — a line-scanner, not a parser.
 * Only the lines a patch proves are scanned, and a match whose start sits
 * inside a string literal, template, or comment is never extracted, so a
 * forged `import ... from` inside prose or a dependency-injection string
 * stays inert. Direction is part of the rule: `domain → infrastructure` fires
 * only on domain→infra imports, never infra→domain, never same-layer.
 * `node:`/`https:`/`data:`/`#` and bare package specifiers never resolve into
 * the repo, so they can never fire a rule; a rule that must catch an
 * intra-repo package dependency uses an alias or a relative path.
 *
 * ponytail: multiline imports are extracted only when their `from "x"` clause
 * shares a line — the clause line carries the specifier, so the edge still
 * fires there. A specifier broken across lines is missed; add a real parser
 * when a repository needs them. Resolved paths are matched as-is: no
 * extension probing, so a glob that must match a resolved import should use a
 * `**` or the extensionless path.
 */
import * as core from "@actions/core";
import { posix } from "node:path";

import { matchesGlob } from "./pr.js";

/** The kind of import statement that produced an edge. */
export type EdgeKind = "import" | "export" | "require" | "dynamic" | "type";

/** One import edge, extracted from a proven diff line. */
export interface Edge {
  /** The importing file's repo-relative path. */
  readonly fromFile: string;
  /** The new-file line number the patch proves. */
  readonly line: number;
  /** The import specifier as written, e.g. `./foo` or `@/foo`. */
  readonly specifier: string;
  /** The kind of statement. */
  readonly kind: EdgeKind;
  /**
   * The resolved target path (repo-relative, forward slashes), for specifiers
   * that resolve into the repo: relative imports, aliased specifiers, and
   * absolute specifiers. null for external/unresolvable specifiers (`node:`,
   * `https:`, bare packages, traversal above the repo root).
   */
  readonly target: string | null;
}

/**
 * The structured evidence an external architecture tool could also produce —
 * the adapter seam. A tool that emits `kind: "edge"` records can be turned
 * into `Edge[]` and fed to `assess` directly.
 */
export interface ArchEvidence {
  readonly kind: "edge";
  readonly from: string;
  readonly to: string;
  /** The import text at the line, or a short via-label. */
  readonly via: string;
  readonly line: number;
}

/** The name of a configured layer. */
export type LayerName = string;

/** One forbidden dependency edge in the rules file's `architecture.edges`. */
export interface EdgeRule {
  /** A layer name or a path glob — the importing side. */
  readonly from: string;
  /** A layer name or a path glob — the imported side. */
  readonly to: string;
  readonly severity: "info" | "warning" | "critical";
  readonly note: string;
}

/** The `architecture:` section of a rules file. */
export interface Architecture {
  /** Layer name → path globs. A file is in a layer when any glob matches; first layer wins. */
  readonly layers: Readonly<Record<LayerName, readonly string[]>>;
  /** Forbidden edges, in declaration order (the rule index is its identity). */
  readonly edges: readonly EdgeRule[];
  /** Specifier prefix → repo-root-relative prefix; the longest matching prefix wins. */
  readonly aliases: Readonly<Record<string, string>>;
}

/** An absent `architecture:` section — zero findings, zero behavior change. */
export function emptyArchitecture(): Architecture {
  return { layers: {}, edges: [], aliases: {} };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * ESM and CJS import statements, one regex per kind, matched against each
 * proven line. The collection order is the priority: a `type` import is
 * claimed before the general `import ... from` regex, and the side-effect and
 * dynamic forms only after the `from`-clause forms had their chance.
 */
const IMPORT_TYPE = /\bimport\s+type\b[\s\S]*?from\s+(["'])([^"']+)\1/g;
const IMPORT_FROM = /\bimport\s*[\s\S]*?\bfrom\s+(["'])([^"']+)\1/g;
const IMPORT_DYNAMIC = /\bimport\s*\(\s*(["'])([^"']+)\1/g;
const IMPORT_SIDE_EFFECT = /\bimport\s+(["'])([^"']+)\1/g;
const EXPORT_FROM = /\bexport\s+(?:\*|\{[^}]*\})[\s\S]*?\bfrom\s+(["'])([^"']+)\1/g;
const REQUIRE_RESOLVE = /\brequire\s*\.?\s*resolve\s*\(\s*(["'])([^"']+)\1/g;
const REQUIRE = /\brequire\s*\(\s*(["'])([^"']+)\1/g;
/** An orphaned `from "x"` clause — the closing line of a multiline import. */
const FROM_CLAUSE = /\bfrom\s+(["'])([^"']+)\1/g;

/** The spans of a line inside which no import statement can begin. */
interface Range {
  readonly start: number;
  readonly end: number;
}

/** Tracks string literals (`"` `'` `` ` ``), line comments, and block comments. */
function opaqueRanges(line: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      const quote = ch;
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      ranges.push({ start, end: i });
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      ranges.push({ start: i, end: line.length });
      break;
    }
    if (ch === "/" && line[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < line.length && !(line[i] === "*" && line[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, line.length);
      ranges.push({ start, end: i });
      continue;
    }
    i += 1;
  }
  return ranges;
}

interface Candidate {
  readonly kind: EdgeKind;
  readonly specifier: string;
  readonly index: number;
  readonly end: number;
}

function collect(text: string, regex: RegExp, kind: EdgeKind, out: Candidate[]): void {
  for (const match of text.matchAll(regex)) {
    // Every regex above opens its specifier with `(["'])` and captures the
    // specifier in group 2; `matchAll` yields only successful matches, so the
    // group and the index are present by construction.
    const specifier = match[2];
    if (specifier === undefined) continue;
    const index = match.index;
    out.push({ kind, specifier, index, end: index + match[0].length });
  }
}

/**
 * Extracts the import edges a file's proven lines carry.
 *
 * `aliases` defaults to none: relative resolution needs no aliases, and the
 * pipeline passes the rules file's aliases through when one is configured.
 */
export function extractEdges(
  file: { readonly path: string; readonly lines: ReadonlyMap<number, string> },
  aliases: Readonly<Record<string, string>> = {},
): Edge[] {
  const edges: Edge[] = [];
  for (const [line, text] of file.lines) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("* ")) continue;
    const opaque = opaqueRanges(text);
    const candidates: Candidate[] = [];
    collect(text, IMPORT_TYPE, "type", candidates);
    collect(text, IMPORT_FROM, "import", candidates);
    collect(text, IMPORT_DYNAMIC, "dynamic", candidates);
    collect(text, IMPORT_SIDE_EFFECT, "import", candidates);
    collect(text, EXPORT_FROM, "export", candidates);
    collect(text, REQUIRE_RESOLVE, "require", candidates);
    collect(text, REQUIRE, "require", candidates);
    collect(text, FROM_CLAUSE, "import", candidates);
    const kept: Candidate[] = [];
    for (const candidate of candidates) {
      if (opaque.some((range) => candidate.index >= range.start && candidate.index < range.end)) {
        continue;
      }
      // A lower-priority regex (e.g. `from` clause, or the general import
      // regex over a `type` import) may have claimed the same statement.
      if (kept.some((k) => candidate.index >= k.index && candidate.index < k.end)) continue;
      kept.push(candidate);
      edges.push({
        fromFile: file.path,
        line,
        specifier: candidate.specifier,
        kind: candidate.kind,
        target: resolveTarget(file.path, candidate.specifier, aliases),
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Resolves an import specifier to a repo-relative path, or null when it
 * cannot map into the repository: `node:`/`nodejs:` builtins, `http(s)`/
 * `data:`/`#` specifiers, bare package specifiers, and relative paths that
 * escape above the repo root. An absolute specifier `/src/foo` maps to the
 * repo root's `src/foo`.
 */
export function resolveTarget(
  fromFile: string,
  specifier: string,
  aliases: Readonly<Record<string, string>>,
): string | null {
  if (specifier === "nodejs:" || specifier.startsWith("node:")) return null;
  if (
    specifier.startsWith("http://") ||
    specifier.startsWith("https://") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  if (specifier.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    if (resolved.startsWith("../")) return null;
    return resolved;
  }
  if (specifier.startsWith("/")) {
    return specifier.slice(1);
  }
  const prefixes = Object.keys(aliases).filter(
    (prefix) => prefix.length > 0 && specifier.startsWith(prefix),
  );
  if (prefixes.length > 0) {
    prefixes.sort((a, b) => b.length - a.length);
    const prefix = prefixes[0];
    if (prefix !== undefined) {
      const rest = specifier.slice(prefix.length);
      const base = aliases[prefix] ?? "";
      const resolved = posix.normalize(posix.join(base, rest));
      if (resolved.startsWith("../")) return null;
      return resolved;
    }
  }
  // A bare package specifier never maps into the repo.
  return null;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** A resolved import edge that crossed a forbidden boundary. */
export interface Violation {
  /** Index into `architecture.edges`. */
  readonly ruleIndex: number;
  readonly edge: Edge;
  /** The matched from-glob (or the from label as configured). */
  readonly fromMatched: string;
  /** The matched to-glob (or the to label as configured). */
  readonly toMatched: string;
}

function firstLayer(
  path: string,
  layers: Readonly<Record<LayerName, readonly string[]>>,
): string | null {
  for (const [name, globs] of Object.entries(layers)) {
    if (globs.some((glob) => matchesGlob(glob, path))) return name;
  }
  return null;
}

function isLayerName(
  value: string,
  layers: Readonly<Record<LayerName, readonly string[]>>,
): boolean {
  return Object.prototype.hasOwnProperty.call(layers, value);
}

/**
 * Decides which edges violate the architecture. A rule fires when the
 * importing file matches its `from` (a layer name or glob) AND the resolved
 * target matches its `to`. Direction is part of the rule: `domain → infra`
 * never fires on `infra → domain`. Edges with a null target (bare packages,
 * builtins) can never fire — only specifiers that resolve into the repo are
 * matched, so a rule must use an alias or a relative path to catch an
 * intra-repo dependency. Identical (ruleIndex, fromFile, line) violations are
 * reported once.
 */
export function assess(edges: readonly Edge[], architecture: Architecture): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.target === null) continue;
    const fromLayer = firstLayer(edge.fromFile, architecture.layers);
    const toLayer = firstLayer(edge.target, architecture.layers);
    for (let ruleIndex = 0; ruleIndex < architecture.edges.length; ruleIndex += 1) {
      const rule = architecture.edges[ruleIndex];
      if (rule === undefined) continue;
      const fromOk = isLayerName(rule.from, architecture.layers)
        ? fromLayer === rule.from
        : matchesGlob(rule.from, edge.fromFile);
      const toOk = isLayerName(rule.to, architecture.layers)
        ? toLayer === rule.to
        : matchesGlob(rule.to, edge.target);
      if (!fromOk || !toOk) continue;
      const key = `${String(ruleIndex)}:${edge.fromFile}:${String(edge.line)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ ruleIndex, edge, fromMatched: rule.from, toMatched: rule.to });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** A deterministic architecture finding, mirroring `PreflightFinding`. */
export interface ArchitectureFinding {
  readonly id: string;
  readonly kind: "architecture";
  /** The importing file. */
  readonly path: string;
  /** The proven import line. */
  readonly line: number;
  readonly severity: "info" | "warning" | "critical";
  readonly marker: string;
  /** The deterministic evidence sentence. */
  readonly body: string;
}

/** Cap on architecture findings per run — mirrors `MAX_BLOCKED_PER_PHRASE`. */
export const MAX_ARCH_FINDINGS = 40;

/**
 * The deterministic findings the review pipeline merges after `preflight`.
 * An absent `architecture:` section (empty architecture) produces zero
 * findings. Once `MAX_ARCH_FINDINGS` findings are collected, further
 * violations are not reported and a single warning names the cap.
 */
export function architectureFindings(
  snapshot: {
    readonly shown: readonly {
      readonly path: string;
      readonly lines: ReadonlyMap<number, string>;
    }[];
  },
  rules: { readonly architecture: Architecture },
): ArchitectureFinding[] {
  const findings: ArchitectureFinding[] = [];
  let capped = false;
  outer: for (const file of snapshot.shown) {
    const edges = extractEdges(file, rules.architecture.aliases);
    for (const violation of assess(edges, rules.architecture)) {
      if (findings.length >= MAX_ARCH_FINDINGS) {
        capped = true;
        break outer;
      }
      findings.push(findingFromViolation(violation, rules.architecture));
    }
  }
  if (capped) {
    core.warning(
      `architecture: capped at ${String(MAX_ARCH_FINDINGS)} findings; further violations were not reported.`,
    );
  }
  return findings;
}

function findingFromViolation(
  violation: Violation,
  architecture: Architecture,
): ArchitectureFinding {
  const rule = architecture.edges[violation.ruleIndex];
  const edge = violation.edge;
  const from = rule?.from ?? "";
  const to = rule?.to ?? "";
  const note = rule?.note ?? "";
  const body =
    `${from} (${edge.fromFile}) imports ${edge.target ?? edge.specifier} (${edge.kind}) ` +
    `which the repository's architecture rules forbid: ${from} must not depend on ${to}.` +
    (note.length > 0 ? ` ${note}` : "");
  return {
    id: "review-arch",
    kind: "architecture",
    path: edge.fromFile,
    line: edge.line,
    severity: rule?.severity ?? "warning",
    marker: "preflight:arch",
    body,
  };
}
