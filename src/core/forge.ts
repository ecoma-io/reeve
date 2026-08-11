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
      }): Promise<{
        data: {
          id: number;
          body?: string | null;
          user?: { login?: string; type?: string } | null;
        }[];
      }>;
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
  /** Who wrote it. Empty when GitHub answered a comment with no author on it. */
  readonly login: string;
  /**
   * Whether the author is a bot account. GitHub's own `type` field first, and
   * a `[bot]` login suffix as well — the suffix is authoritative for the
   * machine accounts GitHub's own API declines to type, most visibly a
   * `github-actions[bot]` acting through a workflow's default token, which
   * this project's own runs are one example of. Trusting `type` alone would
   * read that account as human.
   */
  readonly isBot: boolean;
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

  const replies = data.map((comment) => {
    const login = comment.user?.login ?? "";
    return {
      id: comment.id,
      body: comment.body ?? "",
      login,
      isBot: comment.user?.type === "Bot" || login.endsWith("[bot]"),
    };
  });
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
          user?: { login?: string; type?: string } | null;
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
  /**
   * Who opened the thread. Same shape as a `Reply`'s author, for the same
   * reason: a duty that decides whether to speak at all needs to know whether
   * it would be speaking to a bot before it spends anything deciding what to
   * say.
   */
  readonly author: { readonly login: string; readonly isBot: boolean };
}

export async function readStanding(api: TrackerApi, at: Location): Promise<Standing> {
  const { data } = await api.rest.issues.get({
    owner: at.owner,
    repo: at.repo,
    issue_number: at.number,
  });

  const login = data.user?.login ?? "";
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
    author: { login, isBot: data.user?.type === "Bot" || login.endsWith("[bot]") },
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

/**
 * The part of an Octokit client `record` uses to commit a correction — the
 * Contents API, and nothing else.
 *
 * This is not `Effects`. `Effects` is every way Reeve changes the *thread*,
 * four methods that all add and none of which touch a file; recording a
 * correction changes a *file in the repository* instead, through a
 * completely different endpoint family, and it needs a token scoped with
 * `contents: write` rather than `issues: write`. Keeping the two ports apart
 * keeps that distinction visible in the types: a duty holding only `Effects`
 * cannot commit, and a reviewer does not have to read the call sites to know
 * it.
 *
 * **No checkout, no git binary.** Every read and every write goes through
 * these two calls, which is what lets `record` run in a job that never
 * fetched the repository onto disk.
 */
export interface ContentsApi {
  readonly rest: {
    readonly repos: {
      getContent(params: { owner: string; repo: string; path: string }): Promise<{ data: unknown }>;
      createOrUpdateFileContents(params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        sha?: string;
      }): Promise<unknown>;
    };
  };
}

/** One `.ndjson` shard, as the directory listing named it. */
export interface CorrectionFile {
  readonly path: string;
  readonly sha: string;
}

/** Whether a Contents API failure means "not there" rather than something worth failing a run over. */
export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

/**
 * Every `.ndjson` shard already committed under `path`, or empty when the
 * directory is not there yet.
 *
 * A missing directory is the same cold start `readStore` treats it as — a
 * repository that has never recorded a correction is not a broken one.
 */
export async function listCorrectionFiles(
  api: ContentsApi,
  at: Pick<Location, "owner" | "repo">,
  path: string,
): Promise<readonly CorrectionFile[]> {
  let data: unknown;
  try {
    ({ data } = await api.rest.repos.getContent({ owner: at.owner, repo: at.repo, path }));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  // A file at this path rather than a directory answers with a single object,
  // not an array. That is not the shape `corrections` is meant to be, and the
  // honest answer is "no shards", not a crash on the array methods below.
  if (!Array.isArray(data)) return [];

  return data
    .filter(
      (entry): entry is { name: string; path: string; sha: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        (entry as { name: string }).name.endsWith(".ndjson"),
    )
    .map((entry) => ({ path: entry.path, sha: entry.sha }));
}

/**
 * One shard's text and current sha, read through the API rather than the
 * filesystem.
 *
 * `null` means exactly one thing: nothing is there yet, the cold start
 * `writeCorrection` is entitled to treat as "append a fresh shard". A 404
 * from `getContent` is that. A response shaped like a directory listing —
 * an array, checked below — is that too, the same shape mismatch
 * `listCorrectionFiles` already treats as "no shards".
 *
 * **A file that exists is never folded into that same `null`,** even when
 * this function cannot read its text. GitHub answers a file over the 1 MB
 * the Contents API can inline with `content: "", encoding: "none"` rather
 * than a body byte for byte — still a file, with a real `sha`, simply not
 * one this call can decode. Reading that as "not there yet" is the failure
 * this distinction exists to prevent: `writeCorrection` would append a
 * second entry beside one it could not see, or overwrite a shard's history
 * with a fresh one under the same name — silent store corruption, not a
 * cold start. So a present file this call cannot decode throws instead,
 * naming the path and the likely cause, which is worth failing a run over.
 */
export async function readContentsFile(
  api: ContentsApi,
  at: Pick<Location, "owner" | "repo">,
  path: string,
): Promise<{ readonly text: string; readonly sha: string } | null> {
  let data: unknown;
  try {
    ({ data } = await api.rest.repos.getContent({ owner: at.owner, repo: at.repo, path }));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;

  const file = data as { content?: unknown; encoding?: unknown; sha?: unknown };
  // No `sha` at all is not a recognisable file entry — the shape mismatch a
  // directory or a genuinely unexpected response already reads as "nothing
  // here", same as the array case above.
  if (typeof file.sha !== "string") return null;

  if (typeof file.content === "string" && file.encoding === "base64") {
    return { text: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha };
  }

  throw new UnreadableContentsFile(path);
}

/**
 * A file the Contents API answered but `readContentsFile` could not decode as
 * text — a shard over the 1 MB that endpoint can inline, almost always. Its
 * own class, the same reason `AuthenticationFailure` has one: a caller that
 * wants to treat this specific failure differently from a network error or a
 * missing scope — `writeCorrection` skips past it and keeps searching rather
 * than failing the whole write over one oversized shard — needs to catch it
 * by name rather than by parsing a message.
 */
export class UnreadableContentsFile extends Error {
  /** The shard's path, repeated here so a catcher can name it without re-parsing the message. */
  readonly path: string;

  constructor(path: string) {
    super(
      `\`${path}\` could not be read as text — the Contents API answered without base64 content, ` +
        "which is what it sends for a file over the 1 MB that endpoint can inline. Split the " +
        "corrections store into smaller shards.",
    );
    this.name = "UnreadableContentsFile";
    this.path = path;
  }
}

/**
 * Commits `text` to `path` — creating it fresh when `sha` is `null`, replacing
 * the shard at `sha` otherwise.
 *
 * A stale or missing `sha` on an existing file is refused by GitHub, not
 * silently overwritten — which is the platform's own defence against a
 * commit stepping on a concurrent one, and one this function makes no attempt
 * to work around.
 *
 * Every failure here — a read-only token most of all — is left to propagate.
 * It is a configuration problem, not a run's to recover from, and it fails
 * the job the same way any other authentication failure does.
 */
export async function writeContentsFile(
  api: ContentsApi,
  at: Pick<Location, "owner" | "repo">,
  path: string,
  text: string,
  message: string,
  sha: string | null,
): Promise<void> {
  await api.rest.repos.createOrUpdateFileContents({
    owner: at.owner,
    repo: at.repo,
    path,
    message,
    content: Buffer.from(text, "utf8").toString("base64"),
    ...(sha === null ? {} : { sha }),
  });
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
