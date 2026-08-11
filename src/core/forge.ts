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

/**
 * The part of an Octokit client a duty that decides about a thread uses.
 *
 * Separate from `GitHubApi` rather than folded into it, and the reason is what
 * a reviewer can conclude from each. `GitHubApi` is the surface for reading a
 * body and writing under a marker, and it is deliberately four methods long: a
 * duty holding one of those cannot label, comment, close or assign, and that is
 * legible from the type. Merging the two would make every consumer of the
 * narrow port hold the wide one, and the answer to "what can this reach?" would
 * become "everything, look at the call sites".
 *
 * A real client satisfies both, which the integration test asserts.
 */
export interface TrackerApi {
  readonly rest: {
    readonly issues: {
      get(params: { owner: string; repo: string; issue_number: number }): Promise<{
        data: {
          title?: string;
          body?: string | null;
          state?: string;
          labels?: (string | { name?: string })[];
        };
      }>;
      update(params: {
        owner: string;
        repo: string;
        issue_number: number;
        state?: "open" | "closed";
        state_reason?: "completed" | "not_planned" | "reopened" | null;
      }): Promise<unknown>;
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<unknown>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      addAssignees(params: {
        owner: string;
        repo: string;
        issue_number: number;
        assignees: string[];
      }): Promise<unknown>;
      listLabelsForRepo(params: {
        owner: string;
        repo: string;
        per_page?: number;
        page?: number;
      }): Promise<{ data: { name: string; description?: string | null }[] }>;
      listForRepo(params: {
        owner: string;
        repo: string;
        state?: "open" | "closed" | "all";
        sort?: "created" | "updated" | "comments";
        direction?: "asc" | "desc";
        per_page?: number;
        page?: number;
      }): Promise<{
        data: {
          number: number;
          title?: string;
          body?: string | null;
          labels?: (string | { name?: string })[];
          created_at: string;
          pull_request?: unknown;
        }[];
      }>;
    };
  };
}

/**
 * A thread as it stands, for a duty that has to decide about it rather than
 * only translate it.
 *
 * The labels are the load-bearing field and they are read for one reason: a
 * label a maintainer applied is a decision, and every guardrail that refuses to
 * overrule one needs to know what is already there. Reading them at the start
 * of the run rather than at the apply stage is deliberate — it is the same
 * request that fetched the body, and a second read would be a second chance to
 * race a human who labelled the thread while the model was thinking.
 */
export interface Standing {
  readonly title: string;
  readonly body: string;
  /** Every label on the thread now, whoever put it there. */
  readonly labels: readonly string[];
  readonly closed: boolean;
}

export async function readStanding(api: TrackerApi, at: Location): Promise<Standing> {
  const { data } = await api.rest.issues.get({
    owner: at.owner,
    repo: at.repo,
    issue_number: at.number,
  });

  return {
    title: data.title ?? "",
    body: data.body ?? "",
    // The REST API returns a label as an object, and as a bare string when the
    // request asked for it that way. Both shapes are documented, so both are
    // read rather than one being assumed and the other becoming an empty list
    // that silently makes every guardrail think the thread is unlabelled.
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter((name) => name.length > 0),
    closed: data.state === "closed",
  };
}

/**
 * How many labels one run will read, and why there is a ceiling.
 *
 * A repository's label list is small by nature — it is a taxonomy a human
 * maintains — and a thousand of them is far past the point where the warrant
 * would have been the problem. The pages exist because a repository with a
 * hundred and one labels must not silently validate against the first hundred,
 * which would report the hundred-and-first as missing and fail a run over a
 * label that is right there.
 */
const LABEL_PAGE = 100;
const LABEL_PAGES = 10;

/** A label as this repository's own tracker reports it. */
export interface RepositoryLabel {
  readonly name: string;
  readonly description: string | null;
}

/**
 * Every label this repository has, name and description both.
 *
 * The names are what a written taxonomy is checked against. The descriptions
 * exist for a second reason a repository with no warrant at all depends on:
 * they are what the implicit taxonomy is built from when `.github/reeve.yml`
 * was never written, because a maintainer who already explained a label in
 * GitHub's own field explained it without knowing a warrant would ever read
 * that field back.
 */
export async function listRepositoryLabels(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
): Promise<readonly RepositoryLabel[]> {
  const labels: RepositoryLabel[] = [];

  for (let page = 1; page <= LABEL_PAGES; page += 1) {
    const { data } = await api.rest.issues.listLabelsForRepo({
      owner: at.owner,
      repo: at.repo,
      per_page: LABEL_PAGE,
      page,
    });
    labels.push(
      ...data.map((label) => ({ name: label.name, description: label.description ?? null })),
    );
    if (data.length < LABEL_PAGE) break;
  }

  return labels;
}

/**
 * How many threads one page of a sweep's listing carries, and how many pages a
 * single run will turn.
 *
 * The page mirrors `LABEL_PAGE` for the same reason: GitHub caps it at 100
 * regardless of what is asked for. The page count is generous on purpose —
 * `since` narrows what is kept but not what has to be walked to find it, and a
 * backlog can be old — while still being a hard ceiling a misconfigured `since`
 * cannot turn into an unbounded crawl of a repository's whole history.
 */
const SWEEP_PAGE = 100;
const SWEEP_PAGES = 10;

/** One open thread as a sweep found it, before this duty decided anything about it. */
export interface Listed {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** Every label on the thread now, whoever put it there. */
  readonly labels: readonly string[];
  readonly createdAt: Date;
  /** Whether this entry is a pull request — the listing endpoint returns both. */
  readonly isPullRequest: boolean;
}

/**
 * Every open thread a sweep will consider, newest created first.
 *
 * **Newest-first, not the tracker's default of newest-*updated*-first.** A
 * sweep's `limit` is a budget, and the threads most worth spending it on are
 * the ones a maintainer is still likely to care about — an issue opened
 * yesterday, not one from three years ago that happened to get a comment
 * today. Sorting by creation also makes `since` a true prefix of the listing:
 * once one page's oldest entry falls before the bound, every later page would
 * too, so the walk stops there instead of reading the rest of the repository's
 * history to confirm it.
 *
 * **`since` bounds `created_at`, checked here rather than left to the API.**
 * GitHub's own `since` query parameter filters by `updated_at` — which this
 * duty itself moves forward the moment it labels or translates a thread, so a
 * server-side filter on it would start excluding the very backlog a repeat
 * sweep exists to keep working. Creation date never moves, which is what makes
 * it the honest boundary for "no archaeology on threads before Reeve
 * adoption".
 */
export async function listOpenThreads(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  since: Date | null,
): Promise<readonly Listed[]> {
  const listed: Listed[] = [];

  for (let page = 1; page <= SWEEP_PAGES; page += 1) {
    const { data } = await api.rest.issues.listForRepo({
      owner: at.owner,
      repo: at.repo,
      state: "open",
      sort: "created",
      direction: "desc",
      per_page: SWEEP_PAGE,
      page,
    });

    let stop = false;
    for (const entry of data) {
      const createdAt = new Date(entry.created_at);
      if (since !== null && createdAt < since) {
        stop = true;
        break;
      }
      listed.push({
        number: entry.number,
        title: entry.title ?? "",
        body: entry.body ?? "",
        labels: (entry.labels ?? [])
          .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
          .filter((name) => name.length > 0),
        createdAt,
        isPullRequest: entry.pull_request !== undefined,
      });
    }

    if (stop || data.length < SWEEP_PAGE) break;
  }

  return listed;
}

/**
 * Everything a duty can do to a thread that is not editing its body, behind one
 * object.
 *
 * Four methods, and that is the complete list of ways Reeve changes a tracker.
 * A reviewer asking "what can this thing do to my repository?" reads them and
 * is finished — which is the property that made the port worth having, and the
 * reason a duty is never handed the client.
 *
 * **Every method adds.** There is no `removeLabel`, no `reopen`, no
 * `unassign`, and adding one would take more than an input: it would take a
 * different argument about what this project is for. What a maintainer did to a
 * thread stands.
 */
export interface Effects {
  /** Adds labels, keeping every label already there. */
  addLabels(names: readonly string[]): Promise<void>;
  /** Posts a new comment. Never edits somebody else's. */
  comment(body: string): Promise<void>;
  /** Adds assignees, keeping every assignee already there. */
  assign(users: readonly string[]): Promise<void>;
  /**
   * Closes as not planned.
   *
   * `not_planned` rather than `completed`, always: nothing Reeve closes was
   * completed by Reeve closing it, and a tracker that records the difference is
   * one a maintainer can still audit afterwards.
   */
  closeAsNotPlanned(): Promise<void>;
}

export function createEffects(api: TrackerApi, at: Location): Effects {
  const issue = { owner: at.owner, repo: at.repo, issue_number: at.number };

  return {
    async addLabels(names) {
      if (names.length === 0) return;
      await api.rest.issues.addLabels({ ...issue, labels: [...names] });
    },

    async comment(body) {
      await api.rest.issues.createComment({ ...issue, body });
    },

    async assign(users) {
      if (users.length === 0) return;
      await api.rest.issues.addAssignees({ ...issue, assignees: [...users] });
    },

    async closeAsNotPlanned() {
      await api.rest.issues.update({ ...issue, state: "closed", state_reason: "not_planned" });
    },
  };
}
