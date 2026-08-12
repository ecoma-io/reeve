/**
 * The `propose` capability: triage's own sweep-only proposal of workspace
 * drift against the warrant's taxonomy, as a pull request — never as a merge.
 *
 * The warrant stays the sole authority and enumeration stays total. A PR is
 * not authority; the merge is. This module only ever *notices* that the
 * workspace atlas has grown a package the taxonomy has no label for (or lost
 * one a label was named for, when `retire: true`), and *drafts* the text
 * edit a maintainer would otherwise write by hand — proven, in code, to
 * touch nothing outside the `labels:` block before it is ever sent anywhere.
 *
 * **Detection has exactly one source: workspace drift.** A path mentioned in
 * an issue is evidence *inside* that source — it raises or lowers confidence
 * that a drift candidate matters enough to propose — never an independent
 * source of its own, because a label needs a `description` and a bare
 * mentioned directory has none to honestly supply. Bootstrapping an
 * implicit-mode repository's first warrant file is out of scope on purpose:
 * that would silently narrow the whole taxonomy from nothing, rather than
 * amend one a maintainer already wrote.
 *
 * **No merge method exists on {@link ProposalsApi}, ever.** "Can this merge
 * anything?" is answered by reading one interface, the same doctrine
 * `Effects` already established for the thread-writing side.
 *
 * **The failure mode of this capability, like the duty's, is doing
 * nothing.** A proposal that would not parse back the same taxonomy it
 * started from is abandoned before a single network write; a capacity error
 * downgrades to a green run with a warning; only a missing grant (401/403)
 * propagates red, per D12.
 */
import { matchAtlasEvidence, globToMatcher, type Atlas, type Package } from "../../core/atlas.js";
import { isBotAuthor, isMissing, type Listed } from "../../core/forge.js";
import {
  fingerprint,
  markerFor,
  proposeEntryMarker,
  readProposeEntryMarkers,
} from "../../core/marker.js";
import {
  parseWarrant,
  type Label,
  type ProposeWorkspace,
  type Warrant,
} from "../../core/warrant.js";

/**
 * The GitHub calls `propose` needs — declared locally, structurally, the
 * same pattern `AtlasApi`/`LifecycleApi` already establish. Deliberately no
 * merge method: this is the port's own proof that nothing reachable through
 * it can merge a pull request.
 */
export interface ProposalsApi {
  readonly rest: {
    readonly repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: { default_branch?: string } }>;
      getContent(params: { owner: string; repo: string; path: string; ref: string }): Promise<{
        data:
          | { type?: string; content?: string; encoding?: string; sha?: string }
          | { type?: string; content?: string; encoding?: string; sha?: string }[];
      }>;
      createOrUpdateFileContents(params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        sha?: string;
        branch?: string;
      }): Promise<unknown>;
      getCommit(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: { author?: { login?: string | null; type?: string | null } | null } }>;
    };
    readonly git: {
      getRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: { object: { sha: string } } }>;
      createRef(params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }): Promise<unknown>;
    };
    readonly pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: "open" | "closed" | "all";
        head?: string;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: readonly {
          readonly number: number;
          readonly merged_at?: string | null;
          readonly body?: string | null;
          readonly head: { readonly sha: string };
        }[];
      }>;
      create(params: {
        owner: string;
        repo: string;
        title: string;
        head: string;
        base: string;
        body: string;
        draft?: boolean;
      }): Promise<{ data: { number: number } }>;
      update(params: {
        owner: string;
        repo: string;
        pull_number: number;
        title?: string;
        body?: string;
      }): Promise<unknown>;
    };
  };
}

/** The branch every proposal lives on — fixed, never warrant- or input-configurable (guard #1). */
const BRANCH = "reeve/propose";
const MARKER = markerFor("propose");
/** GitHub's own label-name ceiling. A candidate past it cannot be created even if proposed. */
const LABEL_NAME_MAX = 50;
const LIST_PAGES = 10;
const WRITE_ATTEMPTS = 3;

const SCOPE_PREFIX = /^@[^/]+\//;

/** An npm scope prefix stripped, lowercased — the slot a naming template's `{package}` takes. */
function packageSlug(name: string): string {
  return name.replace(SCOPE_PREFIX, "").toLowerCase();
}

function renderName(template: string, slug: string): string {
  return template.replace("{package}", slug);
}

/**
 * The reverse of {@link renderName}: given a template and a candidate label
 * name, the slot value that would have produced it, or `null` when the name
 * does not have the template's shape at all.
 *
 * `readPropose` already guarantees the template carries exactly one
 * `{package}` placeholder, so this only ever has one prefix/suffix pair to
 * check.
 */
function templateSuffix(template: string, labelName: string): string | null {
  const at = template.indexOf("{package}");
  if (at === -1) return null;
  const prefix = template.slice(0, at);
  const suffix = template.slice(at + "{package}".length);
  if (prefix.length + suffix.length >= labelName.length) return null;
  if (!labelName.startsWith(prefix) || !labelName.endsWith(suffix)) return null;
  return labelName.slice(prefix.length, labelName.length - suffix.length);
}

/** Whether an existing label's own `paths:` already speaks for this package — no drift to report. */
function pathCovered(pkg: Package, labels: readonly Label[]): boolean {
  return labels.some((label) =>
    label.paths.some((p) => p === pkg.path || pkg.path.startsWith(`${p}/`)),
  );
}

/** One workspace package the taxonomy has no label for yet. */
export interface AddCandidate {
  readonly labelName: string;
  readonly pkg: Package;
}

/**
 * Every atlas package the taxonomy does not yet name, after `except`, an
 * existing `paths:` coverage, an unnamable (empty) description, and the
 * label-name length ceiling have each had their say.
 */
export function detectAdditions(
  labels: readonly Label[],
  atlas: Atlas,
  cfg: ProposeWorkspace,
): { readonly candidates: readonly AddCandidate[]; readonly notes: readonly string[] } {
  const notes: string[] = [];
  const candidates: AddCandidate[] = [];
  const existingNames = new Set(labels.map((label) => label.name));
  const excludeMatchers = cfg.except.map(globToMatcher);

  for (const pkg of atlas.packages) {
    if (excludeMatchers.some((matcher) => matcher.test(pkg.path))) continue;
    if (pathCovered(pkg, labels)) continue;
    if (pkg.description.length === 0) {
      notes.push(
        `\`${pkg.name}\` has no manifest description for propose to honestly write one from — skipped.`,
      );
      continue;
    }
    const labelName = renderName(cfg.name, packageSlug(pkg.name));
    if (labelName.length > LABEL_NAME_MAX) {
      notes.push(`\`${labelName}\` is longer than ${String(LABEL_NAME_MAX)} characters — skipped.`);
      continue;
    }
    if (existingNames.has(labelName)) continue;
    candidates.push({ labelName, pkg });
  }

  return { candidates, notes };
}

/** One label the taxonomy names that no current workspace package matches anymore. */
export interface RetireCandidate {
  readonly labelName: string;
}

/**
 * Every taxonomy label matching the naming template's shape whose slot no
 * current atlas package fills — empty unless `cfg.retire` is true, since an
 * unconfigured repository asked for additions only.
 */
export function detectRetirements(
  labels: readonly Label[],
  atlas: Atlas,
  cfg: ProposeWorkspace,
): readonly RetireCandidate[] {
  if (!cfg.retire) return [];
  const currentSlugs = new Set(atlas.packages.map((pkg) => packageSlug(pkg.name)));
  const out: RetireCandidate[] = [];
  for (const label of labels) {
    const slot = templateSuffix(cfg.name, label.name);
    if (slot === null) continue;
    if (currentSlugs.has(slot)) continue;
    out.push({ labelName: label.name });
  }
  return out;
}

/** An addition candidate that cleared the evidence gate, with the issues that spoke for it. */
export interface EvidencedAddition extends AddCandidate {
  readonly issues: readonly number[];
}

/**
 * Narrows `candidates` to the ones with at least `cfg.evidence` open issues,
 * created within `cfg.window` of `now`, whose text mentions the package's own
 * path — `evidence: 0` waives the gate entirely, taking every candidate as
 * given.
 */
export function gateByEvidence(
  candidates: readonly AddCandidate[],
  openIssues: readonly Listed[],
  cfg: ProposeWorkspace,
  now: Date,
): readonly EvidencedAddition[] {
  if (candidates.length === 0) return [];
  if (cfg.evidence === 0) return candidates.map((candidate) => ({ ...candidate, issues: [] }));

  const since = new Date(now.getTime() - cfg.window);
  const windowed = openIssues.filter((issue) => issue.createdAt >= since);
  const packages = candidates.map((candidate) => candidate.pkg);

  const byPackage = new Map<string, number[]>();
  for (const issue of windowed) {
    const { candidates: matched } = matchAtlasEvidence(
      { packages, truncated: false },
      `${issue.title}\n${issue.body}`,
      new Map(),
    );
    for (const name of matched) {
      const list = byPackage.get(name) ?? [];
      list.push(issue.number);
      byPackage.set(name, list);
    }
  }

  const evidenced: EvidencedAddition[] = [];
  for (const candidate of candidates) {
    const issues = byPackage.get(candidate.pkg.name) ?? [];
    if (issues.length >= cfg.evidence)
      evidenced.push({ ...candidate, issues: [...issues].sort((a, b) => a - b) });
  }
  return evidenced;
}

/** One line of the change-set a proposal carries — the unit a struck-entry token names. */
export interface Entry {
  readonly action: "add" | "retire";
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly issues: readonly number[];
}

/** The canonical, sorted change-set — additions before retirements, each block name-ordered. */
export function buildEntries(
  evidenced: readonly EvidencedAddition[],
  retirements: readonly RetireCandidate[],
): readonly Entry[] {
  const adds: Entry[] = evidenced.map((e) => ({
    action: "add",
    name: e.labelName,
    description: e.pkg.description,
    path: e.pkg.path,
    issues: e.issues,
  }));
  const retires: Entry[] = retirements.map((r) => ({
    action: "retire",
    name: r.labelName,
    description: "",
    path: "",
    issues: [],
  }));
  return [...adds, ...retires].sort((a, b) => {
    if (a.action !== b.action) return a.action === "add" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function shortHash(text: string): string {
  return fingerprint(text, []).slice(0, 8);
}

/** The text a change-set's fingerprint is computed over — deterministic, order-stable. */
function changeSetText(entries: readonly Entry[]): string {
  return entries
    .map((e) =>
      e.action === "add" ? `add ${e.name} ${shortHash(e.description)}` : `retire ${e.name}`,
    )
    .join("\n");
}

/** The entry token {@link readProposeEntryMarkers} and this module both key struck memory by. */
function entryToken(entry: Entry): string {
  return `${entry.action}:${entry.name}`;
}

/**
 * Every entry token permanently rejected — read from the body of every
 * closed, unmerged pull request this run has ever opened on {@link BRANCH}.
 */
async function struckEntries(
  api: ProposalsApi,
  at: { readonly owner: string; readonly repo: string },
): Promise<ReadonlySet<string>> {
  const struck = new Set<string>();
  for (let page = 1; page <= LIST_PAGES; page += 1) {
    const { data } = await api.rest.pulls.list({
      owner: at.owner,
      repo: at.repo,
      state: "closed",
      head: `${at.owner}:${BRANCH}`,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    for (const pr of data) {
      if (pr.merged_at !== null && pr.merged_at !== undefined) continue;
      const body = pr.body ?? "";
      if (MARKER.split(body).fingerprint === null) continue;
      for (const token of readProposeEntryMarkers(body)) struck.add(token);
    }
    if (data.length < 100) break;
  }
  return struck;
}

/** The one open proposal PR this run's own marker identifies, or null when there is none. */
async function findOwnOpenPr(
  api: ProposalsApi,
  at: { readonly owner: string; readonly repo: string },
): Promise<{ readonly number: number; readonly headSha: string; readonly body: string } | null> {
  const { data } = await api.rest.pulls.list({
    owner: at.owner,
    repo: at.repo,
    state: "open",
    head: `${at.owner}:${BRANCH}`,
    per_page: 10,
    page: 1,
  });
  for (const pr of data) {
    const body = pr.body ?? "";
    if (MARKER.split(body).fingerprint !== null)
      return { number: pr.number, headSha: pr.head.sha, body };
  }
  return null;
}

/**
 * Whether the branch's own head commit was written by someone other than
 * this run — the cheapest honest signal that a maintainer pushed to it by
 * hand, which this module then leaves alone rather than overwriting.
 */
async function branchFrozen(
  api: ProposalsApi,
  at: { readonly owner: string; readonly repo: string },
  headSha: string,
): Promise<boolean> {
  try {
    const { data } = await api.rest.repos.getCommit({
      owner: at.owner,
      repo: at.repo,
      ref: headSha,
    });
    return !isBotAuthor(data.author);
  } catch {
    return false;
  }
}

/** Creates `BRANCH` from `base`'s current head when it does not exist yet; a no-op otherwise. */
async function ensureBranch(
  api: ProposalsApi,
  at: { readonly owner: string; readonly repo: string },
  base: string,
): Promise<void> {
  try {
    await api.rest.git.getRef({ owner: at.owner, repo: at.repo, ref: `heads/${BRANCH}` });
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const { data } = await api.rest.git.getRef({
    owner: at.owner,
    repo: at.repo,
    ref: `heads/${base}`,
  });
  await api.rest.git.createRef({
    owner: at.owner,
    repo: at.repo,
    ref: `refs/heads/${BRANCH}`,
    sha: data.object.sha,
  });
}

/** A safe-enough YAML double-quoted scalar for a controlled, machine-authored value. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function itemName(line: string): string | null {
  const m = /^\s*-\s*name:\s*(.+?)\s*$/.exec(line);
  if (m === null) return null;
  const raw = m[1] ?? "";
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** The `labels:` block's own line range — from its top-level key to the next top-level key or EOF. */
function findLabelsBlock(
  lines: readonly string[],
): { readonly start: number; readonly end: number } | null {
  const start = lines.findIndex((line) => /^labels:\s*$/.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** One `- name: ...` item's own line range within the block, bounded by the next item or the block's end. */
function findItemSpan(
  lines: readonly string[],
  blockStart: number,
  blockEnd: number,
  name: string,
): { readonly start: number; readonly end: number } | null {
  for (let i = blockStart + 1; i < blockEnd; i += 1) {
    if (/^\s*-\s*name:/.test(lines[i] ?? "") && itemName(lines[i] ?? "") === name) {
      let end = blockEnd;
      for (let j = i + 1; j < blockEnd; j += 1) {
        if (/^\s*-\s*name:/.test(lines[j] ?? "")) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

/**
 * The text-level editor: mutates only lines strictly inside the located
 * `labels:` block, so byte-identity of everything outside it is guaranteed
 * by construction rather than by a runtime comparison. Retirements remove
 * the matched item's whole span; additions append a minimal new item —
 * `name`, `description`, `paths`, and `create: true`, the field the merge
 * needs to let `checkLabelsExist` create the GitHub label object rather than
 * fail red.
 *
 * Returns `null` when the block cannot be located at all, or when a
 * retirement's own item is not found — either is treated upstream as "this
 * proposal cannot be safely written", never as a partial edit.
 */
export function applyChangeSet(source: string, entries: readonly Entry[]): string | null {
  const lines = source.split("\n");
  const block = findLabelsBlock(lines);
  if (block === null) return null;

  const { start } = block;
  let end = block.end;

  for (const entry of entries) {
    if (entry.action !== "retire") continue;
    const span = findItemSpan(lines, start, end, entry.name);
    if (span === null) return null;
    lines.splice(span.start, span.end - span.start);
    end -= span.end - span.start;
  }

  const additions = entries.filter((e) => e.action === "add");
  if (additions.length > 0) {
    const newLines: string[] = [];
    for (const entry of additions) {
      newLines.push(`  - name: ${yamlScalar(entry.name)}`);
      newLines.push(`    description: ${yamlScalar(entry.description)}`);
      newLines.push("    paths:");
      newLines.push(`      - ${yamlScalar(entry.path)}`);
      newLines.push("    create: true");
    }
    lines.splice(end, 0, ...newLines);
  }

  return lines.join("\n");
}

function expectedLabelNames(
  original: readonly string[],
  entries: readonly Entry[],
): ReadonlySet<string> {
  const set = new Set(original);
  for (const entry of entries) {
    if (entry.action === "add") set.add(entry.name);
    else set.delete(entry.name);
  }
  return set;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function summaryTitle(entries: readonly Entry[]): string {
  const first = entries[0];
  if (first === undefined) return "warrant: propose";
  const more = entries.length - 1;
  return `warrant: propose ${first.action === "add" ? "" : "retire "}${first.name}${
    more > 0 ? ` (+${String(more)} more)` : ""
  }`;
}

function renderBody(path: string, entries: readonly Entry[], fp: string): string {
  const lines: string[] = [];
  lines.push(
    `This proposes ${String(entries.length)} change${entries.length === 1 ? "" : "s"} to \`${path}\`'s ` +
      "taxonomy, detected from this workspace's own manifests and open issues — never from a model.",
  );
  lines.push("");
  for (const entry of entries) {
    if (entry.action === "add") {
      lines.push(`### Add \`${entry.name}\``);
      lines.push("");
      lines.push(`- Package: \`${entry.path}\` — ${entry.description}`);
      if (entry.issues.length > 0) {
        lines.push(`- Evidence: ${entry.issues.map((n) => `#${String(n)}`).join(", ")}`);
      }
      lines.push(proposeEntryMarker("add", entry.name));
    } else {
      lines.push(`### Retire \`${entry.name}\``);
      lines.push("");
      lines.push("- No package in this workspace matches it anymore.");
      lines.push(proposeEntryMarker("retire", entry.name));
    }
    lines.push("");
  }
  lines.push(
    "<sub>No model wrote any of this — every line above came from this workspace's own manifests and " +
      "this repository's own open issues, matched by name and path alone.</sub>",
  );
  lines.push("");
  lines.push(MARKER.render(fp));
  return lines.join("\n");
}

function isShaConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 409) return true;
  if (status === 422) {
    const raw = (error as { message?: unknown }).message;
    const message = error instanceof Error ? error.message : typeof raw === "string" ? raw : "";
    return message.toLowerCase().includes("sha");
  }
  return false;
}

/** Capacity/timeout-shaped errors — weather, per D12 — downgraded to a green report rather than thrown. */
function isWeather(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  }
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("etimedout")
  );
}

async function writeProposal(
  api: ProposalsApi,
  at: { readonly owner: string; readonly repo: string },
  warrant: Warrant,
  entries: readonly Entry[],
  fp: string,
  existingPr: number | null,
  base: string,
): Promise<number | null> {
  const expected = expectedLabelNames(
    warrant.labels.map((label) => label.name),
    entries,
  );

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const { data } = await api.rest.repos.getContent({
      owner: at.owner,
      repo: at.repo,
      path: warrant.path,
      ref: BRANCH,
    });
    if (Array.isArray(data)) return null;
    const { content, encoding, sha } = data;
    if (content === undefined) return null;
    const source = Buffer.from(content, encoding === "base64" ? "base64" : "utf8").toString("utf8");

    const edited = applyChangeSet(source, entries);
    if (edited === null) return null;

    let reparsed: Warrant;
    try {
      reparsed = parseWarrant(warrant.path, edited);
    } catch {
      return null;
    }
    if (!setsEqual(new Set(reparsed.labels.map((label) => label.name)), expected)) return null;

    try {
      await api.rest.repos.createOrUpdateFileContents({
        owner: at.owner,
        repo: at.repo,
        path: warrant.path,
        message: summaryTitle(entries),
        content: Buffer.from(edited, "utf8").toString("base64"),
        branch: BRANCH,
        ...(sha === undefined ? {} : { sha }),
      });
      break;
    } catch (error) {
      if (isShaConflict(error) && attempt < WRITE_ATTEMPTS) continue;
      throw error;
    }
  }

  const title = summaryTitle(entries);
  const body = renderBody(warrant.path, entries, fp);

  if (existingPr !== null) {
    await api.rest.pulls.update({
      owner: at.owner,
      repo: at.repo,
      pull_number: existingPr,
      title,
      body,
    });
    return existingPr;
  }

  const created = await api.rest.pulls.create({
    owner: at.owner,
    repo: at.repo,
    title,
    head: BRANCH,
    base,
    body,
    draft: true,
  });
  return created.data.number;
}

async function defaultBranchAndReady(
  api: ProposalsApi,
  at: { readonly owner: string; readonly repo: string },
): Promise<string> {
  const { data } = await api.rest.repos.get({ owner: at.owner, repo: at.repo });
  const base = data.default_branch ?? "main";
  await ensureBranch(api, at, base);
  return base;
}

/** What `propose` decided this run, for the caller to log — never wired into the job-summary table. */
export interface ProposeReport {
  readonly eligible: boolean;
  readonly notes: readonly string[];
  readonly additions: number;
  readonly retirements: number;
  readonly struck: number;
  readonly pr: number | null;
  readonly unchanged: boolean;
  readonly frozen: boolean;
  readonly dryRun: boolean;
}

function report(
  over: Partial<ProposeReport> & { readonly notes: readonly string[] },
): ProposeReport {
  return {
    eligible: true,
    additions: 0,
    retirements: 0,
    struck: 0,
    pr: null,
    unchanged: false,
    frozen: false,
    dryRun: false,
    ...over,
  };
}

/**
 * The whole `propose` orchestration: detect drift, gate it by evidence,
 * subtract permanently-struck entries, and find-or-create-or-update the one
 * proposal PR on {@link BRANCH} — or do nothing and say why.
 *
 * Every network call below is inside one boundary: a capacity/timeout error
 * anywhere in it downgrades to a green report with a warning note (D12);
 * everything else, notably a 401/403 from a token missing `contents: write`
 * or `pull-requests: write`, propagates uncaught to the caller's own
 * `try/catch` — the same red, immediately, that a missing grant gets
 * everywhere else in this duty.
 */
export async function runPropose(
  api: ProposalsApi,
  at: { readonly owner: string; readonly repo: string },
  warrant: Warrant,
  implicit: boolean,
  atlas: Atlas,
  openIssues: readonly Listed[],
  now: Date,
  dryRun: boolean,
): Promise<ProposeReport> {
  if (implicit) {
    return report({
      eligible: false,
      notes: [
        "`propose` needs an explicit warrant file to edit — this repository has none, so it did nothing.",
      ],
    });
  }

  const notes: string[] = [];
  if (atlas.truncated) {
    notes.push("The workspace atlas was truncated — some packages may not have been considered.");
  }

  const { candidates, notes: detectNotes } = detectAdditions(
    warrant.labels,
    atlas,
    warrant.propose,
  );
  notes.push(...detectNotes);
  const retirements = detectRetirements(warrant.labels, atlas, warrant.propose);
  const evidenced = gateByEvidence(candidates, openIssues, warrant.propose, now);

  const short = candidates.length - evidenced.length;
  if (short > 0) {
    notes.push(
      `${String(short)} candidate label${short === 1 ? "" : "s"} did not reach ${String(
        warrant.propose.evidence,
      )} matching open issue${warrant.propose.evidence === 1 ? "" : "s"} within the configured window — skipped.`,
    );
  }

  let entries = buildEntries(evidenced, retirements);
  if (entries.length === 0) {
    return report({ notes: [...notes, "No workspace drift found this run."] });
  }

  try {
    const struck = await struckEntries(api, at);
    const strikeCount = entries.filter((entry) => struck.has(entryToken(entry))).length;
    entries = entries.filter((entry) => !struck.has(entryToken(entry)));

    if (strikeCount > 0) {
      notes.push(
        `${String(strikeCount)} previously-rejected entr${strikeCount === 1 ? "y" : "ies"} will not be re-proposed.`,
      );
    }

    if (entries.length === 0) {
      return report({
        notes: [...notes, "Every candidate this run found was already struck."],
        struck: strikeCount,
      });
    }

    const fp = fingerprint(changeSetText(entries), []);
    const additions = entries.filter((e) => e.action === "add").length;
    const retiring = entries.filter((e) => e.action === "retire").length;
    const existing = await findOwnOpenPr(api, at);

    if (existing !== null) {
      if (MARKER.split(existing.body).fingerprint === fp) {
        return report({
          notes: [
            ...notes,
            `The open proposal (#${String(existing.number)}) already carries this exact change-set.`,
          ],
          additions,
          retirements: retiring,
          struck: strikeCount,
          pr: existing.number,
          unchanged: true,
        });
      }

      if (await branchFrozen(api, at, existing.headSha)) {
        return report({
          notes: [
            ...notes,
            `The proposal branch (#${String(existing.number)}) carries a commit from someone other ` +
              "than this run — left untouched.",
          ],
          additions,
          retirements: retiring,
          struck: strikeCount,
          pr: existing.number,
          frozen: true,
        });
      }

      if (dryRun) {
        return report({
          notes: [
            ...notes,
            `Dry run — would update the open proposal (#${String(existing.number)}).`,
          ],
          additions,
          retirements: retiring,
          struck: strikeCount,
          pr: existing.number,
          dryRun: true,
        });
      }

      const base = await defaultBranchAndReady(api, at);
      const updated = await writeProposal(api, at, warrant, entries, fp, existing.number, base);
      if (updated === null) {
        return report({
          notes: [
            ...notes,
            "The proposed change-set would not parse back cleanly — aborted, nothing was written.",
          ],
          pr: existing.number,
        });
      }
      return report({
        notes: [...notes, `Updated the open proposal — #${String(updated)}.`],
        additions,
        retirements: retiring,
        struck: strikeCount,
        pr: updated,
      });
    }

    if (dryRun) {
      return report({
        notes: [...notes, "Dry run — would open a new proposal."],
        additions,
        retirements: retiring,
        struck: strikeCount,
        dryRun: true,
      });
    }

    const base = await defaultBranchAndReady(api, at);
    const created = await writeProposal(api, at, warrant, entries, fp, null, base);
    if (created === null) {
      return report({
        notes: [
          ...notes,
          "The proposed change-set would not parse back cleanly — aborted, nothing was written.",
        ],
      });
    }
    return report({
      notes: [...notes, `Opened a new proposal — #${String(created)}.`],
      additions,
      retirements: retiring,
      struck: strikeCount,
      pr: created,
    });
  } catch (error) {
    if (isWeather(error)) {
      return report({
        notes: [
          ...notes,
          `\`propose\` hit a capacity error and stopped rather than partially publish — ${
            error instanceof Error ? error.message : String(error)
          }.`,
        ],
      });
    }
    throw error;
  }
}
