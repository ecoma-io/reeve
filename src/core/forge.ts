/**
 * Everything Reeve does to a hosting platform, behind one port.
 *
 * A duty never talks to GitHub. It returns what it decided, as data, and this
 * module is the one place that turns a decision into a request. That is the
 * boundary the architecture makes a mechanical test out of — if a duty imports
 * anything that fetches, the boundary broke — and it is what makes every stage
 * above it decidable without a network.
 *
 * It is also why there is exactly one function here that changes a public
 * thread. A reviewer asking "what can a duty write?" has one call to read.
 */

/** Which thread, on which repository. */
export interface Location {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * A body a duty can read and write, wherever it lives.
 *
 * A thread body and a reply are the same thing at a different address: both
 * have an author who is answerable for their words, both are text GitHub reads
 * references out of, and both have a reader who needs the duty's output next to
 * the text rather than three replies below it. So they get the identical
 * treatment, and only the port differs.
 */
export interface Thread {
  /** The body, as it stands. */
  read(): Promise<string>;
  write(body: string): Promise<void>;
}

/**
 * The part of an Octokit client Reeve uses.
 *
 * Declared structurally rather than imported so the port stays readable and so
 * a test can build one by hand. `getOctokit`'s client satisfies it, which the
 * integration test asserts by assigning a real one to this type.
 *
 * One pair of calls for issues and pull requests both: a pull request is an
 * issue to this endpoint, and its body is the same field. The comment pair is
 * `issues.listComments` and `issues.updateComment` for the same reason — a pull
 * request's discussion replies are issue comments, and its review comments on
 * diff lines are a different resource Reeve deliberately leaves alone.
 */
export interface GitHubApi {
  readonly rest: {
    readonly issues: {
      get(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{ data: { body?: string | null } }>;
      update(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: { id: number; body?: string | null }[] }>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

export function createThread(api: GitHubApi, at: Location): Thread {
  const issue = { owner: at.owner, repo: at.repo, issue_number: at.number };

  return {
    async read() {
      const { data } = await api.rest.issues.get(issue);
      return data.body ?? "";
    },

    async write(body) {
      await api.rest.issues.update({ ...issue, body });
    },
  };
}

/** A reply as a run found it: enough to decide about it, and to write it back. */
export interface Reply {
  readonly id: number;
  readonly body: string;
}

/**
 * How many replies one run will look at, and why there is a number at all.
 *
 * A thread's replies are unbounded — a year-old issue can carry four hundred —
 * and every one of them is a body a duty would read, fingerprint, and possibly
 * spend a request on. The page is the newest ones because that is where a
 * reader is: a discussion nobody has touched in eight months does not need its
 * middle worked over on the run that a new comment triggered.
 *
 * A run that hits this ceiling says so rather than trimming quietly, so the
 * consumer sees a number to raise instead of a silence to misread.
 */
const REPLY_PAGE = 100;

/**
 * The replies on a thread, newest last, capped at one page.
 *
 * Ascending order is GitHub's own and is kept: it is the order a reader sees,
 * so a run's log reads down the thread the way the thread does.
 */
export async function listReplies(
  api: GitHubApi,
  at: Location,
): Promise<{ replies: readonly Reply[]; more: boolean }> {
  const { data } = await api.rest.issues.listComments({
    owner: at.owner,
    repo: at.repo,
    issue_number: at.number,
    per_page: REPLY_PAGE,
  });

  const replies = data.map((comment) => ({ id: comment.id, body: comment.body ?? "" }));
  return { replies, more: data.length === REPLY_PAGE };
}

/**
 * The same port as `createThread`, addressed at one comment.
 *
 * `read` answers from the body already in hand rather than asking again. The
 * listing that found this reply is the same read — one request for the whole
 * page instead of one per comment — and the publish stage re-reads only to
 * avoid clobbering a concurrent edit, a risk a comment posted seconds ago does
 * not have in the measure a thread body does.
 */
export function createReply(api: GitHubApi, at: Location, reply: Reply): Thread {
  return {
    read: () => Promise.resolve(reply.body),

    async write(body) {
      await api.rest.issues.updateComment({
        owner: at.owner,
        repo: at.repo,
        comment_id: reply.id,
        body,
      });
    },
  };
}
