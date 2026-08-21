/**
 * This duty's own reads of a thread's comments and events, timestamped.
 *
 * Kept local rather than folded into `core/forge.ts`'s shared ports, the same
 * self-containment `core/atlas.ts`'s `AtlasApi` already uses. `forge.ts`'s
 * `listReplies` and `listLabelEvents` both exist for duties that only ever
 * ask "is X there" — neither carries `created_at`, and neither reads
 * `reopened` events, because no other duty has needed either. A thread's own
 * `created_at` is a different story: `Standing.createdAt` already carries it
 * (a narrow, additive extension to the shared type, since every track's
 * `when:` start is measured from thread creation, not from a marker), so
 * this port only widens what `listComments`/`listEvents` return, not `get`.
 * A step's anchor is a marker comment's own timestamp, and the
 * reopened-after-close guard reads an event type `listLabelEvents` does not
 * return at all. Widening the shared ports for this one consumer would put a
 * `reopened` branch in front of every duty's own port review; declaring the
 * wider shape here, the way `atlas.ts` does, keeps that cost local to the
 * one duty that pays it.
 */
import type { Location, TrackerApi } from "../../core/forge.js";
import { isBotAuthor } from "../../core/forge.js";

/**
 * `TrackerApi.rest.issues`, plus a comment reader and an event reader that
 * both carry `created_at`.
 *
 * Deliberately not `TrackerApi & {...}` — `TrackerApi` has no property but
 * `rest`, so intersecting at that level would reintroduce its own
 * (narrower) `listEvents` alongside this port's override of the same key,
 * and calling the resulting intersected function type resolves to
 * whichever signature TypeScript's overload resolution happens to pick,
 * observed to be the narrower one. Building the object type once, in one
 * piece, has no such ambiguity — and remains assignable everywhere a
 * `TrackerApi` is expected, since every member here is either identical to
 * `TrackerApi`'s own or a strict superset of it.
 */
export interface LifecycleApi {
  readonly rest: {
    /** The token's own identity, resolved once per run — see `resolveOwnLogin`. */
    readonly users: {
      getAuthenticated(): Promise<{ data: { login?: string } }>;
    };
    /** Read only for `exempt.drafts` — whether a pull-request thread is a draft, a field the issues endpoint does not carry. */
    readonly pulls: {
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{
        data: { draft?: boolean };
      }>;
    };
    readonly issues: Omit<TrackerApi["rest"]["issues"], "listEvents"> & {
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
          user?: { login?: string; type?: string } | null;
          created_at: string;
        }[];
      }>;
      listEvents(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: {
          event?: string;
          label?: { name?: string };
          actor?: { login?: string; type?: string } | null;
          created_at?: string;
        }[];
      }>;
    };
    readonly repos: TrackerApi["rest"]["repos"];
  };
}

export interface TimedComment {
  readonly id: number;
  readonly body: string;
  readonly login: string;
  readonly isBot: boolean;
  readonly createdAt: Date;
}

export interface TimedEvent {
  /** `"labeled"`, `"unlabeled"`, `"closed"`, `"reopened"`, `"milestoned"`, `"assigned"`, … — whatever the API named it. */
  readonly event: string;
  /** The label this event names, for `"labeled"`/`"unlabeled"`. `null` for every other event. */
  readonly label: string | null;
  readonly login: string;
  readonly isBot: boolean;
  readonly createdAt: Date;
}

const PAGE = 100;
/** Same ceiling `core/forge.ts`'s own event/comment paging uses — a single-thread read, never a sweep's. */
const PAGES = 10;

export async function readComments(
  api: LifecycleApi,
  at: Location,
): Promise<readonly TimedComment[]> {
  const out: TimedComment[] = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const { data } = await api.rest.issues.listComments({
      owner: at.owner,
      repo: at.repo,
      issue_number: at.number,
      per_page: PAGE,
      page,
    });
    for (const comment of data) {
      out.push({
        id: comment.id,
        body: comment.body ?? "",
        login: comment.user?.login ?? "",
        isBot: isBotAuthor(comment.user),
        createdAt: new Date(comment.created_at),
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * The login this run's own token authenticates as, resolved exactly once
 * per run and cached by the caller — the attribution gate the clock-hand
 * exception reads (see `clock.ts`'s `isOwnApplied`) needs to know who "our
 * own actor" is before it can tell a label we applied from one a human, or
 * a different bot, did.
 *
 * `""` when the token cannot answer for itself, which `clock.ts`'s
 * `isOwnActor` already reads as "unknown, and unknown is never a match".
 * Two different failures reach that same answer, and neither is exotic:
 *
 *   - a 200 carrying no `login`, which the `??` below has always covered;
 *   - the request FAILING, which it did not. `GITHUB_TOKEN` is a GitHub App
 *     installation token, and `GET /user` answers 403 "Resource not
 *     accessible by integration" for every one of those — the same wall
 *     `review`'s own adversarial notes record. Only a PAT resolves here.
 *     Letting that 403 propagate failed the whole duty on every run in
 *     every repository that had not configured a PAT: a scheduled sweep
 *     that died before reading its first thread, observed on this
 *     repository's own nightly dogfood and on run 48.
 *
 * Catching it converts a dead run into an identified state the clock can
 * read. What that state COSTS is decided one level up, in `main.ts`: with
 * no identity there is no attribution, and a duty that cannot attribute
 * does not write — see the observe-only fallback there.
 */
export async function resolveOwnLogin(api: LifecycleApi): Promise<string> {
  try {
    const { data } = await api.rest.users.getAuthenticated();
    return data.login ?? "";
  } catch {
    return "";
  }
}

/**
 * Whether a pull request is a draft — read only when `exempt.drafts` might
 * apply, since the issues endpoint that every other read in this module
 * uses does not carry it at all; only the pulls endpoint does.
 */
export async function isDraftPr(api: LifecycleApi, at: Location): Promise<boolean> {
  const { data } = await api.rest.pulls.get({
    owner: at.owner,
    repo: at.repo,
    pull_number: at.number,
  });
  return data.draft === true;
}

export async function readEvents(api: LifecycleApi, at: Location): Promise<readonly TimedEvent[]> {
  const out: TimedEvent[] = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const { data } = await api.rest.issues.listEvents({
      owner: at.owner,
      repo: at.repo,
      issue_number: at.number,
      per_page: PAGE,
      page,
    });
    for (const event of data) {
      out.push({
        event: event.event ?? "",
        label: event.label?.name ?? null,
        login: event.actor?.login ?? "",
        isBot: isBotAuthor(event.actor),
        createdAt: new Date(event.created_at ?? 0),
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}
