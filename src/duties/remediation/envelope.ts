/**
 * The review envelope, as remediation reads it — re-declared here, not
 * imported from `review`.
 *
 * `review`'s owned comment carries its memory in the marker's payload: a
 * base64-encoded `Previous` record — the previous run's findings with their
 * resolved flags, and the SHAs it reviewed. Remediation's whole input is that
 * envelope: it reads the findings `review` already reconciled and derives one
 * proposal per actionable one. The envelope *is* the durable record (the
 * repository is the database), so this duty never writes state of its own.
 *
 * **The shape is re-declared locally, deliberately.** `review` stays the
 * separate, non-coding abstraction, and directionality is structural in both
 * directions: `src/duties/remediation/` does not import from
 * `src/duties/review/` — not even types — so a change to `review` cannot be
 * absorbed here by compiler agreement. The local codec is pinned by a test
 * that round-trips against `review`'s *real* `encodeEnvelope`
 * (`envelope.test.ts`), which is test tooling and not shipped code, so a
 * drift between the two shapes fails the test rather than shipping a
 * misreading.
 *
 * `CommentApi` is deliberately write-less: this duty never posts a comment.
 * It is a structural port (house pattern — no mock library), satisfied by the
 * same real Octokit client every other port is and by the eval stub and
 * integration tests' own doubles.
 */
import { isBotAuthor, type Author } from "../../core/forge.js";
import { markerFor, type Marker } from "../../core/marker.js";

/** A finding as `review`'s payload records it — the strict field set. */
export interface Finding {
  /** Stable across runs: what the finding is about, not this run's opinion of it. */
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly ruleBody: string;
  readonly path: string;
  /** A new-file line number the patch proves, or null when the finding is about the file as a whole. */
  readonly line: number | null;
  readonly severity: "info" | "warning" | "critical";
  readonly body: string;
  /** The deterministic marker that produced this finding, or "" when a model wrote it. */
  readonly marker: string;
}

/** A finding exactly as the previous run recorded it — the resolved flag is what makes `reopened` meaningful. */
export interface PreviousFinding extends Finding {
  readonly wasResolved: boolean;
  /** The head SHA the review resolved this finding at — ties the status claim to a real change. */
  readonly resolvedAtSha?: string;
}

/**
 * What one run reads: the findings that are still standing (`previous` minus
 * the resolved ones), and the full memory (`previous`) so standings can be
 * derived against it. `findings` is the actionable input; `previous` is the
 * record `created`/`persists`/`reopened` are decided against.
 */
export interface Envelope {
  readonly findings: readonly Finding[];
  readonly previous: readonly PreviousFinding[];
}

/** The part of an Octokit client this duty needs — the one read, and no write. */
export interface CommentApi {
  readonly rest: {
    readonly issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: { id: number; body?: string | null; user?: Author | null }[] }>;
    };
  };
}

const COMMENT_PAGE = 100;

/** `review`'s own marker — the envelope this duty reads was written by `review`. */
export const reviewMarker: Marker = markerFor("review");

/** The one read: `review`'s owned comment on the pull request, if a previous run left one. */
export async function readEnvelope(
  api: CommentApi,
  at: { owner: string; repo: string; number: number },
): Promise<Envelope | null> {
  const { data } = await api.rest.issues.listComments({
    owner: at.owner,
    repo: at.repo,
    issue_number: at.number,
    per_page: COMMENT_PAGE,
  });

  for (const comment of data) {
    // The same guard a review run applies to its own comment: only a
    // bot-authored body whose marker splits with `official === ""` is
    // review's own — a forged or quoted marker is never read as memory.
    if (!isBotAuthor(comment.user)) continue;
    const { official, fingerprint: found } = reviewMarker.split(comment.body ?? "");
    if (found !== null && official === "") {
      return decodeEnvelope(found) ?? null;
    }
  }
  return null;
}

/**
 * Decodes the payload half of the marker into the envelope the run derives
 * from — or null for a payload that is not review's memory.
 *
 * The payload is `<renderFingerprint> <base64>` — the fingerprint half is for
 * compare and is meaningless to this duty, the base64 half is the envelope.
 * The guard is strict, mirroring the field set `review`'s own decode enforces:
 * a tampered or wrong-shaped payload reads as absent (null), never as a
 * claim — a corrupt envelope is absent input, not evidence.
 */
export function decodeEnvelope(payload: string | null): Envelope | null {
  if (payload === null) return null;
  const at = payload.indexOf(" ");
  const envelope = at === -1 ? payload : payload.slice(at + 1);
  if (envelope.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const map = parsed as Record<string, unknown>;
    if (!Array.isArray(map.findings)) return null;
    const previous = map.findings
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
      .map((entry): PreviousFinding => {
        const raw = entry as Findable & { readonly resolvedAtSha?: unknown };
        const resolvedAtSha =
          typeof raw.resolvedAtSha === "string"
            ? ({ resolvedAtSha: raw.resolvedAtSha } as const)
            : {};
        return {
          id: String(raw.id),
          ruleId: String(raw.ruleId),
          ruleName: String(raw.ruleName),
          ruleBody: String(raw.ruleBody),
          path: String(raw.path),
          line: typeof raw.line === "number" ? raw.line : null,
          severity: raw.severity as PreviousFinding["severity"],
          body: String(raw.body),
          marker: String(raw.marker),
          wasResolved: (raw as { wasResolved: unknown }).wasResolved === true,
          ...resolvedAtSha,
        };
      });
    return {
      findings: previous.filter((finding) => !finding.wasResolved),
      previous,
    };
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
