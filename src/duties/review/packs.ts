/**
 * Versioned rule packs: reusable fragments of the review rules grammar that a
 * repository's own rules file composes by reference.
 *
 * A pack is a repo-owned committed file — `packs-path/<namespace>/<name>.yml`
 * (default `.github/reeve-packs`) — parsed by the same `yaml` parser the rules
 * file and the warrant use. It describes review policy only: the same
 * `rules`/`ignore`/`generated`/`blocked` fields the rules file has, in the
 * same shapes. It can never describe authority — a pack has no field for
 * capabilities, and the warrant stays the only source a duty's grant is read
 * from (D2). Packs are read from the checkout, never fetched (D6), and
 * composed deterministically in reference order (D9).
 *
 * The introduced trust boundary. The local rules file is trusted the way the
 * taxonomy is — maintainer text from the pinned base-ref checkout. A pack is
 * one rung stricter, because a pack somebody pinned by name and version must
 * not be able to smuggle escalation through a typo'd key or a YAML alias
 * bomb:
 *
 * - the top-level key set is strict — anything that is not one of the pack's
 *   five policy keys plus `name`/`description`/`version` fails red, naming
 *   the key, instead of warning like the rules file does (D8);
 * - aliases and merge keys are refused by `maxAliasCount: 0`, so a pack
 *   cannot expand a small file into a prompt flood (D8);
 * - a pack past `MAX_PACK_CHARS` fails red rather than truncating, because
 *   truncation would silently drop the policy somebody pinned (D5).
 */
import { isScalar, parse, parseDocument, YAMLParseError } from "yaml";

import type { Rules } from "./rules.js";

/** Cap on one pack file, in characters. A pack past it is a policy that will
 * not fit — refused, not truncated, so a pinned version is never silently
 * weakened. */
export const MAX_PACK_CHARS = 8_000;

/** The only top-level keys a pack file may carry. Anything else fails red. */
export const PACK_TOP_LEVEL_KEYS: Readonly<Set<string>> = new Set([
  "name",
  "description",
  "version",
  "rules",
  "ignore",
  "generated",
  "blocked",
]);

/** One parsed, referenced rule pack. */
export interface Pack {
  /** The reference that resolved to this pack, e.g. `go/concurrency@1.2`. */
  readonly ref: string;
  /** The pack file's own two-component semantic version, when it wrote one. */
  readonly version: { readonly major: number; readonly minor: number } | null;
  /** The pack's fragment of the rules grammar. */
  readonly fragment: {
    readonly rules: Rules["rules"];
    readonly ignoreFiles: readonly string[];
    readonly ignorePaths: readonly string[];
    readonly generatedExtensions: readonly string[];
    readonly blocked: Rules["blocked"];
  };
  readonly raw: string;
  /** Parsing left warnings behind (unknown sub-keys, malformed entries). */
  readonly warnings: readonly string[];
}

/** A referenced pack could not be loaded as review policy. */
export class UnreadablePacks extends Error {
  readonly warnings: readonly string[];
  constructor(message: string, warnings: readonly string[] = []) {
    super(message);
    this.name = "UnreadablePacks";
    this.warnings = warnings;
  }
}

const TWO_PART_VERSION = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a pack file at `ref` (e.g. `go/concurrency@1.2`). Anything that is
 * not a strict pack fragment fails red with a message naming the reference —
 * a pack somebody pinned must be loud, never silently dropped (D5).
 */
export function parsePack(text: string, ref: string): Pack {
  const warnings: string[] = [];
  let document: unknown;
  try {
    // `maxAliasCount: 0` refuses aliases, anchors and merge keys outright —
    // the documented ToJSOptions bound of the installed `yaml` lib — so a
    // pack cannot expand a small file into a prompt flood (D8).
    document = parse(text, { maxAliasCount: 0 });
  } catch (error) {
    const reason =
      error instanceof YAMLParseError ? error.message : error instanceof Error ? error.message : "";
    throw new UnreadablePacks(`pack ${ref}: not valid YAML — ${reason}`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new UnreadablePacks(`pack ${ref}: expected a YAML mapping`);
  }

  const map = document as Record<string, unknown>;
  const unknown = Object.keys(map).filter((key) => !PACK_TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new UnreadablePacks(
      `pack ${ref}: unknown top-level key \`${unknown[0] ?? ""}\` — a rule pack describes review policy (rules, ignores, blocked phrases, generated suffixes) and cannot grant authority (D2); remove it or the pack is refused`,
    );
  }

  const version = readPackVersion(text, map.version, ref);
  const fragment = readPackFragment(map, ref, warnings);
  return { ref, version, fragment, raw: text, warnings };
}

function readPackVersion(text: string, parsed: unknown, ref: string): Pack["version"] {
  if (parsed === undefined || parsed === null) return null;
  // The version is read from the pack's source text, not the YAML-coerced
  // number, so `1.10` stays 1.10 — YAML parses it as the JS number 1.1 and
  // the trailing zero is otherwise unrecoverable. The scalar's source range
  // preserves the author's spelling, quoted or not.
  const node = parseDocument(text).get("version", true);
  const raw =
    isScalar(node) && Array.isArray(node.range) ? text.slice(node.range[0], node.range[1]) : null;
  if (raw === null) {
    throw new UnreadablePacks(
      `pack ${ref}: \`version\` could not be read from the file — got ${JSON.stringify(parsed)}`,
    );
  }
  const match = TWO_PART_VERSION.exec(raw.trim().replace(/^['"]|['"]$/g, ""));
  if (match === null) {
    throw new UnreadablePacks(
      `pack ${ref}: \`version\` must be a whole number or a two-component version like 1.2 — got \`${raw}\``,
    );
  }
  return { major: Number(match[1]), minor: match[2] === undefined ? 0 : Number(match[2]) };
}

function readPackFragment(
  map: Record<string, unknown>,
  ref: string,
  warnings: string[],
): Pack["fragment"] {
  // Rules entries reuse the rules file's own reader semantics but must be
  // validated locally because a malformed pack is red, not a warning.
  const rules = readPackRules(map.rules, ref, warnings);
  const ignore = readPackIgnore(map.ignore, ref, warnings);
  return {
    rules,
    ignoreFiles: ignore.files,
    ignorePaths: ignore.paths,
    generatedExtensions: readPackStringList(map.generated, ref, "generated", warnings),
    blocked: readPackBlocked(map.blocked, ref, warnings),
  };
}

function readPackRules(raw: unknown, ref: string, warnings: string[]): Rules["rules"] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new UnreadablePacks(`pack ${ref}: \`rules:\` is not a list`);
  }
  const out: Rules["rules"] = raw
    .map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        warnings.push(`pack ${ref}: rule entry ${String(index + 1)} is not a mapping; dropped`);
        return null;
      }
      const map = entry as Record<string, unknown>;
      const id = map.id ?? map.rule ?? `rule-${String(index + 1)}`;
      const severity =
        typeof map.severity === "string" && SEVERITY.has(map.severity)
          ? (map.severity as Rules["rules"][number]["severity"])
          : ("warning" as const);
      return {
        id: typeof id === "string" ? id : `rule-${String(index + 1)}`,
        name: typeof map.name === "string" ? map.name : "Unnamed rule",
        marker: typeof map.marker === "string" ? map.marker : "",
        body: typeof map.body === "string" ? map.body : "",
        severity,
      };
    })
    .filter((rule): rule is Rules["rules"][number] => rule !== null);
  return out;
}

function readPackIgnore(
  raw: unknown,
  ref: string,
  warnings: string[],
): { files: string[]; paths: string[] } {
  if (raw === undefined || raw === null) return { files: [], paths: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new UnreadablePacks(`pack ${ref}: \`ignore:\` is not a mapping`);
  }
  const map = raw as Record<string, unknown>;
  return {
    files: readPackStringList(map.files, ref, "ignore.files", warnings),
    paths: readPackStringList(map.paths, ref, "ignore.paths", warnings),
  };
}

function readPackStringList(raw: unknown, ref: string, key: string, warnings: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`pack ${ref}: \`${key}:\` is not a list; ignoring`);
    return [];
  }
  return raw
    .map((entry, index) => {
      if (typeof entry !== "string") {
        warnings.push(
          `pack ${ref}: \`${key}\` entry ${String(index + 1)} is not a string; dropped`,
        );
        return null;
      }
      return entry;
    })
    .filter((entry): entry is string => entry !== null);
}

function readPackBlocked(raw: unknown, ref: string, warnings: string[]): Rules["blocked"] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new UnreadablePacks(`pack ${ref}: \`blocked:\` is not a list`);
  }
  return raw
    .map((entry, index) => {
      if (typeof entry === "string") {
        return { phrase: entry, severity: "warning" as const, note: "" };
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        warnings.push(
          `pack ${ref}: \`blocked\` entry ${String(index + 1)} is not a string or mapping; dropped`,
        );
        return null;
      }
      const map = entry as Record<string, unknown>;
      const severity =
        typeof map.severity === "string" && SEVERITY.has(map.severity)
          ? (map.severity as Rules["blocked"][number]["severity"])
          : ("warning" as const);
      return {
        phrase: typeof map.phrase === "string" ? map.phrase : "",
        severity,
        note: typeof map.note === "string" ? map.note : "",
      };
    })
    .filter((entry): entry is Rules["blocked"][number] => entry !== null);
}

const SEVERITY: Readonly<Set<string>> = new Set(["info", "warning", "critical"]);
