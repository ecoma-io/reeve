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
 * carrying the previous run's findings and the SHAs it reviewed. A human
 * reading the comment only sees the rendered review; the envelope rides in the
 * marker where the next run — and only the next run — parses it.
 */
import { chrome } from "../../core/chrome.js";
import { isBotAuthor, type Author, type Location } from "../../core/forge.js";
import { fingerprint, markerFor, type Marker } from "../../core/marker.js";
import { sanitize } from "../../core/sanitize.js";
import type { Finding, Previous } from "./findings.js";
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
 * flags, so the next run's `reopened` rung has something to work against. It
 * is written out-of-band — base64, so it rides in the marker tag without
 * corrupting the fingerprint comparison or the HTML parsing — and read back
 * lazily by `decodeEnvelope`.
 */
export function envelopeFingerprint(
  reconciled: readonly { finding: Finding; status: string }[],
): string {
  const rendered = reconciled
    .map((entry) => `${entry.status}:${findingFingerprint(entry.finding)}`)
    .join("\n");
  return fingerprint(rendered, ["review"]);
}

/** The envelope payload: findings (with resolved flags) and reviewed SHAs. */
export function encodeEnvelope(previous: Previous): string {
  return Buffer.from(JSON.stringify(previous), "utf8").toString("base64");
}

/**
 * Decodes the previous run's memory from the marker's payload.
 *
 * The payload is one envelope fingerprint followed by a space and the base64
 * envelope, so the whole tag reads `source=<fp> <b64>`. The fingerprint half is
 * for compare, the envelope half for read; this function reads.
 */
export function decodeEnvelope(payload: string | null): Previous | null {
  if (payload === null) return null;
  const at = payload.indexOf(" ");
  const envelope = at === -1 ? payload : payload.slice(at + 1);
  if (envelope.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const map = parsed as Record<string, unknown>;
    if (!Array.isArray(map.findings)) return null;
    const findings = map.findings
      .filter((entry): entry is Findable => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
        const f = entry as Findable;
        return (
          typeof f.id === "string" &&
          typeof f.ruleId === "string" &&
          typeof f.ruleName === "string" &&
          typeof f.ruleBody === "string" &&
          typeof f.path === "string" &&
          (f.line === null || Number.isInteger(f.line)) &&
          typeof f.severity === "string" &&
          typeof f.body === "string" &&
          typeof f.marker === "string" &&
          typeof f.wasResolved === "boolean"
        );
      })
      .map((entry) => {
        const raw = entry as Findable & { readonly resolvedAtSha?: unknown };
        const resolvedAtSha =
          typeof raw.resolvedAtSha === "string"
            ? ({ resolvedAtSha: raw.resolvedAtSha } as const)
            : {};
        return {
          ...(entry as unknown as Omit<Previous["findings"][number], "wasResolved">),
          wasResolved: (entry as { wasResolved: unknown }).wasResolved === true,
          ...resolvedAtSha,
        };
      });
    const shas = Array.isArray(map.reviewedShas)
      ? map.reviewedShas.filter((sha): sha is string => typeof sha === "string")
      : [];
    return { findings, reviewedShas: shas };
  } catch {
    return null;
  }
}

interface Findable {
  readonly id?: unknown;
  readonly ruleId?: unknown;
  readonly ruleName?: unknown;
  readonly ruleBody?: unknown;
  readonly path?: unknown;
  readonly line?: unknown;
  readonly severity?: unknown;
  readonly body?: unknown;
  readonly marker?: unknown;
  readonly wasResolved?: unknown;
}

/** The part of an Octokit client this module needs — same three methods as duplicate. */
export interface ReviewCommentApi {
  readonly rest: {
    readonly issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: { id: number; body?: string | null; user?: Author | null }[] }>;
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

/** This duty's own comment, as a listing found it. */
export interface Marked {
  readonly id: number;
  /** The envelope payload (a base64 string), or null when the comment predates the envelope's shape. */
  readonly payload: string | null;
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
  const { data } = await api.rest.issues.listComments({
    owner: at.owner,
    repo: at.repo,
    issue_number: at.number,
    per_page: COMMENT_PAGE,
  });

  for (const comment of data) {
    if (!isBotAuthor(comment.user)) continue;
    const { official, fingerprint: found } = marker.split(comment.body ?? "");
    if (found !== null && official === "") {
      return { marked: { id: comment.id, payload: found }, uncertain: false };
    }
  }
  return { marked: null, uncertain: data.length === COMMENT_PAGE };
}

/** What the write step did, for the summary and the `commented` output. */
export type Posted = "posted" | "replaced" | "unchanged" | "withheld";

/** What one run wants the marker tag to carry, and the body it renders. */
export interface Publication {
  readonly reconciled: readonly { finding: Finding; status: string }[];
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
 * findings' resolved flags and the SHAs already reviewed.
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
  const { marked: existing, uncertain } = await findMarked(api, at);

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
 * `unchanged`. Computed over the canonical reconciled findings, so a rerun
 * with the same findings — whatever their render formatting does — recognises
 * itself without decoding the envelope.
 */
export function renderFingerprint(
  reconciled: readonly { finding: Finding; status: string }[],
): string {
  const canonical = reconciled
    .map((entry) => `${entry.status}:${findingFingerprint(entry.finding)}`)
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
 */
export function render(reconciled: readonly { finding: Finding; status: string }[]): string {
  if (reconciled.length === 0) {
    return chrome("reviewEmpty", null);
  }
  const byStatus = group(reconciled, ["created", "reopened", "changed", "persists", "resolved"]);
  const sections: string[] = [];
  for (const [status, entries] of byStatus) {
    sections.push(
      `### ${statusLabel(status)} (${String(entries.length)})\n${entries.map((entry) => findingLine(entry.finding)).join("\n")}`,
    );
  }
  return sections.join("\n\n") + "\n\n" + footer();
}

function group(
  reconciled: readonly { finding: Finding; status: string }[],
  order: readonly string[],
): [string, { finding: Finding; status: string }[]][] {
  const map = new Map<string, { finding: Finding; status: string }[]>();
  for (const entry of reconciled) {
    const bucket = map.get(entry.status) ?? [];
    bucket.push(entry);
    map.set(entry.status, bucket);
  }
  const result: [string, { finding: Finding; status: string }[]][] = [];
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

function findingLine(finding: Finding): string {
  const where = finding.path.replace(/`/g, "");
  const at = finding.line === null ? "" : `:${String(finding.line)}`;
  // The finding's body is the one piece of model prose this duty prints on the
  // pull request, so it is defanged the same way every other duty's published
  // text is (see `core/sanitize.ts`): `@alice` and `#42` inside a finding must
  // not become link events the model never intended. Deterministic pre-check
  // bodies are constant strings and pass through unchanged.
  const body = sanitize(finding.body);
  return `- **\`${where}\`${at}** \`${finding.severity}\`: ${body}`;
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
