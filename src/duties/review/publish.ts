/**
 * What a review has to say, and how it reaches the pull request.
 *
 * **A comment, not the body.** The same doctrine `duplicate/publish.ts`
 * rests on: a review is a claim addressed to the authors who read the thread,
 * and a maintainer who disagrees with a finding wants to be able to say so
 * underneath it — which a rewritten body does not let them do.
 *
 * **Exactly one comment per pull request.** The core anti-pattern this duty
 * exists to avoid is a bot that reposts the same findings on every
 * synchronize event. The marker guards the write the same way it does for
 * `duplicate`: the comment carries a fingerprint, and the next run recomputes
 * it. A run that reaches the same fingerprint changes nothing; a run whose
 * findings moved (new, changed, resolved) replaces the comment in place.
 * Reruns never stack a second review under the first.
 *
 * **The payload is the whole memory.** `duplicate`'s payload is one fingerprint
 * plus one number. A review's memory has to say more than "what changed" — it
 * has to say how each finding changed, because next run's `created`/`changed`/
 * `resolved`/`reopened` ladder derives from this run's findings and their
 * resolved flags. So the payload is a small base64-encoded JSON envelope
 * carrying the previous run's findings, their resolved flags and their
 * dispositions, and the SHAs it reviewed. A human reading the comment only sees
 * the rendered review; the envelope rides in the marker where the next run —
 * and only the next run — parses it.
 *
 * The envelope is versioned and checksummed. A payload this code wrote reads
 * back as `ok`, a payload from before the schema carried a version reads back
 * through a one-way migration, and a payload that fails its checksum reads back
 * as `corrupt` — loudly, never as a silent cold start (D5).
 */
import { chrome } from "../../core/chrome.js";
import { isBotAuthor, type Author, type Location } from "../../core/forge.js";
import { fingerprint, markerFor, type Marker } from "../../core/marker.js";
import { sanitize } from "../../core/sanitize.js";
import {
  envelopeChecksum,
  type Disposition,
  type Finding,
  type Previous,
  type PreviousFinding,
} from "./findings.js";
import { findingFingerprint } from "./findings.js";

/** This duty's marker: `<!-- reeve:review source=<fingerprint> <envelope> -->`. */
export const marker: Marker = markerFor("review");

/**
 * The comment's identity vs. its memory.
 *
 * `envelopeFingerprint` is the idempotency hash: a complete digest of the
 * renderable review (the findings with their statuses) that decides
 * `posted`/`replaced`/`unchanged`. It is the only value a run needs to decide
 * "did anything change since I last commented".
 *
 * The envelope payload is the memory: the previous findings and their resolved
 * flags and dispositions, so the next run's `reopened` rung has something to
 * work against. It is written out-of-band — base64, so it rides in the marker
 * tag without corrupting the fingerprint comparison or the HTML parsing — and
 * read back lazily by `decodeEnvelope`.
 */
export function envelopeFingerprint(
  reconciled: readonly { finding: Finding; status: string; disposition: Disposition | null }[],
): string {
  const rendered = reconciled
    .map(
      (entry) =>
        `${entry.status}:${findingFingerprint(entry.finding)}:${entry.disposition?.value ?? ""}`,
    )
    .join("\n");
  return fingerprint(rendered, ["review"]);
}

/** The envelope payload: findings (with resolved flags and dispositions) and reviewed SHAs. */
export function encodeEnvelope(previous: Previous): string {
  return Buffer.from(JSON.stringify(previous), "utf8").toString("base64");
}

/**
 * What `decodeEnvelope` decided about a payload.
 *
 * `none` is an honest cold start — no payload, or an empty one. `ok` is a
 * payload that validated, migrated and checksum-matched. `corrupt` is any
 * payload that claimed to be memory but is not readable as one: a bad base64,
 * a non-mapping, malformed fields, or a checksum mismatch. Corruption is
 * reported loudly by the caller (a warning and a summary note), never silently
 * treated as an empty memory.
 */
export type Decoded =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly previous: Previous }
  | { readonly kind: "corrupt"; readonly reason: string };

/**
 * Decodes the previous run's memory from the marker's payload.
 *
 * The payload is one envelope fingerprint followed by a space and the base64
 * envelope, so the whole tag reads `source=<fp> <b64>`. The fingerprint half is
 * for compare, the envelope half for read; this function reads.
 *
 * Validation is strict per version:
 *
 * - **no payload / empty envelope** → `none`, a genuine cold start.
 * - **no `version`** → v1: every existing field check applies, `wasResolved` /
 *   `resolvedAtSha` map as-is, every finding gains `disposition: null`, the
 *   checksum is computed and `version: 2` is stamped → `ok`.
 * - **`version: 2`** → every existing field check, plus `line` must be `null`
 *   or an integer `> 0`, `severity` must be in the union, and `disposition`,
 *   when present, must be a valid shape. The checksum is recomputed over
 *   findings + SHAs; a mismatch is `corrupt`.
 *
 * Any parse failure — bad base64, not a mapping, malformed fields — is
 * `corrupt` with a reason, never a silent `none`.
 */
export function decodeEnvelope(payload: string | null): Decoded {
  if (payload === null) return { kind: "none" };
  const at = payload.indexOf(" ");
  // No space means the payload holds only a fingerprint — the envelope half is
  // empty, which is the same cold start as no payload at all.
  const envelope = at === -1 ? "" : payload.slice(at + 1);
  if (envelope.length === 0) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
  } catch {
    return { kind: "corrupt", reason: "the envelope is not valid base64" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "corrupt", reason: "the envelope is not a JSON mapping" };
  }
  const map = parsed as Record<string, unknown>;
  if (map.version === undefined) return migrateV1(map);
  return validateV2(map);
}

/** The per-finding field checks every version shares. */
function isFindable(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const f = entry as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.ruleId === "string" &&
    typeof f.ruleName === "string" &&
    typeof f.ruleBody === "string" &&
    typeof f.path === "string" &&
    typeof f.body === "string" &&
    typeof f.marker === "string" &&
    typeof f.wasResolved === "boolean"
  );
}

/** The v1 field checks — line and severity were already permissive, kept for the migration. */
function isV1Findable(entry: unknown): boolean {
  if (!isFindable(entry)) return false;
  const f = entry as Record<string, unknown>;
  return f.line === null || Number.isInteger(f.line);
}

/** A payload that predates `version` — one-way migrated to v2, dispositions start null. */
function migrateV1(map: Record<string, unknown>): Decoded {
  if (!Array.isArray(map.findings)) {
    return { kind: "corrupt", reason: "the envelope has no `findings` array" };
  }
  const findings: PreviousFinding[] = [];
  for (const entry of map.findings) {
    if (!isV1Findable(entry)) {
      return { kind: "corrupt", reason: "a v1 finding holds a malformed field" };
    }
    const raw = entry as Record<string, unknown> & { resolvedAtSha?: unknown };
    const resolvedAtSha =
      typeof raw.resolvedAtSha === "string" ? ({ resolvedAtSha: raw.resolvedAtSha } as const) : {};
    findings.push({
      ...(entry as unknown as Omit<
        PreviousFinding,
        "wasResolved" | "resolvedAtSha" | "disposition"
      >),
      wasResolved: raw.wasResolved === true,
      disposition: null,
      ...resolvedAtSha,
    });
  }
  const shas = Array.isArray(map.reviewedShas)
    ? map.reviewedShas.filter((sha): sha is string => typeof sha === "string")
    : [];
  const previous: Previous = { findings, reviewedShas: shas };
  return {
    kind: "ok",
    previous: { ...previous, version: 2, checksum: envelopeChecksum(previous) },
  };
}

const SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "critical"]);
const DISPOSITION_VALUES: ReadonlySet<string> = new Set([
  "verified",
  "accepted-risk",
  "wont-fix",
  "rejected",
]);

/** A v2 payload — strict line/severity/disposition checks, then the checksum. */
function validateV2(map: Record<string, unknown>): Decoded {
  if (map.version !== 2) {
    return {
      kind: "corrupt",
      reason: `the envelope declares unknown version \`${String(map.version)}\``,
    };
  }
  if (!Array.isArray(map.findings)) {
    return { kind: "corrupt", reason: "the envelope has no `findings` array" };
  }
  const findings: PreviousFinding[] = [];
  for (const entry of map.findings) {
    if (!isFindable(entry)) {
      return { kind: "corrupt", reason: "a v2 finding holds a malformed field" };
    }
    const f = entry as Record<string, unknown>;
    if (f.line !== null && !(Number.isInteger(f.line) && (f.line as number) > 0)) {
      return { kind: "corrupt", reason: `a finding names a line that is not a positive integer` };
    }
    if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) {
      return { kind: "corrupt", reason: `a finding names an unknown severity` };
    }
    const disposition = validateDisposition(f.disposition);
    if (disposition === "corrupt") {
      return { kind: "corrupt", reason: "a finding carries a malformed disposition" };
    }
    const raw = entry as Record<string, unknown> & { resolvedAtSha?: unknown };
    const resolvedAtSha =
      typeof raw.resolvedAtSha === "string" ? ({ resolvedAtSha: raw.resolvedAtSha } as const) : {};
    findings.push({
      ...(entry as unknown as Omit<
        PreviousFinding,
        "wasResolved" | "resolvedAtSha" | "disposition"
      >),
      wasResolved: raw.wasResolved === true,
      disposition,
      ...resolvedAtSha,
    });
  }
  const shas = Array.isArray(map.reviewedShas)
    ? map.reviewedShas.filter((sha): sha is string => typeof sha === "string")
    : [];
  const previous: Previous = { findings, reviewedShas: shas };
  if (typeof map.checksum !== "string" || envelopeChecksum(previous) !== map.checksum) {
    return { kind: "corrupt", reason: "the envelope fails its checksum — it is damaged or forged" };
  }
  return { kind: "ok", previous: { ...previous, version: 2, checksum: map.checksum } };
}

/** A disposition field: `null` is valid; a mapping must carry a valid union value and strings. */
function validateDisposition(value: unknown): Disposition | null | "corrupt" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "corrupt";
  const d = value as Record<string, unknown>;
  if (typeof d.value !== "string" || !DISPOSITION_VALUES.has(d.value)) return "corrupt";
  if (typeof d.by !== "string" || typeof d.at !== "string" || typeof d.replyUrl !== "string") {
    return "corrupt";
  }
  if (!Number.isInteger(d.replyId) || (d.replyId as number) <= 0) return "corrupt";
  return {
    value: d.value as Disposition["value"],
    by: d.by,
    at: d.at,
    replyId: d.replyId as number,
    replyUrl: d.replyUrl,
  };
}

/** The part of an Octokit client this module needs — the issues comment trio. */
export interface ReviewCommentApi {
  readonly rest: {
    readonly issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: {
          id: number;
          body?: string | null;
          user?: Author | null;
          author_association?: string;
          created_at?: string;
          html_url?: string;
        }[];
      }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

const COMMENT_PAGE = 100;
/** How many pages of the thread one run will walk — the pathological case reports honestly. */
export const MAX_COMMENT_PAGES = 10;

/** This duty's own comment, as a listing found it. */
export interface Marked {
  readonly id: number;
  /** The envelope payload (a base64 string), or null when the comment predates the envelope's shape. */
  readonly payload: string | null;
}

/** One eligible reply on the owned thread, as the API listing read it. */
export interface ThreadReply {
  readonly id: number;
  readonly login: string;
  readonly isBot: boolean;
  readonly association: string;
  readonly createdAt: string;
  readonly body: string;
}

/** What one read of the thread found. */
export interface ThreadRead {
  readonly marked: Marked | null;
  readonly replies: readonly ThreadReply[];
  /** `uncertain` means exactly duplicate's meaning — the walk stopped at a full page. */
  readonly uncertain: boolean;
}

/**
 * Walks the pull request's comments, pages of 100, up to `MAX_COMMENT_PAGES`.
 *
 * Returns the duty's own marked comment (guarded the same way duplicate's
 * search is: a bot author AND the marker at the top — a forged or quoted marker
 * must never be overwritten as if it were Reeve's own) plus every comment as a
 * `ThreadReply` for disposition reading. `uncertain` is true when the walk
 * stopped at a full page — the marker or a reply may sit beyond what was read.
 */
export async function readThread(api: ReviewCommentApi, at: Location): Promise<ThreadRead> {
  let marked: Marked | null = null;
  const replies: ThreadReply[] = [];
  let uncertain = false;

  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const { data } = await api.rest.issues.listComments({
      owner: at.owner,
      repo: at.repo,
      issue_number: at.number,
      per_page: COMMENT_PAGE,
      page,
    });

    for (const comment of data) {
      replies.push({
        id: comment.id,
        login: comment.user?.login ?? "",
        isBot: isBotAuthor(comment.user),
        association: comment.author_association ?? "",
        createdAt: comment.created_at ?? "",
        body: comment.body ?? "",
      });
      if (marked !== null) continue;
      if (!isBotAuthor(comment.user)) continue;
      const { official, fingerprint: found } = marker.split(comment.body ?? "");
      if (found !== null && official === "") {
        marked = { id: comment.id, payload: found };
      }
    }

    if (data.length < COMMENT_PAGE) break;
    if (page === MAX_COMMENT_PAGES) uncertain = true;
  }

  return { marked, replies, uncertain };
}

/** What one search of the comments found — `uncertain` means exactly duplicate's meaning. */
interface Search {
  readonly marked: Marked | null;
  readonly uncertain: boolean;
}

/**
 * This duty's own comment, if a previous run left one — guarded the same way
 * duplicate's search is, with both the bot-author and the marker-at-the-top
 * checks, because a forged or quoted marker must never be overwritten as if it
 * were Reeve's own.
 */
export async function findMarked(api: ReviewCommentApi, at: Location): Promise<Search> {
  const { marked, uncertain } = await readThread(api, at);
  return { marked, uncertain };
}

/** What the write step did, for the summary and the `commented` output. */
export type Posted = "posted" | "replaced" | "unchanged" | "withheld";

/** What one run wants the marker tag to carry, and the body it renders. */
export interface Publication {
  readonly reconciled: readonly {
    finding: Finding;
    status: string;
    disposition: Disposition | null;
  }[];
  /** The memory the next run reads back — see `findings.ts`'s `remember`. */
  readonly next: Previous;
  readonly headSha: string;
}

/**
 * Builds the marker tag and the comment body for this run's review.
 *
 * The payload is `<renderFingerprint> <envelope>`: the fingerprint half is the
 * idempotency digest the next run compares without decoding anything, and the
 * envelope half is the base64 memory the next run decodes when it needs the
 * findings' resolved flags, dispositions and the SHAs already reviewed.
 */
export function publicationFor(pub: Publication): {
  readonly payload: string;
  readonly body: string;
} {
  const payload = `${renderFingerprint(pub.reconciled)} ${encodeEnvelope(pub.next)}`;
  return { payload, body: render(pub.reconciled) };
}

/** What a write would do, decided without writing anything. */
interface Classification {
  readonly disposition: Posted;
  readonly body: string;
  readonly existing: Marked | null;
}

async function classify(
  api: ReviewCommentApi,
  at: Location,
  pub: Publication,
): Promise<Classification> {
  const { payload, body } = publicationFor(pub);
  const full = [marker.render(payload), body].join("\n\n");
  const { marked: existing, uncertain } = await readThread(api, at);

  if (existing === null && uncertain) {
    return { disposition: "withheld", body: full, existing: null };
  }

  const disposition: Posted =
    existing === null
      ? "posted"
      : existing.payload?.startsWith(renderFingerprintMarker(pub, payload)) === true
        ? "unchanged"
        : "replaced";
  return { disposition, body: full, existing };
}

/**
 * The digest the marker's payload opens with — the idempotency comparison for
 * `unchanged`. Computed over the canonical reconciled findings and their
 * dispositions, so a rerun with the same findings — whatever their render
 * formatting does — recognises itself without decoding the envelope. A new or
 * removed disposition changes the digest, so adding a disposition to a finding
 * is a real change the next run will render.
 */
export function renderFingerprint(
  reconciled: readonly { finding: Finding; status: string; disposition: Disposition | null }[],
): string {
  const canonical = reconciled
    .map(
      (entry) =>
        `${entry.status}:${findingFingerprint(entry.finding)}:${entry.disposition?.value ?? ""}`,
    )
    .join("\n");
  return fingerprint(canonical, ["review"]);
}

/** The first token of a payload, or the whole payload when it holds only a fingerprint. */
function renderFingerprintMarker(_pub: Publication, payload: string): string {
  const at = payload.indexOf(" ");
  return at === -1 ? payload : payload.slice(0, at);
}

/**
 * Posts this run's review under the marker, replacing the previous one when
 * the fingerprint moved and leaving it alone when it did not.
 */
export async function postOrReplace(
  api: ReviewCommentApi,
  at: Location,
  pub: Publication,
): Promise<Posted> {
  const { disposition, body, existing } = await classify(api, at, pub);

  if (disposition === "withheld") return disposition;
  if (existing === null) {
    await api.rest.issues.createComment({
      owner: at.owner,
      repo: at.repo,
      issue_number: at.number,
      body,
    });
    return disposition;
  }
  if (disposition === "unchanged") return disposition;
  await api.rest.issues.updateComment({
    owner: at.owner,
    repo: at.repo,
    comment_id: existing.id,
    body,
  });
  return disposition;
}

/** What `postOrReplace` would do, without doing it — dry-run's rehearsal. */
export async function rehearse(
  api: ReviewCommentApi,
  at: Location,
  pub: Publication,
): Promise<Posted> {
  return (await classify(api, at, pub)).disposition;
}

/**
 * The comment's own text — the review a reader sees — under the marker.
 *
 * Pure and total: the same reconciled findings render the same bytes, which is
 * what lets `envelopeFingerprint` recognise a rerun that changed nothing.
 * Dispositions render as attribution on the finding's line and never change
 * the heading grouping (grouping stays by evidence status).
 */
export function render(
  reconciled: readonly { finding: Finding; status: string; disposition: Disposition | null }[],
): string {
  if (reconciled.length === 0) {
    return chrome("reviewEmpty", null);
  }
  const byStatus = group(reconciled, ["created", "reopened", "changed", "persists", "resolved"]);
  const sections: string[] = [];
  for (const [status, entries] of byStatus) {
    sections.push(
      `### ${statusLabel(status)} (${String(entries.length)})\n${entries.map((entry) => findingLine(entry.finding, entry.disposition)).join("\n")}`,
    );
  }
  return sections.join("\n\n") + "\n\n" + footer();
}

function group(
  reconciled: readonly { finding: Finding; status: string; disposition: Disposition | null }[],
  order: readonly string[],
): [string, { finding: Finding; status: string; disposition: Disposition | null }[]][] {
  const map = new Map<
    string,
    { finding: Finding; status: string; disposition: Disposition | null }[]
  >();
  for (const entry of reconciled) {
    const bucket = map.get(entry.status) ?? [];
    bucket.push(entry);
    map.set(entry.status, bucket);
  }
  const result: [
    string,
    { finding: Finding; status: string; disposition: Disposition | null }[],
  ][] = [];
  for (const status of order) {
    const bucket = map.get(status);
    if (bucket !== undefined) result.push([status, bucket]);
  }
  return result;
}

function statusLabel(status: string): string {
  switch (status) {
    case "created":
      return "New findings";
    case "reopened":
      return "Reopened";
    case "changed":
      return "Changed";
    case "persists":
      return "Still standing";
    case "resolved":
      return "Resolved";
    default:
      return status;
  }
}

/** The one status a finding may be triaged into after a disposition — never on its own. */
const DISPOSITION_LABELS: Record<Disposition["value"], string> = {
  verified: "verified",
  "accepted-risk": "accepted-risk",
  "wont-fix": "wont-fix",
  rejected: "rejected",
};

function findingLine(finding: Finding, disposition: Disposition | null): string {
  const where = finding.path.replace(/`/g, "");
  const at = finding.line === null ? "" : `:${String(finding.line)}`;
  // The finding's body is the one piece of model prose this duty prints on the
  // pull request, so it is defanged the same way every other duty's published
  // text is (see `core/sanitize.ts`): `@alice` and `#42` inside a finding must
  // not become link events the model never intended. Deterministic pre-check
  // bodies are constant strings and pass through unchanged.
  const body = sanitize(finding.body);
  const suffix = verificationBadge(finding);
  let line = `- **\`${where}\`${at}** \`${finding.severity}\`: ${body}${suffix}`;
  if (disposition !== null) {
    // The value is a constant from the union — safe to print raw; the login is
    // a stranger's and is escaped the same way the footer escapes its text.
    line += ` — **${DISPOSITION_LABELS[disposition.value]}** by @${escapeHtml(disposition.by)} ([reply](${disposition.replyUrl}))`;
  }
  return line;
}

/**
 * The machine-stable verification badge on a finding's line. A model finding
 * the engine verified reads `· verified`; one the evidence did not prove reads
 * `· not verified`. Deterministic findings (and findings the engine never
 * touched) render no badge at all — there is no claim of theirs to verify.
 */
function verificationBadge(finding: Finding): string {
  if (finding.marker.length > 0) return "";
  if (finding.verification === "verified") return "· verified";
  if (finding.verification === "unverified") return "· not verified";
  return "";
}

function footer(): string {
  const parts = [chrome("reviewFooterFloor", null), chrome("reviewFooterEditable", null)];
  return `<sub>${escapeHtml(parts.join(" "))}</sub>`;
}

/**
 * The comment's fixed closing line: an only-when-needed machine, never a
 * second reviewer. The `id` names a rule; the label is human prose.
 */
export function labelFor(ruleId: string): string {
  return ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
