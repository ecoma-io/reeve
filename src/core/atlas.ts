/**
 * The workspace atlas: what packages a monorepo says it has, read from its
 * own manifests, never from a checkout.
 *
 * This is evidence, never authority. `triage`'s taxonomy — the warrant's
 * `labels:` — is still the only thing that can apply a label; atlas only
 * supplies `{name, path, description}` per package, a vocabulary anchor for
 * a model and a deterministic path-mention matcher that runs before any
 * model call. Nothing here reads a dependency graph, and nothing here writes
 * anything.
 *
 * **Read from the default branch only, never a PR head** — a manifest
 * description is maintainer-committed text at that point, the same trust
 * tier as a label's own description, not stranger input. It is still
 * length-capped, control-stripped, and meant to be enclosed like every other
 * piece of evidence before it reaches a prompt (`enclose.ts`, at the call
 * site — this module only sanitizes).
 *
 * **A parser that cannot make sense of a manifest degrades to "no atlas",
 * never to a failed run.** Every read here can fail — no root manifest, a
 * malformed one, a repository too large to walk — and every failure returns
 * {@link EMPTY_ATLAS} or a smaller one, not an error. Atlas is optional
 * evidence; nothing downstream may depend on it existing.
 */
import { parse as parseYaml } from "yaml";

/** The GitHub calls atlas needs — declared locally, structurally, so it stays this module's own diff. */
export interface AtlasApi {
  readonly rest: {
    readonly repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: { default_branch?: string } }>;
      getContent(params: { owner: string; repo: string; path: string; ref: string }): Promise<{
        data:
          | { type?: string; content?: string; encoding?: string }
          | { type?: string; content?: string; encoding?: string }[];
      }>;
    };
    readonly git: {
      getTree(params: {
        owner: string;
        repo: string;
        tree_sha: string;
        recursive?: string;
      }): Promise<{
        data: { tree: readonly { path?: string; type?: string }[]; truncated?: boolean };
      }>;
    };
  };
}

/** One package the atlas found. */
export interface Package {
  readonly name: string;
  /** Repository-relative directory, no leading or trailing slash. */
  readonly path: string;
  /** Sanitized, length-capped. Empty string when the manifest gave none. */
  readonly description: string;
}

export interface Atlas {
  readonly packages: readonly Package[];
  /** True when the workspace had more members than {@link ATLAS_MAX_PACKAGES} — the honest partial. */
  readonly truncated: boolean;
}

export const EMPTY_ATLAS: Atlas = { packages: [], truncated: false };

/**
 * Past this many members, atlas stops reading manifests and reports what it
 * found so far as truncated. A workspace this large is not what the
 * evidence case (an area label per component) was ever about, and reading
 * two hundred more `getContent` calls into a triage run would cost more than
 * the evidence is worth.
 */
export const ATLAS_MAX_PACKAGES = 200;

const DESCRIPTION_CAP = 200;

/** Strips control characters and caps length — the same treatment every piece of evidence gets. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control characters
  const stripped = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  return stripped.length > DESCRIPTION_CAP ? `${stripped.slice(0, DESCRIPTION_CAP)}…` : stripped;
}

function decode(entry: { content?: string; encoding?: string }): string | null {
  if (entry.content === undefined) return null;
  if (entry.encoding === "base64") {
    return Buffer.from(entry.content, "base64").toString("utf8");
  }
  return entry.content;
}

async function readFileAt(
  api: AtlasApi,
  at: { readonly owner: string; readonly repo: string },
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await api.rest.repos.getContent({ owner: at.owner, repo: at.repo, path, ref });
    if (Array.isArray(data)) return null; // a directory, not a file
    return decode(data);
  } catch {
    // A miss here is exactly as cheap as `isMissing()` treats it elsewhere:
    // the file simply is not there, which is not a failure atlas reports.
    return null;
  }
}

/** A directory path, as the recursive tree reports it (no leading/trailing slash, `""` for the root). */
function directoriesOf(tree: readonly { path?: string; type?: string }[]): readonly string[] {
  const dirs = new Set<string>([""]);
  for (const entry of tree) {
    if (entry.type === "tree" && entry.path !== undefined) dirs.add(entry.path);
  }
  return [...dirs];
}

/**
 * Turns one workspace glob into a matcher against directory paths.
 *
 * Supports `*` (one path segment), `**` (any number, including zero), and a
 * leading `!` for an exclude glob — the vocabulary every ecosystem's own
 * globs in practice actually use (`packages/*`, `apps/**`, `!**\/internal-*`).
 * No brace expansion, no character classes: a glob this module cannot parse
 * is skipped, not refused — atlas evidence degrades, it never fails a run.
 */
export function globToMatcher(glob: string): {
  readonly test: (dir: string) => boolean;
  readonly exclude: boolean;
} {
  const exclude = glob.startsWith("!");
  const body = exclude ? glob.slice(1) : glob;
  const escaped = body
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "\x00DOUBLESTAR\x00"
        : segment
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "."),
    )
    .join("/")
    // eslint-disable-next-line no-control-regex -- NUL brackets a sentinel no real glob segment can contain
    .replace(/\x00DOUBLESTAR\x00/g, ".*")
    .replace(/\/\.\*\//g, "(?:/.*)?/")
    .replace(/^\.\*\//, "(?:.*/)?");
  const regex = new RegExp(`^${escaped}$`);
  return { test: (dir) => regex.test(dir), exclude };
}

function expandGlobs(globs: readonly string[], directories: readonly string[]): readonly string[] {
  const matchers = globs.map(globToMatcher);
  const matched = new Set<string>();
  for (const dir of directories) {
    if (dir.length === 0) continue;
    let hit = false;
    for (const matcher of matchers) {
      if (matcher.exclude) continue;
      if (matcher.test(dir)) hit = true;
    }
    for (const matcher of matchers) {
      if (matcher.exclude && matcher.test(dir)) hit = false;
    }
    if (hit) matched.add(dir);
  }
  return [...matched].sort();
}

function join(dir: string, file: string): string {
  return dir.length === 0 ? file : `${dir}/${file}`;
}

/** `pnpm-workspace.yaml`'s `packages:` glob list. */
function parsePnpmWorkspace(source: string): readonly string[] {
  try {
    const document: unknown = parseYaml(source);
    if (document === null || typeof document !== "object") return [];
    const packages = (document as Record<string, unknown>).packages;
    if (!Array.isArray(packages)) return [];
    return packages.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/** `package.json`'s `workspaces` — a bare list (npm/yarn classic) or `{packages: [...]}` (yarn 2+). */
function parseNpmWorkspaces(source: string): readonly string[] {
  try {
    const document: unknown = JSON.parse(source);
    if (document === null || typeof document !== "object") return [];
    const workspaces = (document as Record<string, unknown>).workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((entry): entry is string => typeof entry === "string");
    }
    if (workspaces !== null && typeof workspaces === "object") {
      const packages = (workspaces as Record<string, unknown>).packages;
      if (Array.isArray(packages)) {
        return packages.filter((entry): entry is string => typeof entry === "string");
      }
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * `Cargo.toml`'s `[workspace]` `members = [...]`. Hand-rolled and
 * best-effort: this repository carries no TOML dependency, and a full
 * spec-compliant parser is not warranted for a field that is evidence and
 * never authority. Handles the common single-line and multi-line array
 * forms; anything stranger is skipped, not refused.
 */
function parseCargoWorkspace(source: string): readonly string[] {
  const workspaceMatch = /\[workspace]([\s\S]*?)(?:\n\[|$)/.exec(source);
  const section = workspaceMatch?.[1] ?? "";
  const membersMatch = /members\s*=\s*\[([\s\S]*?)]/.exec(section);
  if (membersMatch === null) return [];
  return (membersMatch[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

/** `go.work`'s `use` directives — a single-line `use ./x` or a `use (\n ./x\n ./y\n)` block. */
function parseGoWork(source: string): readonly string[] {
  const dirs: string[] = [];
  const blockMatch = /use\s*\(([\s\S]*?)\)/.exec(source);
  if (blockMatch !== null) {
    for (const line of (blockMatch[1] ?? "").split("\n")) {
      const value = line.trim();
      if (value.length > 0) dirs.push(value);
    }
  }
  for (const match of source.matchAll(/^use\s+(\S+)\s*$/gm)) {
    if (match[1] !== undefined) dirs.push(match[1]);
  }
  return dirs
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((entry) => entry.length > 0);
}

/** Reads one `package.json` member for `{name, description}` (pnpm/npm/yarn). */
async function readNpmMember(
  api: AtlasApi,
  at: { readonly owner: string; readonly repo: string },
  ref: string,
  dir: string,
): Promise<Package | null> {
  const source = await readFileAt(api, at, join(dir, "package.json"), ref);
  if (source === null) return null;
  try {
    const document: unknown = JSON.parse(source);
    if (document === null || typeof document !== "object") return null;
    const fields = document as Record<string, unknown>;
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    if (name.length === 0) return null;
    const description = typeof fields.description === "string" ? sanitize(fields.description) : "";
    return { name, path: dir, description };
  } catch {
    return null;
  }
}

/** Reads one `Cargo.toml` member for `{name, description}` — hand-rolled, same reasoning as the workspace parse. */
async function readCargoMember(
  api: AtlasApi,
  at: { readonly owner: string; readonly repo: string },
  ref: string,
  dir: string,
): Promise<Package | null> {
  const source = await readFileAt(api, at, join(dir, "Cargo.toml"), ref);
  if (source === null) return null;
  const packageMatch = /\[package]([\s\S]*?)(?:\n\[|$)/.exec(source);
  const section = packageMatch?.[1] ?? source;
  const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(section);
  if (nameMatch === null) return null;
  const descriptionMatch = /^\s*description\s*=\s*["']([^"']*)["']/m.exec(section);
  return {
    name: nameMatch[1] ?? "",
    path: dir,
    description: sanitize(descriptionMatch?.[1] ?? ""),
  };
}

/** Reads one `go.mod` member — the module path's last segment is the name; go.mod carries no description. */
async function readGoMember(
  api: AtlasApi,
  at: { readonly owner: string; readonly repo: string },
  ref: string,
  dir: string,
): Promise<Package | null> {
  const source = await readFileAt(api, at, join(dir, "go.mod"), ref);
  if (source === null) return null;
  const moduleMatch = /^module\s+(\S+)/m.exec(source);
  if (moduleMatch === null) return null;
  const modulePath = moduleMatch[1] ?? "";
  const segments = modulePath.split("/");
  const name = segments[segments.length - 1] ?? modulePath;
  return { name, path: dir, description: "" };
}

/**
 * Reads the workspace atlas from a repository's default branch (or `ref`,
 * when given — tests pass one so fixtures do not need a `repos.get` stub).
 *
 * One `repos.get` (only when `ref` is not supplied) + one recursive
 * `git.getTree` + up to four root-manifest reads + one read per matched
 * member, capped at {@link ATLAS_MAX_PACKAGES}. No manifest found at the
 * root is the common case and costs exactly the tree call plus the root
 * probes — {@link EMPTY_ATLAS}, not an error.
 */
export async function readAtlas(
  api: AtlasApi,
  at: { readonly owner: string; readonly repo: string },
  ref?: string,
): Promise<Atlas> {
  let head = ref;
  if (head === undefined) {
    try {
      const { data } = await api.rest.repos.get({ owner: at.owner, repo: at.repo });
      head = data.default_branch;
    } catch {
      return EMPTY_ATLAS;
    }
  }
  if (head === undefined || head.length === 0) return EMPTY_ATLAS;
  // Reassigned into a `const` so the narrowing above survives into the
  // closure below — TypeScript does not carry a `let`'s narrowed type into a
  // nested function, only a `const`'s.
  const resolvedHead = head;

  let tree: readonly { path?: string; type?: string }[];
  try {
    const { data } = await api.rest.git.getTree({
      owner: at.owner,
      repo: at.repo,
      tree_sha: resolvedHead,
      recursive: "1",
    });
    tree = data.tree;
  } catch {
    return EMPTY_ATLAS;
  }

  const rootFiles = new Set(
    tree
      .filter((entry) => entry.type === "blob" && entry.path !== undefined)
      .map((entry) => entry.path ?? ""),
  );
  const directories = directoriesOf(tree);

  const members = new Map<string, { readonly dir: string; readonly read: typeof readNpmMember }>();

  async function collect(
    manifestFile: string,
    parseGlobs: (source: string) => readonly string[],
    read: typeof readNpmMember,
  ): Promise<void> {
    if (!rootFiles.has(manifestFile)) return;
    const source = await readFileAt(api, at, manifestFile, resolvedHead);
    if (source === null) return;
    const globs = parseGlobs(source);
    if (globs.length === 0) return;
    for (const dir of expandGlobs(globs, directories)) {
      if (!members.has(dir)) members.set(dir, { dir, read });
    }
  }

  await collect("pnpm-workspace.yaml", parsePnpmWorkspace, readNpmMember);
  await collect("package.json", parseNpmWorkspaces, readNpmMember);
  await collect("Cargo.toml", parseCargoWorkspace, readCargoMember);
  await collect("go.work", parseGoWork, readGoMember);

  const dirs = [...members.values()];
  const truncated = dirs.length > ATLAS_MAX_PACKAGES;
  const bounded = truncated ? dirs.slice(0, ATLAS_MAX_PACKAGES) : dirs;

  const packages: Package[] = [];
  for (const { dir, read } of bounded) {
    const found = await read(api, at, resolvedHead, dir);
    if (found !== null) packages.push({ ...found, description: sanitize(found.description) });
  }

  return { packages, truncated };
}

/** Evidence a deterministic path-mention match produced — never authority, never auto-applied. */
export interface AtlasEvidence {
  /** Human-readable lines, safe to enclose and show in a prompt or a summary. */
  readonly lines: readonly string[];
  /** Label names (from `paths:`) or package names a path mention in the text pointed at. */
  readonly candidates: readonly string[];
}

const PATH_TOKEN = /(?:^|[\s(`'"])((?:[\w.-]+\/){1,})[\w.-]+(?:\.\w+)?/g;

/**
 * Extracts path-like tokens from `text` and matches them, by longest
 * prefix, against every atlas package's own path and every label's `paths:`
 * globs — deterministic, model-free, and reading paths only, never a
 * manifest's description, which is what makes it injection-proof by
 * construction: nothing a stranger writes in a thread body can make this
 * function apply anything, because it never applies anything at all.
 */
export function matchAtlasEvidence(
  atlas: Atlas,
  text: string,
  labelPaths: ReadonlyMap<string, readonly string[]>,
): AtlasEvidence {
  const tokens = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const candidate = match[0].trim().replace(/^[(`'"]/, "");
    if (candidate.includes("/")) tokens.add(candidate);
  }
  if (tokens.size === 0) return { lines: [], candidates: [] };

  const lines: string[] = [];
  const candidates = new Set<string>();

  for (const token of tokens) {
    let best:
      | { readonly kind: "package"; readonly pkg: Package }
      | { readonly kind: "label"; readonly label: string }
      | null = null;
    let bestLength = 0;

    for (const pkg of atlas.packages) {
      if (
        (token.startsWith(`${pkg.path}/`) || token === pkg.path) &&
        pkg.path.length > bestLength
      ) {
        best = { kind: "package", pkg };
        bestLength = pkg.path.length;
      }
    }
    for (const [label, paths] of labelPaths) {
      for (const prefix of paths) {
        if ((token.startsWith(`${prefix}/`) || token === prefix) && prefix.length > bestLength) {
          best = { kind: "label", label };
          bestLength = prefix.length;
        }
      }
    }

    if (best === null) continue;
    if (best.kind === "package") {
      lines.push(`\`${token}\` matches package \`${best.pkg.name}\` at \`${best.pkg.path}\`.`);
      candidates.add(best.pkg.name);
    } else {
      lines.push(`\`${token}\` matches \`${best.label}\`'s configured \`paths:\`.`);
      candidates.add(best.label);
    }
  }

  return { lines, candidates: [...candidates] };
}
