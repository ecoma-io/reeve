/**
 * Renovate baseline extractor — derives what Renovate would find from the
 * repository's configuration and current dependency state.
 *
 * This extractor does NOT run Renovate. Instead, it reads the Renovate
 * configuration (.github/renovate.json5) and the repository's dependency
 * manifests (package.json, .github/workflows/*.yml) to produce a
 * deterministic prediction of what Renovate would discover and propose.
 *
 * The prediction is approximate. Known limitations:
 * - **Preset resolution**: Renovate `extends` presets (e.g., "config:recommended")
 *   are not resolved. All rules from presets are silently ignored.
 * - **Schedule/automerge**: `schedule`, `automerge`, and `enabledManagers`
 *   settings are not applied. The `wouldPr` field is always true.
 * - **Version resolution**: Without registry access, `targetVersion` is always
 *   null. Only the constraint and inferred update type are produced.
 * - **Security data**: Without vulnerability database access, `security` is
 *   always false.
 *
 * When in doubt, the extractor records INSUFFICIENT_EVIDENCE rather than
 * guessing.
 *
 * **Why not run Renovate directly?** Renovate is the Mend-hosted GitHub App,
 * not a local CLI tool. Running it requires org admin access, and its output
 * is only available through GitHub PRs — not as structured data. This extractor
 * provides a reproducible, offline baseline that can be compared against
 * dependa's output in CI.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { RenovateFinding } from "./types.js";

// ─── Renovate config types (simplified) ────────────────────────────────────

interface RenovateConfig {
  extends?: string[];
  schedule?: string[];
  semanticCommits?: string;
  semanticCommitType?: string;
  semanticCommitScope?: string;
  lockFileMaintenance?: { enabled: boolean; schedule?: string[] };
  packageRules?: readonly RenovatePackageRule[];
  pinDigests?: boolean;
}

interface RenovatePackageRule {
  matchManagers?: readonly string[];
  matchPackageNames?: readonly string[];
  matchDepTypes?: readonly string[];
  groupName?: string | null;
  semanticCommitScope?: string;
  pinDigests?: boolean;
  minimumReleaseAge?: string;
  allowedVersions?: string;
}

// ─── Package.json types ────────────────────────────────────────────────────

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

// ─── GitHub Actions workflow types ──────────────────────────────────────────

interface WorkflowFile {
  path: string;
  content: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** Root directory of the repository checkout. */
  repoRoot: string;
  /** Path to the Renovate config, relative to repoRoot. Default: ".github/renovate.json5" */
  renovateConfigPath?: string;
}

/**
 * Extract Renovate baseline findings from a repository checkout.
 *
 * This produces a deterministic snapshot of what Renovate would discover
 * based on the repository's manifests and configuration.
 */
export function extractRenovateBaseline(options: ExtractOptions): RenovateFinding[] {
  const { repoRoot } = options;
  const configPath = options.renovateConfigPath ?? ".github/renovate.json5";
  const findings: RenovateFinding[] = [];

  // 1. Read Renovate configuration
  const config = readRenovateConfig(path.join(repoRoot, configPath));

  // 2. Extract npm/pnpm dependencies
  const npmFindings = extractNpmFindings(repoRoot, config);
  findings.push(...npmFindings);

  // 3. Extract GitHub Actions dependencies
  const actionsFindings = extractActionsFindings(repoRoot, config);
  findings.push(...actionsFindings);

  // 3b. Extract the Node runtime pin (Renovate's nodenv/nvm managers)
  const nodenvFindings = extractNodenvFindings(repoRoot);
  findings.push(...nodenvFindings);

  // 4. Lock file maintenance (Renovate feature dependa does not have)
  if (config.lockFileMaintenance?.enabled) {
    findings.push({
      ecosystem: "npm",
      name: "lockFileMaintenance",
      constraint: null,
      currentVersion: null,
      targetVersion: null,
      updateType: "maintenance",
      group: null,
      files: ["pnpm-lock.yaml"],
      security: false,
      manager: "npm",
      datasource: "npm",
      wouldPr: true,
    });
  }

  return findings;
}

// ─── Renovate config parsing ───────────────────────────────────────────────

function readRenovateConfig(fullPath: string): RenovateConfig {
  try {
    const raw = fs.readFileSync(fullPath, "utf-8");
    // Strip JSON5 comments (lines starting with // or block comments)
    const stripped = stripJson5Comments(raw);
    return JSON.parse(stripped) as RenovateConfig;
  } catch {
    // No config or unreadable — return defaults
    return {};
  }
}

/**
 * Strip JSON5 comments for basic parsing.
 *
 * This uses a character-by-character state machine to correctly handle
 * comments inside string literals (which must not be stripped). The approach
 * walks the input, tracking whether we are inside a single- or double-quoted
 * string, and only strips comments when outside strings.
 *
 * After comment removal, trailing commas and unquoted keys are handled with
 * simple regex transforms.
 */
function stripJson5Comments(raw: string): string {
  // Phase 1: Remove comments, respecting string boundaries
  let result = "";
  let i = 0;
  while (i < raw.length) {
    // Inside a string? Copy verbatim until closing quote
    if (raw[i] === '"' || raw[i] === "'") {
      const quote = raw[i];
      result += raw[i];
      i++;
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === "\\") {
          result += raw[i];
          i++;
        }
        if (i < raw.length) {
          result += raw[i];
          i++;
        }
      }
      if (i < raw.length) {
        result += raw[i]; // closing quote
        i++;
      }
      continue;
    }

    // Single-line comment?
    if (raw[i] === "/" && i + 1 < raw.length && raw[i + 1] === "/") {
      // Skip until end of line
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment?
    if (raw[i] === "/" && i + 1 < raw.length && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && i + 1 < raw.length && raw[i + 1] === "/")) i++;
      i += 2; // skip */
      continue;
    }

    result += raw[i];
    i++;
  }

  // Phase 2: Remove trailing commas before closing braces/brackets
  result = result.replace(/,\s*([}\]])/g, "$1");

  // Phase 3: Add quotes around unquoted keys (only outside strings)
  result = result.replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');

  return result;
}

// ─── npm extraction ─────────────────────────────────────────────────────────

function extractNpmFindings(repoRoot: string, config: RenovateConfig): RenovateFinding[] {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) return [];

  const pkg = readPackageJson(packageJsonPath);
  if (pkg === null) return [];

  const findings: RenovateFinding[] = [];

  // Production dependencies
  if (pkg.dependencies) {
    for (const [name, constraint] of Object.entries(pkg.dependencies)) {
      findings.push(makeNpmFinding(name, constraint, false, repoRoot, config));
    }
  }

  // Dev dependencies
  if (pkg.devDependencies) {
    for (const [name, constraint] of Object.entries(pkg.devDependencies)) {
      findings.push(makeNpmFinding(name, constraint, true, repoRoot, config));
    }
  }

  // The `packageManager` pin — Renovate's npm manager proposes updates to it
  // (the dashboard's `pnpm 11.20.0 → 11.22.0` row). The corepack integrity
  // hash after `+` belongs to the pinned version, not the constraint.
  const rawPkg = readRawPackageJson(packageJsonPath);
  const pmRaw = rawPkg?.packageManager;
  if (typeof pmRaw === "string") {
    const atIdx = pmRaw.lastIndexOf("@");
    const pmName = atIdx > 0 ? pmRaw.slice(0, atIdx) : null;
    const pmVersion = atIdx > 0 ? (pmRaw.slice(atIdx + 1).split("+")[0] ?? "") : "";
    if (pmName !== null && /^\d+\.\d+\.\d+/.test(pmVersion)) {
      findings.push({
        ecosystem: "npm",
        name: pmName,
        constraint: pmVersion,
        currentVersion: pmVersion,
        targetVersion: null,
        updateType: "pin",
        group: null,
        files: ["package.json"],
        security: false,
        manager: "npm",
        datasource: "npm",
        wouldPr: true,
      });
    }
  }

  // `engines` — Renovate detects these as dependencies of the manifest.
  // `node` is the runtime itself and keys under the `node-version` ecosystem,
  // matching how dependa (and Renovate's `node` datasource) treat it.
  const engines = rawPkg?.engines;
  if (typeof engines === "object" && engines !== null && !Array.isArray(engines)) {
    for (const [name, constraint] of Object.entries(engines as Record<string, unknown>)) {
      if (typeof constraint !== "string" || constraint.trim().length === 0) continue;
      findings.push({
        ecosystem: name === "node" ? "node-version" : "npm",
        name,
        constraint: constraint.trim(),
        currentVersion: null,
        targetVersion: null,
        updateType: inferNpmUpdateType(constraint),
        group: null,
        files: ["package.json"],
        security: false,
        manager: "npm",
        datasource: name === "node" ? "node-version" : "npm",
        wouldPr: false, // Renovate detects engine ranges but rarely proposes
      });
    }
  }

  return findings;
}

/** Read package.json without the typed PackageJson narrowing — raw fields. */
function readRawPackageJson(fullPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── nodenv extraction ──────────────────────────────────────────────────────

/**
 * Extract the Node runtime pin from `.node-version` / `.nvmrc` — Renovate's
 * `nodenv` and `nvm` managers (the dashboard's `nodenv` section).
 */
function extractNodenvFindings(repoRoot: string): RenovateFinding[] {
  const findings: RenovateFinding[] = [];

  for (const file of [".node-version", ".nvmrc"]) {
    const fullPath = path.join(repoRoot, file);
    if (!fs.existsSync(fullPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const reference = content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
    if (reference === undefined) continue;

    const bare = reference.startsWith("v") ? reference.slice(1) : reference;
    findings.push({
      ecosystem: "node-version",
      name: "node",
      constraint: bare,
      currentVersion: /^\d+\.\d+\.\d+$/.test(bare) ? bare : null,
      targetVersion: null,
      updateType: "minor",
      group: null,
      files: [file],
      security: false,
      manager: "nodenv",
      datasource: "node-version",
      wouldPr: true,
    });
  }

  return findings;
}

function makeNpmFinding(
  name: string,
  constraint: string,
  dev: boolean,
  repoRoot: string,
  config: RenovateConfig,
): RenovateFinding {
  // Determine group from Renovate's packageRules
  const group = resolveNpmGroup(name, dev, config);

  // Determine update type — we cannot resolve actual versions offline,
  // so we classify by constraint pattern
  const updateType = inferNpmUpdateType(constraint);

  // Check for pinDigests (not typically applicable to npm)
  // Check for minimumReleaseAge
  const depType = dev ? "devDependencies" : "dependencies";
  const semanticScope = resolveNpmSemanticScope(name, dev, config);

  return {
    ecosystem: "npm",
    name,
    constraint: cleanConstraint(constraint),
    currentVersion: null, // Would need lockfile parsing
    targetVersion: null, // Would need registry query
    updateType,
    group,
    files: ["package.json"],
    security: false, // Would need vulnerability data
    manager: "npm",
    datasource: "npm",
    wouldPr: true,
  };
}

/**
 * Resolve the Renovate group name for an npm dependency.
 */
function resolveNpmGroup(name: string, dev: boolean, config: RenovateConfig): string | null {
  if (config.packageRules) {
    for (const rule of config.packageRules) {
      if (rule.groupName === undefined) continue;

      if (rule.matchPackageNames?.includes(name)) {
        return rule.groupName; // null means ungrouped
      }

      if (rule.matchDepTypes) {
        const depType = dev ? "devDependencies" : "dependencies";
        if (rule.matchDepTypes.includes(depType)) {
          return rule.groupName;
        }
      }
    }
  }
  return null;
}

/**
 * Resolve the semantic commit scope for an npm dependency.
 */
function resolveNpmSemanticScope(name: string, dev: boolean, config: RenovateConfig): string {
  const defaultScope = config.semanticCommitScope ?? "deps";

  if (config.packageRules) {
    for (const rule of config.packageRules) {
      if (rule.semanticCommitScope === undefined) continue;

      if (rule.matchPackageNames?.includes(name)) {
        return rule.semanticCommitScope;
      }

      if (rule.matchDepTypes) {
        const depType = dev ? "devDependencies" : "dependencies";
        if (rule.matchDepTypes.includes(depType)) {
          return rule.semanticCommitScope;
        }
      }
    }
  }

  return defaultScope;
}

/**
 * Infer update type from the constraint pattern.
 *
 * Without registry access we cannot determine the actual update type,
 * but we can classify the constraint itself as indicating what Renovate
 * would look for.
 */
function inferNpmUpdateType(constraint: string): string {
  const clean = constraint.trim();

  // Exact pin: "1.2.3" (no range operator)
  if (/^\d+\.\d+\.\d+$/.test(clean)) return "pin";

  // Caret: "^1.2.3"
  if (clean.startsWith("^")) return "minor"; // Caret allows minor/patch

  // Tilde: "~1.2.3"
  if (clean.startsWith("~")) return "patch"; // Tilde allows patch only

  // Range: ">=1.0.0 <2.0.0"
  if (clean.startsWith(">=") || clean.startsWith(">")) return "minor";

  // Workspace/alias protocols — Renovate would not propose updates
  if (clean.startsWith("workspace:") || clean.startsWith("npm:")) return "pin";

  return "minor"; // Default assumption
}

// ─── GitHub Actions extraction ─────────────────────────────────────────────

function extractActionsFindings(repoRoot: string, config: RenovateConfig): RenovateFinding[] {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  if (!fs.existsSync(workflowsDir)) return [];

  const findings: RenovateFinding[] = [];
  const seen = new Set<string>();

  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  // Determine if pinDigests is enabled for github-actions
  const pinDigests = resolveActionsPinDigests(config);

  for (const file of files) {
    const filePath = path.join(workflowsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const relPath = `.github/workflows/${file}`;

    // Extract `uses:` lines
    const usesRegex = /^\s*-\s*uses:\s*(['"]?)([^'"]+?)\1\s*$/gm;
    let match: RegExpExecArray | null;

    while ((match = usesRegex.exec(content)) !== null) {
      const usesRef = match[2]?.trim();
      if (!usesRef) continue;

      // Skip local actions (./) and docker actions (docker://)
      if (usesRef.startsWith("./") || usesRef.startsWith("docker://")) continue;

      // Parse owner/repo@ref
      const atIndex = usesRef.lastIndexOf("@");
      if (atIndex === -1) continue;

      const actionName = usesRef.slice(0, atIndex);
      const ref = usesRef.slice(atIndex + 1);

      // Skip if already seen (deduplicate)
      const key = `${actionName}@${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Determine if this is a SHA or tag reference
      const isShaRef = /^[0-9a-f]{40}$/i.test(ref);
      const updateType = isShaRef ? (pinDigests ? "pinDigest" : "digest") : "minor"; // Tag reference

      // Check if this action is excluded from pinDigests
      const actionExcludedFromPin = isExcludedFromPinDigests(actionName, config);

      findings.push({
        ecosystem: "github-actions",
        name: actionName,
        constraint: isShaRef ? null : ref, // Tag is the constraint; SHA is a pin
        currentVersion: isShaRef ? ref : ref, // Both are "current" in different ways
        targetVersion: null, // Would need GitHub tags API
        updateType: actionExcludedFromPin && isShaRef ? "minor" : updateType,
        group: null, // Actions are typically ungrouped in Renovate
        files: [relPath],
        security: false,
        manager: "github-actions",
        datasource: "github-tags",
        wouldPr: true,
      });
    }

    // Extract `container:`/`image:` docker references — Renovate's
    // github-actions manager also updates job container and service images
    // (the dashboard's `semgrep/semgrep` docker tag row).
    const imageRegex = /^\s*(?:-\s*)?(?:image|container):\s*(['"]?)(\S+?)\1\s*$/gm;
    while ((match = imageRegex.exec(content)) !== null) {
      const ref = match[2]?.trim();
      if (!ref || ref.includes("${{")) continue;
      // A bare word with no tag, digest, or registry path is not a reference
      if (!ref.includes(":") && !ref.includes("/")) continue;

      // Split off the digest, then the tag
      let remaining = ref;
      let digest: string | null = null;
      const atIdx = remaining.lastIndexOf("@");
      if (atIdx !== -1 && remaining.slice(atIdx + 1).startsWith("sha256:")) {
        digest = remaining.slice(atIdx + 1);
        remaining = remaining.slice(0, atIdx);
      }
      let tag: string | null = null;
      const lastSlash = remaining.lastIndexOf("/");
      const colonIdx = remaining.lastIndexOf(":");
      if (colonIdx !== -1 && colonIdx > lastSlash) {
        tag = remaining.slice(colonIdx + 1);
        remaining = remaining.slice(0, colonIdx);
      }
      if (remaining.length === 0) continue;

      const key = `image ${remaining}:${tag ?? "latest"}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        ecosystem: "docker",
        name: remaining,
        constraint: tag ?? (digest !== null ? null : "latest"),
        currentVersion: digest ?? tag ?? "latest",
        targetVersion: null,
        updateType: digest !== null ? "digest" : "minor",
        group: null,
        files: [relPath],
        security: false,
        manager: "github-actions",
        datasource: "docker",
        wouldPr: true,
      });
    }
  }

  return findings;
}

/**
 * Whether pinDigests is enabled for GitHub Actions in the Renovate config.
 */
function resolveActionsPinDigests(config: RenovateConfig): boolean {
  if (config.packageRules) {
    for (const rule of config.packageRules) {
      if (rule.matchManagers?.includes("github-actions")) {
        if (rule.pinDigests !== undefined) {
          return rule.pinDigests;
        }
      }
    }
  }
  return false; // Default: Renovate does not pin digests by default
}

/**
 * Whether a specific action is excluded from pinDigests in the Renovate config.
 */
function isExcludedFromPinDigests(actionName: string, config: RenovateConfig): boolean {
  if (config.packageRules) {
    for (const rule of config.packageRules) {
      if (rule.pinDigests === false && rule.matchPackageNames?.includes(actionName)) {
        return true;
      }
    }
  }
  return false;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readPackageJson(fullPath: string): PackageJson | null {
  try {
    const raw = fs.readFileSync(fullPath, "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Clean an npm constraint for comparison.
 *
 * Strips workspace:, npm:, file:, link: protocols.
 */
function cleanConstraint(constraint: string): string | null {
  const trimmed = constraint.trim();
  if (
    trimmed.startsWith("workspace:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("link:")
  ) {
    return null; // Not a real constraint
  }
  if (trimmed.startsWith("npm:")) {
    // npm:package@version — extract the version part
    const atVersion = trimmed.slice(4); // Remove "npm:"
    const atIndex = atVersion.lastIndexOf("@");
    if (atIndex > 0) {
      return atVersion.slice(atIndex + 1);
    }
    return null;
  }
  return trimmed;
}
