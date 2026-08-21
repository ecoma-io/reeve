/**
 * Risk-based review depth: the deterministic signals that price how many
 * model passes a diff is worth.
 *
 * **Depth is priced, never capability.** This module decides how *many* times
 * the review model reads the diff, and nothing else. Whether the review may
 * write anything at all comes from the warrant (see `main.ts`'s
 * `granted("review", …)`), and a risk profile can never widen it — a hostile
 * profile that names `capabilities:` is warned about and ignored, exactly the
 * way a hostile `ignore:` in a rules file cannot un-ignore a path.
 *
 * Two hard rules sit above the arithmetic:
 *
 * - **Rule A (escalation):** authorization, security-sensitive and
 *   database-schema paths are high-risk *by policy*. Whatever the score, a
 *   diff that touches one is reviewed with the adversarial verification pass.
 *   No weight in the profile can lower that — a profile setting
 *   `auth-change: 0` still escalates. It may only *add* paths, never remove
 *   the policy ones.
 * - **Rule B (size is priced, not decisive):** a diff that touches no
 *   risk-relevant path is low-risk, whatever its size. Volume alone must not
 *   buy a more expensive review of a docs dump; the documented upgrade path
 *   for a directory that *should* be risky is to add it to a signal's globs.
 *
 * D4 (work priced before done) and D2 (capabilities from the warrant only)
 * are the load-bearing doctrines; see `docs/doctrine/north-star.md`.
 */
import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { parse, YAMLParseError } from "yaml";

import { HUMAN_MANIFESTS, LOCKFILES } from "./manifests.js";
import { matchesGlob, isGenerated, type PrFile } from "./pr.js";
import type { Rules } from "./rules.js";

export type RiskTier = "low" | "medium" | "high";

export type RiskSignalName =
  | "changed_lines"
  | "changed_files"
  | "sensitive_path"
  | "dependency_changes"
  | "db_migration"
  | "public_api"
  | "auth_change"
  | "infra_change"
  | "generated_code"
  | "security_sensitive";

/** One signal that fired, and the evidence that fired it. */
export interface RiskSignalEvidence {
  readonly signal: RiskSignalName;
  readonly weight: number;
  readonly units: number;
  /** What this signal added to the score — `units * weight`. */
  readonly contribution: number;
  readonly evidence: readonly string[];
  /**
   * Whether this firing triggers Rule A (escalation to high). True for
   * auth/db paths by policy, and for security-sensitive only when a *path*
   * matched — a text sniff alone (a docs page that says "password") scores
   * but never escalates: it is evidence of material, not of a credential file.
   */
  readonly escalates: boolean;
}

/** The whole risk assessment, as `main.ts` logs it and the summary renders it. */
export interface RiskAssessment {
  readonly tier: RiskTier;
  readonly score: number;
  readonly thresholds: { readonly medium: number; readonly high: number };
  readonly signals: readonly RiskSignalEvidence[];
  readonly profile: string;
}

/** A repository-owned risk profile — the parseable shape of the config file. */
export interface RiskProfile {
  readonly version: number;
  readonly thresholds: { readonly medium: number; readonly high: number };
  readonly weights: Readonly<Record<RiskSignalName, number>>;
  readonly paths: Readonly<Partial<Record<RiskSignalName, readonly string[]>>>;
  readonly raw: string;
  readonly warnings: readonly string[];
}

/** Parsing the file yielded nothing usable — same loud posture as `UnreadableRules`. */
export class UnreadableRiskProfile extends Error {
  readonly warnings: readonly string[];
  constructor(warnings: readonly string[]) {
    super("the risk profile could not be read as a risk profile");
    this.name = "UnreadableRiskProfile";
    this.warnings = warnings;
  }
}

/** Cap on the profile file, the same frugality `rules.ts` applies to rules. */
export const MAX_RISK_PROFILE_CHARS = 20_000;

export const DEFAULT_THRESHOLDS = { medium: 2, high: 8 } as const;

/** The default weights — the policy statement, in numbers. */
export const DEFAULT_WEIGHTS: Readonly<Record<RiskSignalName, number>> = {
  changed_lines: 1,
  changed_files: 1,
  sensitive_path: 2,
  dependency_changes: 3,
  db_migration: 4,
  public_api: 3,
  auth_change: 4,
  infra_change: 2,
  generated_code: 0,
  security_sensitive: 4,
};

/**
 * The built-in path globs per signal.
 *
 * Note every list carries both a nested (double-star + "auth/" prefix) and a
 * repository-root ("auth/") variant. `matchesGlob`'s double-star slash
 * requires at least one directory segment, so a nested glob does not match a
 * root-level "auth/login.ts"; the root variants are what catch it.
 */
export const BUILTIN_PATHS: Readonly<Record<RiskSignalName, readonly string[]>> = {
  sensitive_path: [
    "**/auth/**",
    "auth/**",
    "**/secrets/**",
    "secrets/**",
    "**/secret/**",
    "secret/**",
    "**/credentials/**",
    "credentials/**",
    "**/*.pem",
    "*.pem",
    "**/*.key",
    "*.key",
    ".env",
    ".env.*",
    "**/token*.ts",
    "**/token*.js",
  ],
  auth_change: [
    "**/auth/**",
    "auth/**",
    "**/authorization/**",
    "authorization/**",
    "**/permissions/**",
    "permissions/**",
    "**/rbac/**",
    "rbac/**",
    "**/session/**",
    "session/**",
    "**/oauth/**",
    "oauth/**",
    "**/oidc/**",
    "oidc/**",
  ],
  db_migration: [
    "**/migrations/**",
    "migrations/**",
    "**/migrate/**",
    "migrate/**",
    "**/prisma/migrations/**",
    "**/alembic/**",
    "alembic/**",
    "**/flyway/**",
    "**/liquibase/**",
    "**/schema.sql",
    "schema.sql",
  ],
  public_api: [
    "**/api/**",
    "api/**",
    "**/openapi*.yaml",
    "**/openapi*.json",
    "**/swagger*.yaml",
    "**/*.proto",
    "**/grpc/**",
    "grpc/**",
  ],
  infra_change: [
    ".github/workflows/**",
    ".github/actions/**",
    "**/Dockerfile*",
    "Dockerfile*",
    "**/docker-compose*.yml",
    "docker-compose*.yml",
    "**/docker-compose*.yaml",
    "docker-compose*.yaml",
    "**/*.tf",
    "*.tf",
    "**/*.tfvars",
    "**/helm/**",
    "helm/**",
    "k8s/**",
    "kubernetes/**",
    "kubernetes/*",
    "**/cloudbuild*.yaml",
    "cloudbuild*.yaml",
  ],
  security_sensitive: [
    "**/*.pem",
    "*.pem",
    "**/*.key",
    "*.key",
    "**/.env*",
    ".env*",
    "**/secret*",
    "secret*",
    "**/token*",
    "token*",
    "**/credential*",
    "credential*",
  ],
  dependency_changes: [],
  changed_lines: [],
  changed_files: [],
  generated_code: [],
};

/**
 * Dependency manifests — the signal fires on these exact paths. The names
 * live in `manifests.ts`, the same list `rules.ts` draws its lockfile skip
 * defaults from, so the skip and the signal can never drift apart.
 */
export const DEPENDENCY_FILES: ReadonlySet<string> = new Set([...HUMAN_MANIFESTS, ...LOCKFILES]);

/** Text that marks a patch as carrying credential or access-control material. */
export const SECURITY_PHRASES: readonly string[] = [
  "password",
  "api_key",
  "apikey",
  "authorization",
  "bearer ",
  "private key",
];

/** Signals that count as qualitative — a diff with none of these is low by Rule B. */
const QUALITATIVE: ReadonlySet<RiskSignalName> = new Set([
  "sensitive_path",
  "dependency_changes",
  "db_migration",
  "public_api",
  "auth_change",
  "infra_change",
  "security_sensitive",
]);

/** Signals that escalate to high by policy, whatever the score — Rule A. */
const POLICY_HIGH: ReadonlySet<RiskSignalName> = new Set([
  "auth_change",
  "security_sensitive",
  "db_migration",
]);

/** Signals a profile may set weights for, kebab-case keys, and the mapping to the model. */
const WEIGHT_KEYS: Readonly<Record<string, RiskSignalName>> = {
  "changed-lines": "changed_lines",
  "changed-files": "changed_files",
  "sensitive-path": "sensitive_path",
  "dependency-changes": "dependency_changes",
  "db-migration": "db_migration",
  "public-api": "public_api",
  "auth-change": "auth_change",
  "infra-change": "infra_change",
  "security-sensitive": "security_sensitive",
};

/** Signals a profile may add path globs for. */
const PATH_KEYS: Readonly<Record<string, RiskSignalName>> = {
  sensitive: "sensitive_path",
  auth: "auth_change",
  "db-migration": "db_migration",
  "public-api": "public_api",
  infra: "infra_change",
  "security-sensitive": "security_sensitive",
};

const KNOWN_KEYS: Readonly<Set<string>> = new Set(["version", "thresholds", "weights", "paths"]);

/** The default profile: no configuration at all, the built-ins apply. */
export function defaultRiskProfile(): RiskProfile {
  return {
    version: 1,
    thresholds: { ...DEFAULT_THRESHOLDS },
    weights: { ...DEFAULT_WEIGHTS },
    paths: {},
    raw: "",
    warnings: [],
  };
}

/**
 * Reads and parses the repository risk profile from the checkout.
 *
 * The file is optional, exactly like the rules file: a missing one is the
 * default profile, not an error. A present but unreadable file is a repository
 * that asked to be priced by a profile and is not, which is loud (D5). Errors
 * that are not "missing" warn and keep going.
 */
/**
 * Whether a `readFile` failure means "the file is not there" — the
 * filesystem's own `ENOENT`, the same question `warrant.ts`'s `isNotFound`
 * asks. Deliberately not `forge.ts`'s `isMissing`, which reads an HTTP
 * `status`: a `readFile` rejection never carries one, so asking it there
 * answered "no" for every missing profile and warned on every run.
 */
function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function readRiskProfile(path: string): Promise<RiskProfile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return defaultRiskProfile();
    core.warning(`review: could not read risk profile at ${path}: ${String(error)}`);
    return defaultRiskProfile();
  }
  if (raw.trim().length === 0) return defaultRiskProfile();
  if (raw.length > MAX_RISK_PROFILE_CHARS) {
    raw = raw.slice(0, MAX_RISK_PROFILE_CHARS);
  }
  return parseRiskProfile(raw);
}

export function parseRiskProfile(text: string): RiskProfile {
  if (text.trim().length === 0) return defaultRiskProfile();
  const warnings: string[] = [];
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    const reason =
      error instanceof YAMLParseError ? error.message : error instanceof Error ? error.message : "";
    throw new UnreadableRiskProfile([`not valid YAML — ${reason}`]);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new UnreadableRiskProfile(["expected a YAML mapping of risk profile"]);
  }

  const map = document as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown top-level key \`${key}\`; ignored`);
    }
  }

  return {
    version: readVersion(map.version, warnings),
    thresholds: readThresholds(map.thresholds, warnings),
    weights: readWeights(map.weights, warnings),
    paths: readPaths(map.paths, warnings),
    raw: text,
    warnings,
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

function readThresholds(raw: unknown, warnings: string[]): { medium: number; high: number } {
  if (raw === undefined || raw === null) return { ...DEFAULT_THRESHOLDS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`thresholds:` is not a mapping; using defaults");
    return { ...DEFAULT_THRESHOLDS };
  }
  const map = raw as Record<string, unknown>;
  const medium = readNumber(map.medium, "thresholds.medium", DEFAULT_THRESHOLDS.medium, warnings);
  const high = readNumber(map.high, "thresholds.high", DEFAULT_THRESHOLDS.high, warnings);
  if (medium >= high) {
    warnings.push(
      `thresholds require medium < high (got medium=${String(medium)} high=${String(high)}); using defaults`,
    );
    return { ...DEFAULT_THRESHOLDS };
  }
  return { medium, high };
}

function readNumber(raw: unknown, key: string, fallback: number, warnings: string[]): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 100) {
    warnings.push(`\`${key}:\` must be an integer 0..100; using default ${String(fallback)}`);
    return fallback;
  }
  return raw;
}

function readWeights(raw: unknown, warnings: string[]): Readonly<Record<RiskSignalName, number>> {
  const weights: Record<RiskSignalName, number> = { ...DEFAULT_WEIGHTS };
  if (raw === undefined || raw === null) return weights;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`weights:` is not a mapping; using defaults");
    return weights;
  }
  const map = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(map)) {
    if (key === "generated-code") {
      warnings.push("`generated-code` weight is fixed at 0 and cannot be changed");
      continue;
    }
    const signal = WEIGHT_KEYS[key];
    if (signal === undefined) {
      warnings.push(`unknown weight \`${key}\`; ignored`);
      continue;
    }
    weights[signal] = readNumber(value, `weights.${key}`, DEFAULT_WEIGHTS[signal], warnings);
  }
  return weights;
}

function readPaths(
  raw: unknown,
  warnings: string[],
): Readonly<Partial<Record<RiskSignalName, readonly string[]>>> {
  const paths: Partial<Record<RiskSignalName, readonly string[]>> = {};
  if (raw === undefined || raw === null) return paths;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`paths:` is not a mapping; ignoring");
    return paths;
  }
  const map = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(map)) {
    const signal = PATH_KEYS[key];
    if (signal === undefined) {
      warnings.push(`unknown path signal \`${key}\`; ignored`);
      continue;
    }
    if (!Array.isArray(value)) {
      warnings.push(`\`paths.${key}:\` is not a list; ignoring`);
      continue;
    }
    const list: string[] = [];
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        warnings.push(`\`paths.${key}\` entry ${String(index + 1)} is not a string; dropped`);
        continue;
      }
      list.push(entry);
    }
    paths[signal] = list;
  }
  return paths;
}

/**
 * Scores a diff into a tier. Deterministic, pure, and re-runnable (D9): the
 * same files and profile always produce the same assessment.
 */
export function assessRisk(
  allFiles: readonly PrFile[],
  rules: Rules,
  profile: RiskProfile,
): RiskAssessment {
  const { weights, thresholds } = profile;
  const nonGenerated = allFiles.filter((f) => !isGenerated(f.path, rules.generatedExtensions));
  const generatedCount = allFiles.length - nonGenerated.length;
  let signals: RiskSignalEvidence[] = [];

  const lines = nonGenerated.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (lines > 0) {
    const units = Math.min(Math.floor(lines / 100), 4);
    if (units > 0) {
      signals.push({
        signal: "changed_lines",
        weight: weights.changed_lines,
        units,
        contribution: units * weights.changed_lines,
        evidence: [
          `${String(lines)} changed lines${generatedCount > 0 ? ` (${String(generatedCount)} generated excluded)` : ""}`,
        ],
        escalates: false,
      });
    }
  }

  const n = nonGenerated.length;
  if (n > 0) {
    const units = Math.min(Math.floor(n / 5), 3);
    if (units > 0) {
      signals.push({
        signal: "changed_files",
        weight: weights.changed_files,
        units,
        contribution: units * weights.changed_files,
        evidence: [`${String(n)} changed files`],
        escalates: false,
      });
    }
  }

  const order: readonly RiskSignalName[] = [
    "sensitive_path",
    "auth_change",
    "db_migration",
    "public_api",
    "infra_change",
  ];
  for (const signal of order) {
    const matched = nonGenerated.filter((f) => matchesSignal(f, signal, profile));
    if (matched.length === 0) continue;
    signals.push({
      signal,
      weight: weights[signal],
      units: 1,
      contribution: weights[signal],
      evidence: matched.slice(0, 3).map((f) => `\`${f.path}\` matches ${signalLabel(signal)}`),
      escalates: POLICY_HIGH.has(signal),
    });
  }

  // From `allFiles`, not `nonGenerated`: every lockfile is generated-skipped
  // from the prompt by default (`rules.ts`'s `DEFAULT_GENERATED`), but its
  // change is still the dependency signal — a supply-chain edit hides in
  // exactly the file nobody reads, and skipping it from the prompt must not
  // also silence the risk it prices.
  const deps = allFiles.filter((f) => DEPENDENCY_FILES.has(f.path));
  if (deps.length > 0) {
    signals.push({
      signal: "dependency_changes",
      weight: weights.dependency_changes,
      units: 1,
      contribution: weights.dependency_changes,
      evidence: deps.slice(0, 3).map((f) => `\`${f.path}\` is a dependency manifest`),
      escalates: false,
    });
  }

  const sensitive = collectSensitive(nonGenerated, profile);
  if (sensitive.matches.length > 0) {
    signals.push({
      signal: "security_sensitive",
      weight: weights.security_sensitive,
      units: 1,
      contribution: weights.security_sensitive,
      evidence: sensitive.matches.slice(0, 3).map((m) => m.evidence),
      escalates: sensitive.matches.some((m) => m.byPath),
    });
  }

  if (generatedCount > 0) {
    signals.push({
      signal: "generated_code",
      weight: 0,
      units: 0,
      contribution: 0,
      evidence: [`${String(generatedCount)} generated file(s) excluded from volume`],
      escalates: false,
    });
  }

  const score = signals.reduce((sum, s) => sum + s.contribution, 0);
  const qualitativeZero = signals.every((s) => !QUALITATIVE.has(s.signal));
  const escalated = signals.some((s) => s.escalates);

  // Rule B first: no qualitative signal means low whatever the volume.
  // Then Rule A: policy paths escalate whatever the score.
  const base: RiskTier =
    score < thresholds.medium ? "low" : score < thresholds.high ? "medium" : "high";
  const tier: RiskTier = qualitativeZero ? "low" : escalated ? "high" : base;

  if (escalated) {
    const trigger = signals.find((s) => s.escalates);
    if (trigger !== undefined) {
      signals = signals.map((s) =>
        s.signal === trigger.signal
          ? {
              ...s,
              evidence: [...s.evidence, `${trigger.signal} → high by policy`],
            }
          : s,
      );
    }
  }

  return {
    tier,
    score,
    thresholds: { ...thresholds },
    signals,
    profile: profile.raw.length === 0 ? "default" : "repository profile",
  };
}

function matchesSignal(f: PrFile, signal: RiskSignalName, profile: RiskProfile): boolean {
  const globs = [...BUILTIN_PATHS[signal], ...(profile.paths[signal] ?? [])];
  if (globs.some((pattern) => matchesGlob(pattern, f.path))) return true;
  if (signal === "db_migration" && /migration|migrate/i.test(f.path)) return true;
  return false;
}

function signalLabel(signal: RiskSignalName): string {
  switch (signal) {
    case "sensitive_path":
      return "a sensitive path";
    case "auth_change":
      return "an authorization path";
    case "db_migration":
      return "a database-schema path";
    case "public_api":
      return "a public API path";
    case "infra_change":
      return "an infrastructure path";
    default:
      return signal;
  }
}

function collectSensitive(
  files: readonly PrFile[],
  profile: RiskProfile,
): { matches: { evidence: string; byPath: boolean }[] } {
  const globs = [...BUILTIN_PATHS.security_sensitive, ...(profile.paths.security_sensitive ?? [])];
  const matches: { evidence: string; byPath: boolean }[] = [];
  for (const f of files) {
    if (globs.some((pattern) => matchesGlob(pattern, f.path))) {
      matches.push({ evidence: `\`${f.path}\` matches a security-sensitive path`, byPath: true });
    } else if (f.patch !== null) {
      const patch = f.patch.toLowerCase();
      if (SECURITY_PHRASES.some((phrase) => patch.includes(phrase))) {
        matches.push({ evidence: `\`${f.path}\` contains security-sensitive text`, byPath: false });
      }
    }
  }
  return { matches };
}

/** A one-line label for the log line and the summary's Risk row. */
export function describeRisk(assessment: RiskAssessment): string {
  if (assessment.signals.length === 0) return `${assessment.tier} — no risk signals fired`;
  const names = assessment.signals.map((s) => s.signal.replace(/_/g, "-")).join(", ");
  const policy = assessment.signals.find((s) =>
    s.evidence.some((line) => line.endsWith("by policy")),
  );
  return policy !== undefined
    ? `${assessment.tier} — ${policy.signal.replace(/_/g, "-")} — high by policy`
    : `${assessment.tier} — ${names}`;
}
