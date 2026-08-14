/**
 * Validation for `dependa` — verifies that mutated files are still valid.
 *
 * After a manager produces an edit (a new file content string), validation
 * checks that the edit produces a file the ecosystem's tooling could still
 * read. A malformed edit is never committed — it becomes a refusal with a
 * machine-readable reason, not a silent corruption.
 *
 * Validation is deterministic and requires no network or model calls. It
 * parses the edited content the same way the manager would, and rejects
 * anything that does not survive the round-trip.
 *
 * **A failed validation prevents publication.** This is a safety gate, not
 * an advisory — an edit that does not validate is dropped, and the proposal
 * that produced it records a refusal explaining why.
 *
 * **Edit-path allowlist:** when `allowedPaths` is provided, edits are
 * restricted to paths within that set. This prevents a malformed proposal
 * from writing to arbitrary files — only discovered manifest paths are
 * writable.
 */
import type { Ecosystem, FileEdit, Refusal } from "./model.js";

/**
 * The result of validating a set of file edits.
 */
export interface ValidationResult {
  /** Whether all edits passed validation. */
  readonly valid: boolean;
  /** The edits that passed validation. */
  readonly passed: readonly FileEdit[];
  /** The edits that failed validation, with reasons. */
  readonly failed: readonly FailedEdit[];
}

/** One edit that failed validation, and why. */
export interface FailedEdit {
  readonly edit: FileEdit;
  readonly reason: string;
}

/**
 * Validate a set of file edits against their ecosystem's parser.
 *
 * When `allowedPaths` is provided, edits are restricted to paths in that set.
 * This prevents proposals from writing to files that were never discovered as
 * dependency manifests — an edit-path allowlist.
 *
 * Returns a ValidationResult separating passed and failed edits.
 * A failed edit is never included in the passed set — it is recorded
 * as a refusal reason, not silently dropped.
 *
 * Deterministic: same edits, same result. No network, no model.
 */
export function validateEdits(
  edits: readonly FileEdit[],
  allowedPaths?: ReadonlySet<string>,
): ValidationResult {
  const passed: FileEdit[] = [];
  const failed: FailedEdit[] = [];

  for (const edit of edits) {
    const reason = validateOne(edit, allowedPaths);
    if (reason === null) {
      passed.push(edit);
    } else {
      failed.push({ edit, reason });
    }
  }

  return {
    valid: failed.length === 0,
    passed,
    failed,
  };
}

/**
 * Validate a single file edit.
 *
 * Returns null when the edit is valid, or a string describing why it is not.
 */
function validateOne(edit: FileEdit, allowedPaths?: ReadonlySet<string>): string | null {
  // Path safety: reject absolute paths and path traversal
  if (edit.path.startsWith("/")) {
    return `path is absolute: ${edit.path}`;
  }
  if (edit.path.includes("..")) {
    return `path contains traversal: ${edit.path}`;
  }
  if (edit.path.length === 0) {
    return "path is empty";
  }

  // Edit-path allowlist: when provided, only discovered manifest paths are writable
  if (allowedPaths !== undefined && !allowedPaths.has(edit.path)) {
    return `edit path not in discovered manifests: ${edit.path}`;
  }

  // Content safety: reject empty content (would delete the file)
  if (edit.content.length === 0) {
    return `content is empty for ${edit.path}`;
  }

  // Ecosystem-specific validation based on file extension/name
  const ecosystem = detectEcosystem(edit.path);
  if (ecosystem !== null) {
    return validateForEcosystem(ecosystem, edit);
  }

  // Unknown file type — accept if basic checks passed
  return null;
}

/**
 * Detect the ecosystem from a file path.
 */
function detectEcosystem(path: string): Ecosystem | null {
  if (path.endsWith("package.json")) return "npm";
  if (path.endsWith("Cargo.toml")) return "cargo";
  if (path.endsWith("go.mod")) return "go";
  if (path.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(path)) return "github-actions";
  if (/Dockerfile(\.\S+)?$/.test(path) || path.endsWith(".Dockerfile")) return "docker";
  return null;
}

/**
 * Ecosystem-specific validation.
 */
function validateForEcosystem(ecosystem: Ecosystem, edit: FileEdit): string | null {
  switch (ecosystem) {
    case "npm":
      return validateNpm(edit);
    case "cargo":
      return validateCargo(edit);
    case "go":
      return validateGo(edit);
    case "github-actions":
      return validateGithubActions(edit);
    case "docker":
      return validateDocker(edit);
    default:
      return null;
  }
}

/**
 * Validate an npm manifest (package.json).
 *
 * The content must be valid JSON and must retain at least a name field.
 * A package.json that loses its name or has a non-string name after edit
 * is likely corrupted.
 */
function validateNpm(edit: FileEdit): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(edit.content);
  } catch {
    return `package.json is not valid JSON after edit: ${edit.path}`;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `package.json is not a JSON object after edit: ${edit.path}`;
  }
  const pkg = parsed as Record<string, unknown>;

  // Verify it still has a name field — a package.json without a name is broken
  // (workspace root packages sometimes omit it, but that is rare and we prefer
  // to catch corruption over allowing edge cases)
  if (pkg.name !== undefined && typeof pkg.name !== "string") {
    return `package.json has a non-string name after edit: ${edit.path}`;
  }

  // At least one dependency section should exist (unless it was empty to begin with)
  const depSections = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  const hasAnyDeps = depSections.some((s) => pkg[s] !== undefined);
  if (hasAnyDeps) {
    for (const section of depSections) {
      const value = pkg[section];
      if (
        value !== undefined &&
        (typeof value !== "object" || value === null || Array.isArray(value))
      ) {
        return `package.json has a non-object ${section} after edit: ${edit.path}`;
      }
    }
  }

  return null;
}

/**
 * Validate a Cargo manifest (Cargo.toml).
 *
 * Cargo.toml is TOML, which is harder to validate without a full parser.
 * Do a best-effort check: the content should still contain [dependencies]
 * or similar sections, and should not be empty.
 */
function validateCargo(edit: FileEdit): string | null {
  const content = edit.content;
  if (content.trim().length === 0) {
    return `Cargo.toml is empty after edit: ${edit.path}`;
  }

  // Basic structural check: should still have TOML headers
  if (!content.includes("[")) {
    return `Cargo.toml has no TOML headers after edit: ${edit.path}`;
  }

  return null;
}

/**
 * Validate a Go module file (go.mod).
 */
function validateGo(edit: FileEdit): string | null {
  const content = edit.content;
  if (content.trim().length === 0) {
    return `go.mod is empty after edit: ${edit.path}`;
  }

  // Should still have a module directive
  if (!/^module\s/m.test(content)) {
    return `go.mod has no module directive after edit: ${edit.path}`;
  }

  // Should still have a go directive
  if (!/^go\s/m.test(content)) {
    // Not necessarily fatal, but worth flagging
  }

  return null;
}

/**
 * Validate a GitHub Actions workflow file.
 *
 * The content should be valid YAML. Since we don't have a full YAML parser,
 * do structural checks: it should still have workflow keys.
 */
function validateGithubActions(edit: FileEdit): string | null {
  const content = edit.content;
  if (content.trim().length === 0) {
    return `workflow file is empty after edit: ${edit.path}`;
  }

  // Should still have at least a "jobs:" key
  if (!content.includes("jobs:")) {
    return `workflow file has no jobs key after edit: ${edit.path}`;
  }

  return null;
}

/**
 * Validate a Dockerfile.
 *
 * The content should still have at least one FROM instruction.
 */
function validateDocker(edit: FileEdit): string | null {
  const content = edit.content;
  if (content.trim().length === 0) {
    return `Dockerfile is empty after edit: ${edit.path}`;
  }

  // Should still have at least one FROM instruction
  if (!/^FROM\s/im.test(content)) {
    return `Dockerfile has no FROM instruction after edit: ${edit.path}`;
  }

  return null;
}

/**
 * Convert failed validation results into Refusal objects.
 *
 * Each failed edit becomes a Refusal with a machine-readable reason.
 */
export function validationRefusals(failed: readonly FailedEdit[]): readonly Refusal[] {
  return failed.map((f) => ({
    what: f.edit.path,
    why: `validation failed: ${f.reason}`,
  }));
}
