/**
 * The repository's own review rules: a committed YAML file that is as
 * reviewable as any other pull request, and the deterministic checks that fire
 * before a model is asked anything. The same `yaml` parser already used for
 * the warrant parses it, so a maintainer learns one format and a parser bug is
 * one bug, not two.
 *
 * The rules file is trusted the way `respond`'s guidance file is — it is in
 * the checkout, written by the same maintainers who write the warrant — so it
 * enters the prompt unwrapped. Every other text enters behind `enclose` (see
 * `verdict.ts`), so a pull request that quotes "ignore this rule" at the model
 * stays a quotation.
 */
import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";

import {
  emptyArchitecture,
  type Architecture,
  type EdgeRule,
  type LayerName,
} from "./architecture.js";
import { isGenerated } from "./pr.js";
import { MAX_PACK_CHARS, UnreadablePacks, parsePack, type Pack } from "./packs.js";
import { DEFAULT_TESTS, parseTests, type TestsSection } from "./testmap.js";

/**
 * Cap on the rules file, the same frugality `guidance.ts` applies to respond's
 * guidance. A rules file past it is a repository that will not fit in the
 * prompt anyway; truncation keeps a bounded prompt while the warning keeps the
 * decision to drop the tail visible.
 */
export const MAX_RULES_CHARS = 20_000;

/** One named, deterministic pre-check. */
export interface Rule {
  readonly id: string;
  readonly name: string;
  /** A marker a rule watcher (or a human) can match without reading prose. */
  readonly marker: string;
  /** Shown to the model so a finding it makes cites the same words humans use. */
  readonly body: string;
  /** The severity printed with the deterministic finding, and the lowest one the model may attach. */
  readonly severity: "info" | "warning" | "critical";
}

/** The parsed shape of a rules file. */
export interface Rules {
  readonly version: number;
  readonly rules: readonly Rule[];
  /** Files and path globs that never reach the model, and generated suffixes skipped the same way. */
  readonly ignoreFiles: readonly string[];
  readonly ignorePaths: readonly string[];
  readonly generatedExtensions: readonly string[];
  /** An arbitrary phrase the diff must not contain — a blocklist spell-check. */
  readonly blocked: readonly {
    readonly phrase: string;
    readonly severity: Rule["severity"];
    readonly note: string;
  }[];
  /** Forbidden dependency boundaries — layers, edges, and aliases. */
  readonly architecture: Architecture;
  /** The opt-in `tests:` section — test-aware review, off unless enabled. See `testmap.ts`. */
  readonly tests: TestsSection;
  readonly raw: string;
  /** The rule packs this file composes by reference, in reference order. */
  readonly packRefs: readonly PackRef[];
  /** Parsing left warnings behind (unknown keys, malformed entries). */
  readonly warnings: readonly string[];
}

/** Parsing the file yielded nothing usable. */
export class UnreadableRules extends Error {
  readonly warnings: readonly string[];
  constructor(warnings: readonly string[]) {
    super("the rules file could not be read as review rules");
    this.name = "UnreadableRules";
    this.warnings = warnings;
  }
}

const SEVERITY: Readonly<Set<string>> = new Set(["info", "warning", "critical"]);

const DEFAULT_GENERATED = [".min.js", ".min.css", ".map"];
const DEFAULT_RULES: readonly Rule[] = [
  {
    id: "dedup",
    name: "Repeated code",
    marker: "duplication",
    body: "Flag code that is repeated and could share one definition.",
    severity: "warning",
  },
];
const PREFLIGHT_ID = "review-preflight";

/**
 * Reads and parses the repository rules file from the checkout.
 *
 * The file is optional: a missing one is an empty rules set, not an error —
 * the warrant's own absence is treated the same way. A present but unreadable
 * file is a repository that asked to be reviewed by rules and is not, which is
 * a failure loud enough not to confuse an empty review with a silent one.
 * Errors that are not "missing" warn and keep going, exactly `guidance.ts`'s
 * refusal to fail a run on a read that may be a transient workspace problem.
 */
/**
 * Whether a `readFile` failure means "the file is not there" rather than
 * something worth reporting.
 *
 * The filesystem's own answer (`ENOENT`), the way `warrant.ts`'s `isNotFound`
 * and `respond/guidance.ts` both ask it. Not `forge.ts`'s `isMissing`, which
 * asks whether an HTTP response carried `status === 404` — a question no
 * `readFile` rejection can answer, so reaching for it here made the
 * "missing is the cold start" branch below unreachable.
 */
function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function readRules(path: string): Promise<Rules> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return emptyRules();
    core.warning(`review: could not read rules file at ${path}: ${String(error)}`);
    return emptyRules();
  }
  if (raw.trim().length === 0) return emptyRules();
  if (raw.length > MAX_RULES_CHARS) {
    // The warning this cap's own doc promises, and the one `guidance.ts` —
    // the sibling that doc names — has always emitted on the same decision.
    // Truncating in silence loses every rule past the cap without telling the
    // maintainer who wrote them, which is exactly the failure a bounded prompt
    // is not supposed to cost.
    core.warning(
      `review: the rules file at ${path} is ${String(raw.length)} characters, exceeding the ` +
        `${String(MAX_RULES_CHARS)}-character limit. Truncating — every rule past the limit is ` +
        "not in effect this run.",
    );
    raw = raw.slice(0, MAX_RULES_CHARS);
  }
  return parseRules(raw);
}

function emptyRules(): Rules {
  return {
    version: 1,
    rules: DEFAULT_RULES,
    ignoreFiles: [],
    ignorePaths: [],
    generatedExtensions: DEFAULT_GENERATED,
    blocked: [],
    architecture: emptyArchitecture(),
    tests: DEFAULT_TESTS,
    raw: "",
    packRefs: [],
    warnings: [],
  };
}

/** The accepted top-level keys of a rules file; others are warnings. */
const KNOWN_RULE_KEYS: Readonly<Set<string>> = new Set([
  "version",
  "rules",
  "ignore",
  "generated",
  "blocked",
  "architecture",
  "packs",
  "tests",
]);

/**
 * One reference to a rule pack, e.g. `go/concurrency@1.2`.
 *
 * `namespace/name` — unpinned; resolves to whatever the checkout has.
 * `namespace/name@1` — major pin: the pack's declared `version:` major must be 1.
 * `namespace/name@1.2` — exact pin: the pack's `version:` must be exactly 1.2.
 */
export interface PackRef {
  readonly namespace: string;
  readonly name: string;
  /** Major-only pin (`@1`), or null for unpinned. */
  readonly major: number | null;
  /** Exact minor pin (`@1.2`); implies `major` too. */
  readonly minor: number | null;
  /** The reference exactly as written, for messages. */
  readonly raw: string;
}

const PACK_REF = /^([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})(?:@(\d+)(?:\.(\d+))?)?$/;

/**
 * Reads the `packs:` list. A value outside the reference grammar fails red —
 * path traversal (`../`, uppercase, a trailing `.yml`) is structurally
 * impossible — because a pack reference is an explicit versioned choice, the
 * same class as naming a warrant path that is not there. A duplicate reference
 * is loaded once and warned about.
 */
export function readPackRefs(raw: unknown): { refs: PackRef[]; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { refs: [], warnings };
  if (!Array.isArray(raw)) {
    throw new UnreadablePacks("`packs:` is not a list");
  }
  const refs: PackRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new UnreadablePacks("`packs:` entries must be mappings with a `pack:` key");
    }
    const map = entry as Record<string, unknown>;
    const value = map.pack;
    if (typeof value !== "string") {
      throw new UnreadablePacks("`packs:` entries must carry a `pack:` string");
    }
    const match = PACK_REF.exec(value);
    if (match === null) {
      throw new UnreadablePacks(
        `pack reference \`${value}\` is not valid — expected \`namespace/name\`, \`namespace/name@1\` or \`namespace/name@1.2\``,
      );
    }
    const ref: PackRef = {
      namespace: match[1] ?? "",
      name: match[2] ?? "",
      major: match[3] === undefined ? null : Number(match[3]),
      minor: match[4] === undefined ? null : Number(match[4]),
      raw: value,
    };
    if (seen.has(value)) {
      warnings.push(`pack \`${value}\` referenced more than once; loaded once`);
      continue;
    }
    seen.add(value);
    refs.push(ref);
  }
  return { refs, warnings };
}

/**
 * Parses a rules file with the same `yaml` parser the warrant uses, then
 * validates the shape against this list: a misspelled key is a warning, not a
 * silent drop, and a malformed section is a whole-file failure when no usable
 * rule came out of it.
 */
export function parseRules(text: string): Rules {
  const warnings: string[] = [];
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    const reason =
      error instanceof YAMLParseError ? error.message : error instanceof Error ? error.message : "";
    throw new UnreadableRules([`not valid YAML — ${reason}`]);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new UnreadableRules(["expected a YAML mapping of rules"]);
  }

  const map = document as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (!KNOWN_RULE_KEYS.has(key)) warnings.push(`unknown top-level key \`${key}\`; ignored`);
  }

  const rules = readRuleList(map.rules, warnings);
  const ignore = readIgnore(map.ignore, warnings);
  const { refs: packRefs, warnings: packWarnings } = readPackRefs(map.packs);
  warnings.push(...packWarnings);
  return {
    version: readVersion(map.version, warnings),
    rules,
    ignoreFiles: ignore.files,
    ignorePaths: ignore.paths,
    generatedExtensions: readGenerated(map.generated, warnings),
    blocked: readBlocked(map.blocked, warnings),
    architecture: readArchitecture(map.architecture, warnings),
    tests: parseTests(map.tests, warnings),
    raw: text,
    packRefs,
    warnings,
  };
}

/** `ignore:` is a mapping with `files:` (exact path names) and `paths:` (globs). */
function readIgnore(raw: unknown, warnings: string[]): { files: string[]; paths: string[] } {
  if (raw === undefined || raw === null) return { files: [], paths: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`ignore:` is not a mapping; ignoring");
    return { files: [], paths: [] };
  }
  const map = raw as Record<string, unknown>;
  return {
    files: readStringList(map.files, "ignore.files", warnings),
    paths: readStringList(map.paths, "ignore.paths", warnings),
  };
}

function readVersion(raw: unknown, warnings: string[]): number {
  if (raw === undefined) {
    warnings.push("no `version:`; assuming 1");
    return 1;
  }
  if (raw === 1 || raw === "1") return 1;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    warnings.push(`unsupported version ${String(raw)}; treating as 1`);
    return 1;
  }
  warnings.push("`version` is not a number; treating as 1");
  return 1;
}

function readStringList(raw: unknown, key: string, warnings: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`\`${key}:\` is not a list; ignoring`);
    return [];
  }
  return raw
    .map((entry, index) => {
      if (typeof entry !== "string") {
        warnings.push(`\`${key}\` entry ${String(index + 1)} is not a string; dropped`);
        return null;
      }
      return entry;
    })
    .filter((entry): entry is string => entry !== null);
}

function readGenerated(raw: unknown, warnings: string[]): string[] {
  const list = readStringList(raw, "generated", warnings);
  return list.length > 0 ? list : DEFAULT_GENERATED;
}

function readBlocked(raw: unknown, warnings: string[]): Rules["blocked"] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("`blocked:` is not a list; ignoring");
    return [];
  }
  return raw
    .map((entry, index) => {
      if (typeof entry === "string") {
        // A bare string is a phrase at the default severity.
        return { phrase: entry, severity: "warning" as const, note: "" };
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        warnings.push(`\`blocked\` entry ${String(index + 1)} is not a string or mapping; dropped`);
        return null;
      }
      const map = entry as Record<string, unknown>;
      const severity =
        typeof map.severity === "string" && SEVERITY.has(map.severity)
          ? (map.severity as Rule["severity"])
          : ("warning" as const);
      return {
        phrase: typeof map.phrase === "string" ? map.phrase : "",
        severity,
        note: typeof map.note === "string" ? map.note : "",
      };
    })
    .filter((entry): entry is Rules["blocked"][number] => entry !== null);
}

function readRuleList(raw: unknown, warnings: string[]): readonly Rule[] {
  if (raw === undefined || raw === null) return DEFAULT_RULES;
  if (!Array.isArray(raw)) {
    warnings.push("`rules:` is not a list; keeping the built-in default");
    return DEFAULT_RULES;
  }
  const out: Rule[] = raw
    .map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        warnings.push(`rule entry ${String(index + 1)} is not a mapping; dropped`);
        return null;
      }
      const map = entry as Record<string, unknown>;
      const id = map.id ?? map.rule ?? `rule-${String(index + 1)}`;
      const severity =
        typeof map.severity === "string" && SEVERITY.has(map.severity)
          ? (map.severity as Rule["severity"])
          : ("warning" as const);
      return {
        id: typeof id === "string" ? id : `rule-${String(index + 1)}`,
        name: typeof map.name === "string" ? map.name : "Unnamed rule",
        marker: typeof map.marker === "string" ? map.marker : "",
        body: typeof map.body === "string" ? map.body : "",
        severity,
      };
    })
    .filter((rule): rule is Rule => rule !== null);
  return out.length > 0 ? out : DEFAULT_RULES;
}

/**
 * Composes the local rules file with the referenced packs into the effective
 * rules the review runs on.
 *
 * Precedence, highest wins: local rules → pack[0] → pack[1] → … → built-in
 * defaults. Composition is deterministic (D9): the order is the reference
 * order in the local `packs:` list, never a filesystem walk.
 *
 * | Slot | Merge |
 * |---|---|
 * | `rules` | Id-keyed, first-definition-wins. Local first, then packs in reference order; a later definition of an id already present is dropped with a warning naming both sources. |
 * | `blocked` | Union, dedup by phrase; the first definition's severity/note wins. |
 * | `generated` | Union of every non-empty list; an empty union falls back to `DEFAULT_GENERATED`. (Zero packs reproduce today exactly.) |
 * | `ignore.files`/`ignore.paths` | Union. The `allShownIgnored` guard in `main.ts` still refuses to stamp a diff the rules alone emptied. |
 *
 * The built-in `dedup` rule is included exactly when no source — local or any
 * pack — wrote a non-empty `rules:` list.
 */
export function composeRules(local: Rules, packs: readonly Pack[]): Rules {
  const rules: Rule[] = [];
  const seenRuleIds = new Set<string>();
  const duplicatedIds = new Set<string>();
  const addRule = (rule: Rule, source: string): void => {
    void source;
    if (seenRuleIds.has(rule.id)) {
      duplicatedIds.add(rule.id);
      return;
    }
    seenRuleIds.add(rule.id);
    rules.push(rule);
  };

  let anyRulesList = false;
  if (local.rules !== DEFAULT_RULES) {
    anyRulesList = local.rules.length > 0;
    for (const rule of local.rules) addRule(rule, "the local rules file");
  }
  for (const pack of packs) {
    if (pack.fragment.rules.length > 0) anyRulesList = true;
    for (const rule of pack.fragment.rules) addRule(rule, `pack ${pack.ref}`);
  }
  if (!anyRulesList && local.rules === DEFAULT_RULES) {
    for (const rule of DEFAULT_RULES) addRule(rule, "the built-in default");
  }

  const effectiveRules = rules.length > 0 ? rules : DEFAULT_RULES;

  // blocked: union, first-wins per phrase.
  const blockedByPhrase = new Map<string, Rules["blocked"][number]>();
  for (const entry of local.blocked) {
    if (!blockedByPhrase.has(entry.phrase)) blockedByPhrase.set(entry.phrase, entry);
  }
  for (const pack of packs) {
    for (const entry of pack.fragment.blocked) {
      if (!blockedByPhrase.has(entry.phrase)) blockedByPhrase.set(entry.phrase, entry);
    }
  }

  // generated: union of non-empty lists.
  const generated: string[] = [];
  const seenGenerated = new Set<string>();
  const absorbGenerated = (list: readonly string[]): void => {
    if (list.length === 0) return;
    for (const item of list) {
      if (!seenGenerated.has(item)) {
        seenGenerated.add(item);
        generated.push(item);
      }
    }
  };
  absorbGenerated(local.generatedExtensions);
  for (const pack of packs) absorbGenerated(pack.fragment.generatedExtensions);

  const warnings = [...local.warnings];
  for (const pack of packs) {
    for (const warning of pack.warnings) warnings.push(warning);
  }
  for (const id of duplicatedIds) {
    warnings.push(`rule \`${id}\` is defined more than once; the first definition wins`);
  }

  return {
    version: local.version,
    rules: effectiveRules,
    ignoreFiles: [...local.ignoreFiles, ...packs.flatMap((p) => p.fragment.ignoreFiles)],
    ignorePaths: [...local.ignorePaths, ...packs.flatMap((p) => p.fragment.ignorePaths)],
    generatedExtensions: generated.length > 0 ? generated : DEFAULT_GENERATED,
    blocked: [...blockedByPhrase.values()],
    architecture: local.architecture,
    tests: local.tests,
    raw: local.raw,
    packRefs: local.packRefs,
    warnings,
  };
}

/**
 * Reads the local rules file and every pack it references, then composes.
 *
 * The local file is read exactly as `readRules` reads it — missing is the cold
 * start, unreadable is red, truncation-warn kept. A `packs:` list makes the
 * run depend on those packs, and a referenced pack is never optional: a
 * missing pack, a pin that does not match the pack's declared `version:`, an
 * over-budget pack, or a transient read failure is red (D5) — the same
 * loudness as naming a warrant path that is not there.
 */
export async function readPackedRules(path: string, packsPath: string): Promise<Rules> {
  const local = await readRules(path);
  if (local.packRefs.length === 0) return local;

  const packs: Pack[] = [];
  let rawSum = 0;
  for (const ref of local.packRefs) {
    const packPath = join(packsPath, ref.namespace, `${ref.name}.yml`);
    const pack = await readPackFile(ref, packPath);
    packs.push(pack);
    rawSum += pack.raw.length;
  }
  if (rawSum > MAX_RULES_CHARS) {
    throw new UnreadablePacks(
      `packs exceed the ${String(MAX_RULES_CHARS)}-character composition budget (sum ${String(rawSum)}); reduce packs or the count`,
    );
  }

  const composed = composeRules(local, packs);
  const textBudget =
    composed.rules.reduce((n, rule) => n + rule.body.length, 0) +
    composed.blocked.reduce((n, entry) => n + entry.phrase.length + entry.note.length, 0);
  if (textBudget > MAX_RULES_CHARS) {
    throw new UnreadablePacks(
      `composed rules and blocked phrases exceed the ${String(MAX_RULES_CHARS)}-character budget (${String(textBudget)}); reduce packs`,
    );
  }
  return composed;
}

async function readPackFile(ref: PackRef, path: string): Promise<Pack> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new UnreadablePacks(
        `pack \`${ref.raw}\` is referenced by the rules file but no file is at ${path}`,
      );
    }
    throw new UnreadablePacks(
      `pack \`${ref.raw}\` could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw.trim().length === 0) {
    throw new UnreadablePacks(`pack \`${ref.raw}\` at ${path} is empty`);
  }
  if (raw.length > MAX_PACK_CHARS) {
    throw new UnreadablePacks(
      `pack \`${ref.raw}\` at ${path} is ${String(raw.length)} characters, exceeding the ${String(MAX_PACK_CHARS)}-character pack cap; trim it or drop the reference`,
    );
  }
  const pack = parsePack(raw, ref.raw);
  assertPin(ref, pack);
  return pack;
}

/** A version pin in the reference must match the pack's declared version. */
function assertPin(ref: PackRef, pack: Pack): void {
  if (ref.major === null) return;
  const declared = pack.version;
  if (declared === null) {
    throw new UnreadablePacks(
      `pack \`${ref.raw}\` is pinned at version ${String(ref.major)}${ref.minor !== null ? `.${String(ref.minor)}` : ""} but declares no \`version:\``,
    );
  }
  if (declared.major !== ref.major) {
    throw new UnreadablePacks(
      `pack \`${ref.raw}\` is pinned at version ${String(ref.major)}${ref.minor !== null ? `.${String(ref.minor)}` : ""} but declares ${String(declared.major)}.${String(declared.minor)}`,
    );
  }
  if (ref.minor !== null && declared.minor !== ref.minor) {
    throw new UnreadablePacks(
      `pack \`${ref.raw}\` is pinned at version ${String(ref.major)}.${String(ref.minor)} but declares ${String(declared.major)}.${String(declared.minor)}`,
    );
  }
}

/**
 * The deterministic checks that fire without a model in the loop: a generated
 * file outside the ignore list, and a blocked phrase in the diff.
 *
 * Both are *always-right* machines: a blocked phrase on line 3 of a file is a
 * finding with a printed line number — the only reason it is reported by a
 * duty is that no model can be trusted with a claim about a line it was never
 * shown, and a deterministic check can be.
 */
const BLOCKED_MARK = "preflight:blocked";
const GENERATED_MARK = "preflight:generated";

/** A deterministic finding that fires before the model is asked anything. */
export interface PreflightFinding {
  readonly id: string;
  readonly kind: "generated" | "blocked";
  readonly path: string;
  readonly line: number | null;
  readonly severity: Rule["severity"];
  readonly marker: string;
  readonly body: string;
}

/**
 * Runs the deterministic checks against the diff.
 *
 * `generated` fires once per generated file that reached the review (in the
 * `shown` list, meaning it was not already ignored). `blocked` fires once per
 * blocked phrase per line, capped so a vendored diff full of a phrase is
 * reported as the class it is rather than as a thousand entries.
 */
const MAX_BLOCKED_PER_PHRASE = 40;

export function preflight(
  snapshot: { readonly shown: readonly { path: string; lines: ReadonlyMap<number, string> }[] },
  rules: Rules,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of snapshot.shown) {
    if (isGenerated(file.path, rules.generatedExtensions)) {
      findings.push({
        id: PREFLIGHT_ID,
        kind: "generated",
        path: file.path,
        line: null,
        severity: "warning",
        marker: GENERATED_MARK,
        body: `This file looks generated (suffixes: ${rules.generatedExtensions.join(", ")}). If it is, add it to the repository's review rules \`generated:\` list so the review can skip it; if it is not, add the file to the rules to silence this finding.`,
      });
    }
    for (const blocked of rules.blocked) {
      // A phrase nobody wrote matches every line: `"x".includes("")` is true.
      // Both readers fill an absent `phrase:` with "" (a mapping carrying only
      // `severity:`, or a bare empty string), so without this an entry costing
      // one line of a rule pack fires a finding — at whatever severity it
      // asked for — on every line of every file in the diff. Preflight
      // findings never pass through `verifyFindings`; they are trusted because
      // they are deterministic, which is exactly why one that matches
      // everything must not exist.
      if (blocked.phrase.length === 0) continue;
      let count = 0;
      for (const [line, text] of file.lines) {
        if (count >= MAX_BLOCKED_PER_PHRASE) break;
        if (text.includes(blocked.phrase)) {
          count += 1;
          findings.push({
            id: PREFLIGHT_ID,
            kind: "blocked",
            path: file.path,
            line,
            severity: blocked.severity,
            marker: BLOCKED_MARK,
            body: blockedNote(blocked),
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Reads the `architecture:` section of a rules file into the consumed shape
 * (see `architecture.ts`). Every malformed part is a warning and a drop, never
 * a silent guess: a misspelled key is a misspelled key, and a rule the parser
 * had to invent a meaning for would fire findings the maintainer never wrote.
 * An absent section is an empty architecture — zero findings, zero behavior
 * change.
 */
export function readArchitecture(raw: unknown, warnings: string[]): Architecture {
  if (raw === undefined || raw === null) return emptyArchitecture();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`architecture:` is not a mapping; ignoring");
    return emptyArchitecture();
  }
  const map = raw as Record<string, unknown>;
  return {
    layers: readArchLayers(map.layers, warnings),
    edges: readArchEdges(map.edges, warnings),
    aliases: readArchAliases(map.aliases, warnings),
  };
}

/** Re-exported so `rules.ts` remains the single place that owns the file grammar. */
export type { Architecture } from "./architecture.js";

/** `layers:` — a mapping of layer name → list of path globs. */
function readArchLayers(
  raw: unknown,
  warnings: string[],
): Readonly<Record<LayerName, readonly string[]>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`architecture.layers:` is not a mapping; ignoring");
    return {};
  }
  const map = raw as Record<string, unknown>;
  const layers: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(map)) {
    if (name.length === 0) {
      warnings.push("`architecture.layers` has an empty layer name; dropped");
      continue;
    }
    if (value === undefined || value === null) {
      warnings.push(`\`architecture.layers.${name}:\` has no glob list; dropped`);
      continue;
    }
    if (!Array.isArray(value)) {
      warnings.push(`\`architecture.layers.${name}:\` is not a list; dropped`);
      continue;
    }
    const globs = value
      .map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
          warnings.push(
            `\`architecture.layers.${name}\` entry ${String(index + 1)} is not a non-empty string; dropped`,
          );
          return null;
        }
        return entry;
      })
      .filter((entry): entry is string => entry !== null);
    if (globs.length > 0) layers[name] = globs;
  }
  return layers;
}

/** `edges:` — a list of forbidden dependency edges. */
function readArchEdges(raw: unknown, warnings: string[]): readonly EdgeRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("`architecture.edges:` is not a list; ignoring");
    return [];
  }
  const out: EdgeRule[] = [];
  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`\`architecture.edges\` entry ${String(index + 1)} is not a mapping; dropped`);
      return;
    }
    const map = entry as Record<string, unknown>;
    const from = typeof map.from === "string" ? map.from : "";
    const to = typeof map.to === "string" ? map.to : "";
    if (from.length === 0 || to.length === 0) {
      warnings.push(
        `\`architecture.edges\` entry ${String(index + 1)} is missing \`from\`/\`to\`; dropped`,
      );
      return;
    }
    const severity =
      typeof map.severity === "string" && SEVERITY.has(map.severity)
        ? (map.severity as EdgeRule["severity"])
        : ("warning" as const);
    if (typeof map.severity === "string" && !SEVERITY.has(map.severity)) {
      warnings.push(
        `\`architecture.edges\` entry ${String(index + 1)} has unknown severity \`${map.severity}\`; using warning`,
      );
    }
    out.push({
      from,
      to,
      severity,
      note: typeof map.note === "string" ? map.note : "",
    });
  });
  return out;
}

/** `aliases:` — a mapping of prefix → repo-root-relative prefix. */
function readArchAliases(raw: unknown, warnings: string[]): Readonly<Record<string, string>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`architecture.aliases:` is not a mapping; ignoring");
    return {};
  }
  const map = raw as Record<string, unknown>;
  const aliases: Record<string, string> = {};
  for (const [prefix, value] of Object.entries(map)) {
    if (prefix.length === 0) {
      warnings.push("`architecture.aliases` has an empty prefix; dropped");
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      warnings.push(`\`architecture.aliases.${prefix}:\` is not a non-empty string; dropped`);
      continue;
    }
    aliases[prefix] = value;
  }
  return aliases;
}

function blockedNote(blocked: Rules["blocked"][number]): string {
  const note = blocked.note.length > 0 ? ` ${blocked.note}` : "";
  return `The diff contains the blocked text "${blocked.phrase}"${note}`;
}
