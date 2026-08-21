/**
 * The dependency-manifest names one review recognises, split by who writes
 * them: a manifest a human edits is reviewable text, a lockfile a tool
 * regenerates is not. The split is the point of the file — `risk.ts` prices
 * a change to either kind as the dependency signal, while `rules.ts` skips
 * only the machine-written half from the prompt by default — and keeping
 * both halves here means the two consumers can never drift apart.
 */

/** Manifests a human edits — reviewable text, never skipped by default. */
export const HUMAN_MANIFESTS: readonly string[] = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "Gemfile",
];

/**
 * Lockfiles a tool regenerates. A model shown eight thousand lines of hashes
 * reviews none of them, so these are skipped from the prompt by default
 * (`rules.ts`'s `DEFAULT_GENERATED`) — while their *change* stays a
 * dependency-risk signal (`risk.ts`), because a supply-chain edit hides in
 * exactly the file nobody reads.
 */
export const LOCKFILES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "Gopkg.lock",
  "Cargo.lock",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "gems.locked",
  "vendor/modules.txt",
];
