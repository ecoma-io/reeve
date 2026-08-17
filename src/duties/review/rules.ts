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
import { parse, YAMLParseError } from "yaml";

import { isMissing } from "../../core/forge.js";
import { isGenerated } from "./pr.js";

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
  readonly raw: string;
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
export async function readRules(path: string): Promise<Rules> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return emptyRules();
    core.warning(`review: could not read rules file at ${path}: ${String(error)}`);
    return emptyRules();
  }
  if (raw.trim().length === 0) return emptyRules();
  if (raw.length > MAX_RULES_CHARS) {
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
    raw: "",
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
]);

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
  return {
    version: readVersion(map.version, warnings),
    rules,
    ignoreFiles: ignore.files,
    ignorePaths: ignore.paths,
    generatedExtensions: readGenerated(map.generated, warnings),
    blocked: readBlocked(map.blocked, warnings),
    raw: text,
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

function blockedNote(blocked: Rules["blocked"][number]): string {
  const note = blocked.note.length > 0 ? ` ${blocked.note}` : "";
  return `The diff contains the blocked text "${blocked.phrase}"${note}`;
}
