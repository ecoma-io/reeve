/**
 * The pull request a review runs on, and the diff it has to say something
 * about.
 *
 * `core/forge.ts` deliberately stops at issues: the one port every thread-
 * editing duty needs. A code review needs a pull request — head and base,
 * draft state, merged state, and the file list with its patches — which is
 * three methods (`pulls.get`, `pulls.listFiles`) no other duty uses. Same rule
 * `duplicate` follows for its comment port: widening `TrackerApi` would make
 * every other duty's hand-built test double grow methods it never calls, so
 * this module declares its own structural `PrApi`, satisfied by the same real
 * Octokit client every other port is.
 *
 * The diff is the whole universe this duty is allowed to speak about: a
 * finding that names a file, a line, or a rule the diff cannot prove was never
 * admitted. Every classification below exists to define *what the model was
 * shown* — the ignored files, the generated files, the binary files, the
 * removed files, and the patch text that ran past the run's own cap are all
 * deliberately absent from the review, and *why* is this module's answer.
 */
import { isBotAuthor, type Author } from "../../core/forge.js";

/**
 * The part of an Octokit client a review reads: the pull request's standing
 * and its file list. Declared structurally, the same way `CommentApi` in
 * `duplicate/publish.ts` is, so a real client and a hand-built test double
 * satisfy it identically.
 */
export interface PrApi {
  readonly rest: {
    readonly pulls: {
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{
        data: {
          title?: string;
          body?: string | null;
          state?: string;
          draft?: boolean;
          merged?: boolean;
          /** The head SHA this review documents — every run happens against one, and says so. */
          head?: { sha?: string };
          base?: { sha?: string };
          user?: Author | null;
          labels?: (string | { name?: string })[];
        };
      }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: {
          filename?: string;
          previous_filename?: string | null;
          status?: string;
          additions?: number;
          deletions?: number;
          changes?: number;
          /** The unified diff, or null when GitHub no longer serves one — a binary file, or a diff too large to inline. */
          patch?: string | null;
        }[];
      }>;
    };
  };
}

/** A pull request as this duty reads it. */
export interface PullStanding {
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly draft: boolean;
  readonly merged: boolean;
  /** The head SHA, or "" when the API answered without one. */
  readonly headSha: string;
  readonly baseSha: string;
  readonly author: { readonly login: string; readonly isBot: boolean };
  readonly labels: readonly string[];
  /** Every label resolved through the same two shapes the REST API sends them in. */
}

/** One file the pull request touches, exactly as the API reported it. */
export interface PrFile {
  readonly path: string;
  readonly status: "added" | "modified" | "removed" | "renamed" | "unknown";
  readonly previousPath: string | null;
  readonly additions: number;
  readonly deletions: number;
  /** The unified diff, or null — binary, or over the API's own size limit. */
  readonly patch: string | null;
}

/**
 * How many files one run reads, and how many pages of the listing it will walk.
 *
 * A pull request's file list is bounded by what GitHub serves per page; a
 * pathological PR with hundreds of files either exceeds this run's `max-diff`
 * cap well before this and is reported as truncated, or fits and is served. The
 * pages exist so a PR with ninety-one files is not silently reviewed against
 * the first ninety.
 */
const FILE_PAGE = 100;
const FILE_PAGES = 10;

const STATUS: Readonly<Record<string, PrFile["status"]>> = {
  added: "added",
  modified: "modified",
  removed: "removed",
  renamed: "renamed",
};

/** Reads the pull request's standing — one call, the same one `readStanding` is for issues. */
export async function readPr(
  api: PrApi,
  at: { owner: string; repo: string; number: number },
): Promise<PullStanding> {
  const { data } = await api.rest.pulls.get({
    owner: at.owner,
    repo: at.repo,
    pull_number: at.number,
  });

  return {
    title: data.title ?? "",
    body: data.body ?? "",
    state: data.state ?? "open",
    draft: data.draft === true,
    merged: data.merged === true,
    headSha: data.head?.sha ?? "",
    baseSha: data.base?.sha ?? "",
    author: {
      login: data.user?.login ?? "",
      isBot: isBotAuthor(data.user),
    },
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter((name) => name.length > 0),
  };
}

/** Every changed file, as a bounded, paged read of the listing. */
export async function listPrFiles(
  api: PrApi,
  at: { owner: string; repo: string; number: number },
): Promise<readonly PrFile[]> {
  const files: PrFile[] = [];
  for (let page = 1; page <= FILE_PAGES; page += 1) {
    const { data } = await api.rest.pulls.listFiles({
      owner: at.owner,
      repo: at.repo,
      pull_number: at.number,
      per_page: FILE_PAGE,
      page,
    });
    files.push(
      ...data.map((file) => ({
        path: file.filename ?? "",
        status: STATUS[file.status ?? ""] ?? ("unknown" as const),
        previousPath: file.previous_filename ?? null,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        patch: file.patch ?? null,
      })),
    );
    if (data.length < FILE_PAGE) break;
  }
  return files;
}

/**
 * One file the review actually shows the model: its patch is complete and
 * uncut — a file whose patch exceeds the run's diff bound is skipped whole as
 * `capped` rather than shown half, so a finding about a file is always a
 * finding about everything in it the model could see.
 */
export interface ShownFile {
  readonly path: string;
  readonly status: PrFile["status"];
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
  /** Every new-file line number the patch proves, mapped to the text at it. */
  readonly lines: ReadonlyMap<number, string>;
}

/**
 * How the diff is divided before the model sees it.
 *
 * Every `skipped` entry carries the honest reason its file never reached the
 * model. It is attached to the file, not the model — a reviewer that does not
 * know a file was silently dropped cannot miss it, so the duty says so where
 * a reader of the coverage can find it.
 */
export interface Snapshot {
  /** Files the model was actually shown, in listing order. */
  readonly shown: readonly ShownFile[];
  /** Files deliberately withheld, with the one-word reason. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly allFiles: readonly PrFile[];
  /** True when `maxDiffChars` dropped files or cut patches this run. */
  readonly capped: boolean;
}

/**
 * Whether `path` matches `pattern`, with `*` (any run of non-separator
 * characters), `**` (any run including separators) and `?` (one non-separator
 * character). The minimal glob a configuration file needs for "everything in
 * `docs/generated/`" — see `rules.ts`'s `ignore.paths` — and nothing more: a
 * full glob engine would be a second format to learn for a feature that needs
 * one wildcard.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  // Transliterated left to right: `**` becomes `.*` (any run, separators
  // included), `*` becomes `[^/]*`, `?` becomes `[^/]`, everything else is
  // escaped literally. Anchored at both ends: a pattern is a whole-path claim,
  // and an unanchored one would rewrite "not ignoring `src/`" into "ignoring
  // ten files that merely live inside named `src`".
  let re = "";
  let rest = pattern;
  while (rest.length > 0) {
    if (rest.startsWith("**")) {
      re += ".*";
      rest = rest.slice(2);
    } else if (rest.startsWith("*")) {
      re += "[^/]*";
      rest = rest.slice(1);
    } else if (rest.startsWith("?")) {
      re += "[^/]";
      rest = rest.slice(1);
    } else {
      const char = rest.charAt(0);
      re += escapeGlob(char);
      rest = rest.slice(1);
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

function escapeGlob(chunk: string): string {
  return chunk.replace(/[.?+^${}()|[\]\\]/g, "\\$&");
}

/** One of the bounds that decides whether a file reaches the model. */
export interface ReviewBounds {
  readonly ignoreFiles: readonly string[];
  readonly ignorePaths: readonly string[];
  readonly generatedExtensions: readonly string[];
  readonly maxDiffChars: number;
}

/**
 * Classifies the diff into what the model sees and what it does not, and into
 * which deterministic checks fire on the way — see `preflight.ts`.
 *
 * The order matters: `ignored` is the actionable silence (the config decided),
 * `generated` is the flagged silence (a generated file landed outside the
 * ignore list and is worth one deterministic finding, see `preflight.ts`),
 * `binary` and `removed` are the incidental silences (there is no text to
 * review), and everything that survives reaches either `shown` or `capped`.
 */
// The cap is a whole-run budget, not a per-file ceiling: `max-diff-chars`
// bounds the total text a single review may carry to the model, which is what
// keeps one absurd file from blowing the prompt as it is now — the cumulative
// shape is the point. It is documented as such in `action.yml` and
// `docs/reference/duties/review.md`; callers who want a per-file ceiling sit
// `verdict.ts`'s own `PATCH_EXCERPT` — a separate, per-file cap — underneath
// this one.
//
// The "once capped, everything after is capped" shape is deliberate: walking
// the listing in order and zeroing the budget on the first file that exceeds
// it means the files the review does report are exactly the files it could
// fully show, and the coverage table then names every file after the cut as
// `capped` — honest about a diet the model never saw — rather than silently
// re-ordering the listing by size and showing a stranger's idea of the
// important files. A reviewer that shows the first files and names the rest
// admits its own cap; a reviewer that hides the cut does not.
export function classify(files: readonly PrFile[], bounds: ReviewBounds): Snapshot {
  const shown: ShownFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let budget = bounds.maxDiffChars;

  for (const file of files) {
    const ignore =
      bounds.ignoreFiles.some((name) => name === file.path) ||
      bounds.ignorePaths.some((pattern) => matchesGlob(pattern, file.path));
    if (ignore) {
      skipped.push({ path: file.path, reason: "ignored" });
      continue;
    }
    if (isGenerated(file.path, bounds.generatedExtensions)) {
      skipped.push({ path: file.path, reason: "generated" });
      continue;
    }
    if (file.status === "removed") {
      skipped.push({ path: file.path, reason: "removed" });
      continue;
    }
    if (file.patch === null || file.patch.length === 0) {
      skipped.push({ path: file.path, reason: "binary" });
      continue;
    }
    if (file.patch.length > budget) {
      // The first file that does not fit zeroes the budget for every file
      // after it, by design — see the comment above the function signature.
      skipped.push({ path: file.path, reason: "capped" });
      budget = 0;
      continue;
    }
    budget -= file.patch.length;
    shown.push({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
      lines: lineNumbers(file.patch),
    });
  }

  return {
    shown,
    skipped,
    allFiles: files,
    // A cap that never cut anything is invisible: the review makes the choice
    // to show less than the diff honest in the one place readers look for it.
    capped: skipped.some((entry) => entry.reason === "capped"),
  };
}

/**
 * Whether a path looks machine-generated — see `rules.ts`'s `generated`
 * patterns. A pattern is read by its shape, so one list covers the three
 * ways a repository spells "a tool wrote this":
 *
 * - a wildcard (`*` or `?`) is a whole-path glob (`dist/**`), through the
 *   same `matchesGlob` the ignore list uses;
 * - a leading dot with no separator is a suffix (`.min.js`), the shape the
 *   list has always held;
 * - anything else is an exact basename at any depth (`pnpm-lock.yaml`) or
 *   an exact whole path (`vendor/modules.txt`) — a segment match, never a
 *   substring, so `xpackage-lock.json` is not a lockfile.
 */
export function isGenerated(path: string, patterns: readonly string[]): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return patterns.some((pattern) => {
    if (pattern.includes("*") || pattern.includes("?")) return matchesGlob(pattern, path);
    if (pattern.startsWith(".") && !pattern.includes("/")) return path.endsWith(pattern);
    return base === pattern || path === pattern;
  });
}

/**
 * The new-file line numbers a patch proves, each mapped to the text at it.
 *
 * Parsed from the `@@ -o1,o2 +n1,n2 @@` hunks and their `+`/` ` lines, which
 * is the only source of line numbers this duty will accept from a model:
 * a run of a hundred-reasoning-answers is a run that was told the numbers,
 * and a claim about a line the patch cannot prove did not exist is unreadable —
 * see `verdict.ts`'s `parseFindings`.
 */
export function lineNumbers(patch: string): ReadonlyMap<number, string> {
  const lines = new Map<number, string>();
  let current: number | null = null;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      current = Number(hunk[1]);
      continue;
    }
    if (current === null) continue;
    const plus = raw.startsWith("+") && !raw.startsWith("+++");
    const context = raw.startsWith(" ") || raw.startsWith("\t");
    if (plus || context) {
      const text = raw.slice(1);
      lines.set(current, text);
      current += 1;
    }
  }
  return lines;
}
