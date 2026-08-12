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
        /**
         * GitHub's own pagination signal — a real client always includes it.
         * Optional here only so a hand-built stub answering a single page
         * (the overwhelming majority of them) is not made to fabricate one:
         * `listReplies` treats its absence the same as "there is no `last`
         * page to walk back from", which is exactly true of a one-page thread.
         */
        headers?: { readonly link?: string } | undefined;
      }>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
      getComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
      }): Promise<{ data: { body?: string | null } }>;
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

/** Enough of an author to tell whether the account behind it is a bot. */
export interface Author {
  readonly login?: string | null;
  readonly type?: string | null;
}

/**
 * Whether an author is a bot account — the one convention every duty and
 * every reader of a webhook payload uses to answer it: GitHub's own
 * `type: "Bot"` when the API reports it, or a `[bot]`-suffixed login for the
 * cases it does not — most visibly `github-actions[bot]` acting through a
 * workflow's default token, which this project's own runs are one example
 * of. Trusting `type` alone would read that account as human.
 */
export function isBotAuthor(author: Author | null | undefined): boolean {
  return author?.type === "Bot" || (author?.login ?? "").endsWith("[bot]");
}

/** A reply as a run found it: enough to decide about it, and to write it back. */
export interface Reply {
  readonly id: number;
  readonly body: string;
  /** Who wrote it. Empty when GitHub answered a comment with no author on it. */
  readonly login: string;
  /** Whether the author is a bot account — see `isBotAuthor`. */
  readonly isBot: boolean;
}

/**
 * How many replies one page carries, and how many pages deep one run will walk
 * looking for the newest ones.
 *
 * A thread's replies are unbounded — a year-old issue can carry four hundred —
 * and every one of them is a body a duty would read, fingerprint, and possibly
 * spend a request on. `REPLY_PAGES` is the ceiling on how many pages of the
 * thread one run will ever fetch; a thread past `REPLY_PAGE * REPLY_PAGES`
 * comments (mirrors `SWEEP_PAGES`'s reasoning) is the pathological case this
 * reports honestly (`more: true`) rather than serves completely.
 *
 * A run that hits either ceiling says so rather than trimming quietly, so the
 * consumer sees a number to raise instead of a silence to misread.
 */
const REPLY_PAGE = 100;
const REPLY_PAGES = 10;

/** What one call to {@link listReplies} wants back. */
export interface ListRepliesOptions {
  /** How many replies to keep. Defaults to one page (100). */
  readonly max?: number;
  /**
   * `"oldest"` (the default) reads from the start of the thread and keeps the
   * first `max` — the order `respond` wants, since it answers a thread the
   * way a reader arrives at it, from the top. `"newest"` walks backward from
   * the true end of the thread and keeps the last `max` — the order a
   * translator wants, since a discussion nobody has touched in eight months
   * does not need its middle worked over on the run a new comment triggered.
   */
  readonly order?: "oldest" | "newest";
}

/**
 * The last page number GitHub's `Link` response header names with `rel="last"`
 * — its own answer to "how many pages does this listing have", one request
 * would otherwise have no way to know without walking every page first.
 *
 * `null` covers both a listing GitHub judged small enough to need no `Link`
 * header at all, and a stub in a unit test answering a single page with none
 * — both mean the same thing to a caller: what came back is everything.
 */
function lastPageFrom(link: string | undefined): number | null {
  if (link === undefined) return null;
  const match = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function toReply(comment: {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
}): Reply {
  return {
    id: comment.id,
    body: comment.body ?? "",
    login: comment.user?.login ?? "",
    isBot: isBotAuthor(comment.user),
  };
}

/**
 * The replies on a thread, oldest first — GitHub's own order, and the order a
 * reader sees, kept regardless of which end {@link ListRepliesOptions.order}
 * asked for: `"newest"` changes which replies are kept, never how the kept
 * ones are handed back.
 */
export async function listReplies(
  api: GitHubApi,
  at: Location,
  options?: ListRepliesOptions,
): Promise<{ replies: readonly Reply[]; more: boolean }> {
  const max = options?.max ?? REPLY_PAGE;
  const order = options?.order ?? "oldest";

  const page = (n: number) =>
    api.rest.issues.listComments({
      owner: at.owner,
      repo: at.repo,
      issue_number: at.number,
      per_page: REPLY_PAGE,
      page: n,
    });

  if (order === "oldest") {
    // Never needs more pages than it takes to cover `max` — the replies past
    // that point are never kept, so there is nothing to walk forward for.
    const pageCap = Math.min(REPLY_PAGES, Math.ceil(max / REPLY_PAGE));
    const all: Reply[] = [];
    let lastPageFull = false;
    for (let n = 1; n <= pageCap; n += 1) {
      const { data } = await page(n);
      all.push(...data.map(toReply));
      lastPageFull = data.length === REPLY_PAGE;
      if (!lastPageFull || all.length >= max) break;
    }
    return { replies: all.slice(0, max), more: all.length > max || lastPageFull };
  }

  // `"newest"`: one request establishes where the thread actually ends —
  // GitHub's `Link` header names the true last page, the only way to reach it
  // without walking every page from the start the way a forward walk would.
  // A thread with a thousand replies and a duty that wants the newest two
  // would otherwise spend nine wasted requests, or — the bug this replaces —
  // give up at the ceiling and hand back the tail of whatever it had walked
  // so far, which is not the newest anything.
  const first = await page(1);
  const lastPage = lastPageFrom(first.headers?.link);

  if (lastPage === null || lastPage <= 1) {
    const all = first.data.map(toReply);
    return { replies: all.slice(-max), more: all.length > max };
  }

  // Walk backward from the true end, one page at a time, stopping once enough
  // replies are in hand, the start of the thread is reached, or `REPLY_PAGES`
  // pages have been spent — the same ceiling the forward walk pays for.
  //
  // Pages fetched are counted as they happen rather than precomputed from
  // `max / REPLY_PAGE`: only `lastPage` — the true last page, fetched first
  // here — can ever hold fewer than `REPLY_PAGE` replies, and a precomputed
  // page count that assumes every page is full falls short by exactly that
  // shortfall whenever it isn't. A 150-reply thread asked for its newest 100,
  // with a 50-reply last page, needs both of its pages read to reach 100 —
  // not the one page a full-page assumption would have stopped at.
  const collected: Reply[] = [];
  let firstPageWalked: number;
  let pagesFetched = 0;
  for (let n = lastPage; ; n -= 1) {
    // Page 1 was already fetched above, to learn where the thread ends —
    // reusing it here means a thread short enough to walk back to the start
    // never pays for it twice.
    const { data } = n === 1 ? first : await page(n);
    collected.unshift(...data.map(toReply));
    firstPageWalked = n;
    pagesFetched += 1;
    if (collected.length >= max || n === 1 || pagesFetched >= REPLY_PAGES) break;
  }

  return {
    replies: collected.slice(-max),
    more: firstPageWalked > 1 || collected.length > max,
  };
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
  let read = false;

  return {
    // The first read answers from what `listReplies` already fetched — one
    // request for the page rather than one per comment, still, which is why a
    // forty-reply thread costs forty reads and not eighty. Only a second read
    // goes back to GitHub, and `publish` only ever asks for one after it has
    // written: that is its re-read-after-write (see `core/publish.ts`),
    // there to notice another write landing on this comment in between. The
    // closure's original `reply.body` cannot answer that question — it never
    // moves, so it would call every publish "mismatched" whether or not
    // anything raced it.
    read() {
      if (read) {
        return api.rest.issues
          .getComment({ owner: at.owner, repo: at.repo, comment_id: reply.id })
          .then(({ data }) => data.body ?? "");
      }
      read = true;
      return Promise.resolve(reply.body);
    },

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
          milestone?: { title?: string } | null;
          assignees?: ({ login?: string } | null)[] | null;
          /** Read for `lifecycle`'s inactivity-track clock start. Optional so every existing stub of this call keeps typechecking unchanged. */
          created_at?: string;
          /** Present (any shape) on a pull request's own issue record, absent on a plain issue — read for `lifecycle`'s `threads:` gate. Optional for the same reason as `created_at`. */
          pull_request?: unknown;
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
      /**
       * Removes exactly one label from one thread. Not part of {@link Effects}
       * — see {@link LifecycleEffects}'s doc comment for the bounded exception
       * this exists for.
       */
      removeLabel(params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }): Promise<unknown>;
      /** Creates a repository label object — used only by `create: true`. */
      createLabel(params: {
        owner: string;
        repo: string;
        name: string;
        color?: string;
        description?: string;
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
        }[];
      }>;
    };
    readonly repos: {
      /**
       * Whether a given account can push to this repository — `"admin"`,
       * `"write"`, `"read"` or `"none"`, GitHub's own four-way answer and
       * nothing finer.
       *
       * The stand-in for `author_association`, which a webhook's `sender` —
       * the account that performed an action, as opposed to `issue.user`, the
       * thread's own author — does not carry: only an issue's author and a
       * comment or review's author get that field. A duty that needs to know
       * whether whoever just *acted* is a trusted account has no field to
       * read and has to ask the platform directly, which is what this is for.
       */
      getCollaboratorPermissionLevel(params: {
        owner: string;
        repo: string;
        username: string;
      }): Promise<{ data: { permission: string } }>;
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
  /** The milestone's title, or `null` when unmilestoned. Read for `lifecycle`'s exemption layer. */
  readonly milestone: string | null;
  /** Logins assigned to the thread. Read for `lifecycle`'s exemption layer. */
  readonly assignees: readonly string[];
  /**
   * When the thread was opened, or the Unix epoch when the API answered
   * without one — every caller but `lifecycle` already had no use for this
   * field, so a stub built before it existed reads as an impossible date
   * rather than failing to typecheck. `lifecycle` itself treats the epoch
   * value as "unknown" rather than as a real date — see its own read of
   * this field.
   */
  readonly createdAt: Date;
  /** True when this thread is a pull request's own issue record. Read for `lifecycle`'s `threads:` gate. */
  readonly isPullRequest: boolean;
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
    author: { login, isBot: isBotAuthor(data.user) },
    milestone: data.milestone?.title ?? null,
    assignees: (data.assignees ?? [])
      .map((assignee) => assignee?.login ?? "")
      .filter((login_) => login_.length > 0),
    createdAt: data.created_at !== undefined ? new Date(data.created_at) : new Date(0),
    isPullRequest: data.pull_request !== undefined,
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
 * How many threads one page of a sweep's listing carries.
 *
 * Mirrors `LABEL_PAGE` for the same reason: GitHub caps it at 100 regardless
 * of what is asked for.
 *
 * There used to be a page-count ceiling here too, on the argument that a
 * misconfigured `since` should not turn into an unbounded crawl of a
 * repository's whole history. It was the wrong fix: a repository with more
 * open threads than the ceiling allowed simply never saw the rest of them,
 * `since` or no `since`, and `remaining` reported `0` once the ceiling was
 * hit rather than the honest count of what was left. `since` and `limit` are
 * already the bounds an operator asked for — `since` stops the walk the
 * moment a page's oldest entry falls before it (the sort below makes that a
 * true prefix, exactly as `duplicate/corpus.ts`'s `listCorpus` relies on for
 * its own paging), and a sweep's own `limit` bounds how much of what is
 * listed one run actually processes. A ceiling on top of both does not
 * protect anything either does not already protect; it only lies about how
 * much backlog is left.
 */
const SWEEP_PAGE = 100;

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
 *
 * **`state` defaults to `open`** — the ordinary backlog every caller but one
 * wants — **and is a resource filter, not a different kind of listing.**
 * `closed` and `all` exist for triage's own `sweep-state` input, which lets a
 * one-time bulk migration walk a project's already-decided history (open
 * *and* closed alike) instead of only the threads still waiting on a verdict.
 */
export async function listOpenThreads(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  since: Date | null,
  state: "open" | "closed" | "all" = "open",
  /**
   * A hard page cap, for a caller reading this listing for something other
   * than the sweep's own bounded-by-`limit` candidate walk — `propose`'s
   * evidence gate is the one today, which reads every open issue in
   * `since`'s window to pattern-match against, with no per-thread budget of
   * its own to bound the read by. `undefined` (every other caller) keeps
   * this exactly as unbounded as it has always been, stopping only at
   * `since` or a short page.
   */
  maxPages?: number,
): Promise<readonly Listed[]> {
  const listed: Listed[] = [];

  for (let page = 1; maxPages === undefined || page <= maxPages; page += 1) {
    const { data } = await api.rest.issues.listForRepo({
      owner: at.owner,
      repo: at.repo,
      state,
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

/** One `labeled` or `unlabeled` event on a thread, and who caused it. */
export interface LabelEvent {
  readonly label: string;
  readonly action: "labeled" | "unlabeled";
  /** Whether the account that made this change is a bot — see `isBotAuthor`. */
  readonly isBot: boolean;
}

/** How many event pages one call reads before it stops asking. */
const EVENT_PAGE = 100;
const EVENT_PAGES = 10;

/**
 * The result of walking a thread's timeline for `listLabelEvents`.
 *
 * `complete` is what makes the ceiling honest to a caller instead of a silent
 * truncation: `false` means the walk stopped at `EVENT_PAGES` while the last
 * page read was still full, so there may be earlier `labeled`/`unlabeled`
 * events this call never saw. A caller using `events` to decide who most
 * recently touched a label cannot tell "no event" apart from "an event past
 * where this stopped reading" once that happens, and must not guess.
 */
export interface LabelHistory {
  readonly events: readonly LabelEvent[];
  readonly complete: boolean;
}

/**
 * Every `labeled`/`unlabeled` event on a thread's timeline, oldest first —
 * the same order the timeline API returns it in, which is what lets a caller
 * fold this into "the most recent event for a given label" with a single
 * pass.
 *
 * Read once per candidate, and only where a caller asks for it: this is an
 * extra request per thread, worth spending only where the alternative is
 * importing a machine's own old verdict as a maintainer's.
 */
export async function listLabelEvents(api: TrackerApi, at: Location): Promise<LabelHistory> {
  const events: LabelEvent[] = [];
  let complete = true;

  for (let page = 1; page <= EVENT_PAGES; page += 1) {
    const { data } = await api.rest.issues.listEvents({
      owner: at.owner,
      repo: at.repo,
      issue_number: at.number,
      per_page: EVENT_PAGE,
      page,
    });

    for (const entry of data) {
      if (entry.event !== "labeled" && entry.event !== "unlabeled") continue;
      const name = entry.label?.name;
      if (name === undefined || name.length === 0) continue;
      events.push({ label: name, action: entry.event, isBot: isBotAuthor(entry.actor) });
    }

    if (data.length < EVENT_PAGE) break;
    if (page === EVENT_PAGES) complete = false;
  }

  return { events, complete };
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
 * Whether a GitHub API failure is capacity, not configuration — D12's
 * "weather" side. A 429/5xx status, or a network-timeout-shaped error with
 * no status at all, is the platform being slow or briefly unavailable, not
 * a mistake in the run's own setup; 401/403 (and everything else) is not
 * this classifier's business and stays red. Shared rather than
 * reimplemented per duty — `triage`'s `propose.ts` and `lifecycle`'s sweep
 * both need the identical answer to "is this worth ending the run over."
 */
export function isCapacityError(error: unknown): boolean {
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

/**
 * `Effects`, plus exactly one bounded exception: removing a label.
 *
 * `Effects`'s own doctrine comment reads "every method adds… What a
 * maintainer did to a thread stands," and that sentence is still true for
 * every duty that holds plain `Effects`. `lifecycle` is the one duty that
 * needs a narrow way past it, and the north-star amendment that permits this
 * (D3, "…with one bounded exception") is the argument: a label the warrant
 * itself names as a lifecycle track's clock-hand is declared, by that
 * naming, to be machine-managed state, not a maintainer's own word. This
 * port does not decide *whether* removal is safe — the warrant declaration
 * already did that — it only performs it, on exactly the name it is given.
 *
 * A separate interface rather than a widened `Effects` so every other duty's
 * "what can this do to my repository" answer stays the one it always was.
 */
export interface LifecycleEffects extends Effects {
  /** Removes exactly one label — only ever called with a track's own declared clock-hand. */
  removeLabel(name: string): Promise<void>;
}

export function createLifecycleEffects(api: TrackerApi, at: Location): LifecycleEffects {
  const issue = { owner: at.owner, repo: at.repo, issue_number: at.number };
  const base = createEffects(api, at);

  return {
    ...base,
    async removeLabel(name) {
      await api.rest.issues.removeLabel({ ...issue, name });
    },
  };
}

/**
 * Creates a bare repository label object — no description, a neutral color
 * when none was given. Used only for a warrant entry carrying `create:
 * true`, which is a human-merged instruction (directly, or via a `propose`
 * PR) rather than a capability grant; see `checkLabelsExist`'s doc comment
 * in `warrant.ts` for the branch that calls this.
 */
export async function createRepositoryLabel(
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  label: { readonly name: string; readonly color: string | null; readonly description: string },
): Promise<void> {
  await api.rest.issues.createLabel({
    owner: at.owner,
    repo: at.repo,
    name: label.name,
    color: label.color ?? "ededed",
    description: label.description.slice(0, 100),
  });
}
