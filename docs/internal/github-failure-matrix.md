# GitHub failure matrix

_Per call site, per status: the ONE semantic the code applies, and the test that pins it. Internal companion to `failure-matrix.md`, which answers the same questions per subsystem; this file answers them per request._

A row is only as good as the test in its last column. A cell reading `GAP` is behaviour nothing pins; a cell reading `ACCIDENTAL` is behaviour that happens rather than behaviour that was decided. Both are for adjudication, not for silent repair.

## Where the GitHub boundary actually is

`src/core/chrome.ts` is **not** a GitHub API surface — it is the committed table of Reeve's own chrome strings, one row per string and one column per language, with zero network and zero model calls. It is listed here only because earlier audit notes placed the GitHub surface there.

Every request Reeve makes to GitHub goes through one of five structural ports:

| Port                                   | Where                                     | What it can reach                                                              |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| `GitHubApi`                            | `core/forge.ts:50`                        | `issues.get/update/listComments/updateComment/getComment` — a body and replies |
| `TrackerApi`                           | `core/forge.ts:344`                       | the above plus labels, assignees, close, events, collaborator permission       |
| `ContentsApi` / `BlobApi`              | `core/forge.ts:811` / `:851`              | `repos.getContent`, `repos.createOrUpdateFileContents`, `git.getBlob`          |
| `PrApi`                                | `duties/review/pr.ts:29`                  | `pulls.get`, `pulls.listFiles` — read-only                                     |
| `ReviewCommentApi` / `ReviewThreadApi` | `review/publish.ts:270` / `threads.ts:57` | the issue-comment trio, and the review-comment trio                            |
| `AtlasApi`                             | `core/atlas.ts`                           | `repos.get`, `repos.getContent`, `git.getTree` — read-only                     |

The classifiers every row below refers to:

- `isMissing` (`core/forge.ts:863`) — `error.status === 404`, exact. **HTTP only**: a `readFile` rejection carries `.code`, never `.status`.
- `isCapacityError` (`core/forge.ts:947`) — 429, 500–599, a Node `.code` from a fixed list, `name === "TimeoutError"`, or a message containing `timed out`, **plus a 403 whose `.response.headers` carry a non-empty `retry-after` or `x-ratelimit-remaining` at exactly 0** (row 1 below). 401, and a 403 without that header evidence, are deliberately **not** capacity.

## What the ports do and do not constrain — a runtime property, recorded not fixed

The six ports above are the honest answer to "what does this code ASK to reach". They are **not** a runtime confinement, and a reader who takes them for one will be wrong in a way that matters.

`review/main.ts:952` builds one full Octokit client with `getOctokit(base.token)`. Every port in this duty is a TypeScript `interface`, erased at compile time, and the same client object is handed to all of them — `wrapPr` (`review/main.ts:803`) is a cast with a doc comment, not a wrapper that drops methods. The warrant gate at `review/main.ts:648` is a plain `if (!permitted.includes("comment"))` around the summary-comment write and nothing else.

So at runtime, the only thing standing between the review duty and the Contents API is **the token's own `contents:` scope**. Nothing in the type system, the warrant, or the port declarations narrows it.

This is recorded as an architectural fact for Round 2 to inherit, **not** as a defect to repair in Round 1 — narrowing it would mean handing each port a genuinely reduced object, which is a design change, not a hardening pass.

What `review/capabilities.contract.test.ts` therefore proves, exactly: no module in `src/duties/review/` _names_ a file-writing or PR-opening call in its source. That is a real and worth-keeping property — a reach has to be written down before it can be used, and this file makes writing it down fail. It is not the same claim as "the duty cannot reach it", and the test's own doc comment now says so.

**Three confirmed ways to defeat that test**, one closed and two open:

| #   | Evasion                                                                                                                                      | Status                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add a NEW module the test's hardcoded file list never named                                                                                  | **CLOSED** — the list is now a `readdir` of the directory, verified by re-running the reviewer's own `writeback.ts` attack and confirming RED |
| 2   | Build the call name dynamically inside a listed module — `["write","Contents","File"].join("")` behind `await import("../../core/forge.js")` | **OPEN** — the scan reads source text; closing this needs the resolved module graph                                                           |
| 3   | Declare a write method one nesting level deeper than the port-shape regex counts                                                             | **OPEN** — the regex is indentation-sensitive; closing this needs a type-level check                                                          |

2 and 3 are carried as a separate ticket, not silently absorbed.

## Reading the semantic column

`fail` = the error propagates and the run goes red. `fallback` = a different path is taken and the run continues. `skip` = the unit of work is dropped, the run continues. `retry` = the same request is made again — **nothing in this codebase does this**. `rollback` = a partial write is undone — **nothing in this codebase does this either** (see `failure-matrix.md`'s "[GAP] No rollback anywhere").

---

## `core/forge.ts` — thread body and replies

| Call site                                             | 401  | 403  | 404  | 409  | 422  | 429  | 5xx  | timeout | malformed body                              | Test                                                                      |
| ----------------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `createThread().read` → `issues.get` `:104`           | fail | fail | fail | fail | fail | fail | fail | fail    | `body: null` → `""`; no `data` → fail       | `forge.adversarial.test.ts` "createThread — read and write a thread body" |
| `createThread().write` → `issues.update` `:109`       | fail | fail | fail | fail | fail | fail | fail | fail    | n/a                                         | same                                                                      |
| `listReplies` → `issues.listComments` `:217`          | fail | fail | fail | fail | fail | fail | fail | fail    | absent author → `login: ""`, `isBot: false` | `forge.adversarial.test.ts` "listReplies — pagination boundaries"         |
| `createReply().read` (first)                          | —    | —    | —    | —    | —    | —    | —    | —       | n/a — no request is made                    | "the\_first\_read\_costs\_no\_request\_and\_so\_cannot\_fail"             |
| `createReply().read` (re-read) `:310`                 | fail | fail | fail | fail | fail | fail | fail | fail    | `body: null` → `""`                         | "the\_re\_read\_after\_write\_propagates\_…"                              |
| `createReply().write` → `issues.updateComment` `:319` | fail | fail | fail | fail | fail | fail | fail | fail    | n/a                                         | "write\_<status>\_fails\_the\_run\_no\_retry\_no\_fallback"               |

**Pagination.** `listReplies` walks at most `REPLY_PAGES` (10) pages of 100. Empty page, exactly-one-full-page (reports `more: true`), short page, mid-walk failure, `Link`-header absent / no `rel="last"` / malformed page number, backward walk from the true last page, page-ceiling stop, and **a page that shrank under the walk** are each pinned in `forge.adversarial.test.ts`.

## `core/forge.ts` — tracker reads

| Call site                                           | 401  | 403  | 404  | 429  | 5xx  | malformed / missing field                                                                       | Test                                           |
| --------------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `readStanding` → `issues.get` `:506`                | fail | fail | fail | fail | fail | every field absent → an empty standing; both label shapes read; `pull_request: null` still a PR | "readStanding — malformed and missing fields"  |
| `listRepositoryLabels` → `listLabelsForRepo` `:570` | fail | fail | fail | fail | fail | a repeated page is **kept verbatim, never deduplicated** — `ACCIDENTAL`, pinned                 | "listRepositoryLabels — pagination boundaries" |
| `listOpenThreads` → `issues.listForRepo` `:664`     | fail | fail | fail | fail | fail | `since` stops the walk at the first entry before it                                             | "listOpenThreads — pagination boundaries"      |
| `listLabelEvents` → `issues.listEvents` `:741`      | fail | fail | fail | fail | fail | a `labeled` event with no label name is dropped, never recorded blank                           | "listLabelEvents — pagination boundaries"      |

**`ACCIDENTAL` — `listOpenThreads` has no page ceiling of its own** (`forge.ts:664`). With `maxPages` undefined it stops only at `since` or a short page, so a listing that keeps answering full pages is unbounded. `maxPages` is opt-in and only `propose` passes it. Pinned as `maxPages_bounds_a_listing_that_never_serves_a_short_page`; **P2, for adjudication** — real GitHub always serves a short page eventually, so this is a robustness gap, not a live defect.

## `core/forge.ts` — mutations

Every `Effects` method, `LifecycleEffects.removeLabel` and `createRepositoryLabel` **fail** on 401/403/404/409/422/429/5xx/timeout. No retry, no fallback, no rollback of an earlier effect in the same run. `addLabels([])` and `assign([])` spend no request at all. Pinned per method × per status in `forge.adversarial.test.ts` ("createEffects", "createLifecycleEffects", "createRepositoryLabel").

**Note on 422 for `createLabel`:** GitHub returns 422 for "label already exists". It is **not** folded into success — a name that already exists carries somebody else's colour and description. Pinned.

## `core/forge.ts` — contents and blobs

| Call site                                                  | 404                   | 401/403/409/422/429/5xx | undecodable body                                                                 | Test                                          |
| ---------------------------------------------------------- | --------------------- | ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `listCorrectionFiles` → `repos.getContent` `:934`          | **fallback** → `[]`   | fail                    | non-array → `[]`                                                                 | `forge.test.ts` "listCorrectionFiles"         |
| `readContentsFile` → `repos.getContent` `:989`             | **fallback** → `null` | fail                    | present-but-undecodable → `UnreadableContentsFile`; no/non-string `sha` → `null` | `forge.test.ts` + `forge.adversarial.test.ts` |
| `readBlob` → `git.getBlob` `:1033`                         | **fallback** → `null` | fail                    | non-base64 → `UnreadableBlob` naming the sha                                     | `forge.adversarial.test.ts` "readBlob"        |
| `writeContentsFile` → `createOrUpdateFileContents` `:1113` | fail                  | fail (409 = stale sha)  | n/a                                                                              | `forge.test.ts` "writeContentsFile"           |

The `undecodable ≠ absent` distinction is load-bearing: reading an oversized shard as a cold start would append beside a file this run could not see. Pinned.

## `duties/review/pr.ts` — the pull request

| Call site                                | 401  | 403  | 404  | 429  | 5xx  | malformed                                                        |
| ---------------------------------------- | ---- | ---- | ---- | ---- | ---- | ---------------------------------------------------------------- |
| `readPr` → `pulls.get` `:118`            | fail | fail | fail | fail | fail | every field absent → empty standing, `headSha: ""`               |
| `listPrFiles` → `pulls.listFiles` `:147` | fail | fail | fail | fail | fail | unknown `status` → `"unknown"`; `patch: null` → binary/oversized |

Walks at most `FILE_PAGES` (10) pages of 100, stopping at a short page. Covered by `pr.test.ts` and `main.integration.test.ts`.

## `duties/review/publish.ts` — the owned summary comment

| Call site                                       | 401  | 403  | 404  | 409  | 422  | 429  | 5xx  | Test              |
| ----------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ----------------- |
| `readThread` → `issues.listComments` `:349`     | fail | fail | fail | fail | fail | fail | fail | `publish.test.ts` |
| `postOrReplace` → `issues.createComment` `:496` | fail | fail | fail | fail | fail | fail | fail | `publish.test.ts` |
| `postOrReplace` → `issues.updateComment` `:508` | fail | fail | fail | fail | fail | fail | fail | `publish.test.ts` |

**Pagination guard.** `readThread` walks 10 pages of 100 and reports `uncertain` when the last page read was full. `classify` (`publish.ts:474`) turns `existing === null && uncertain` into `withheld` — no write. This is the correct pattern, and it is what `threads.ts` was measured against below.

## `duties/review/threads.ts` — the owned inline threads

| Call site                                              | 422                         | 401/403/404/409/429/5xx/timeout     | Test                                                                                     |
| ------------------------------------------------------ | --------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `listOwnedThreads` → `pulls.listReviewComments` `:207` | fail                        | fail, **before any write**          | `threads.adversarial.test.ts` "list\_<status>\_fails\_before\_any\_write\_is\_attempted" |
| `syncThreads` → `pulls.createReviewComment` `:295`     | **fallback** → summary-only | fail — aborts the remaining creates | "create\_<status>\_fails\_the\_run\_rather\_than\_falling\_back"                         |
| `syncThreads` → `pulls.updateReviewComment` `:318`     | **fallback** → summary-only | fail                                | "update\_<status>\_fails\_the\_run\_rather\_than\_falling\_back"                         |

422 is the one status with a non-fatal semantic: `createReviewComment` is position-immutable and answers 422 when it cannot anchor at the commit, so the finding renders in the summary instead. Every other status throws **before** the summary is written, so a permission failure leaves no half-written state for the next run to duplicate.

**No rollback.** A non-422 failure mid-loop leaves earlier creates standing. Documented in `failure-matrix.md`; pinned as `a_non_422_failure_aborts_the_remaining_creates_rather_than_continuing`.

### Two DEFECTS found here, fixed with regression tests

1. **`syncThreads` wrote against an uncertain listing.** `listOwnedThreads` reports `uncertain` when the walk ended at a full page with none of this duty's threads found — "so the caller can withhold writes instead of risking a copy". `syncThreads` read the flag, passed it through, and wrote anyway; `main.ts:776` then warned "so none were written this run", which was false. Fixed by withholding (mirroring `publish.ts:474`). Regression: `uncertain_listing_withholds_thread_writes_instead_of_duplicating`.
2. **A thread GitHub marked outdated was re-created on every run, for ever.** An outdated review comment comes back with its live `line` no longer equal to the finding's while its marker still names the position key, so the key-only lookup found the outdated one, decided the line had moved, and created a fresh copy — again the next run, and the next. Fixed by matching on the live position (key **and** line **and** path); no match is a create, which covers both "nothing owned here" and "owned but drifted". Regression: `rerun_updates_its_own_thread_instead_of_duplicating`.

   The fix does **not** depend on knowing exactly what GitHub sends for an outdated comment. `threads.ts:222` maps an absent `line` to `null`, and the repository carries no recorded GitHub payload for this case, so that mapping is an unverified inference — but the robustness comes from the FRESH comment reporting `line === finding.line`, not from the stale one reporting any particular value. Under every alternative payload shape the outcome is bounded at two threads or is a no-op, and it can never suppress a legitimate create.

3. **`isUnprocessable` masked a non-object rejection.** `(error as {status?}).status` throws a `TypeError` inside the catch when the rejection value is `null`/`undefined`, replacing the real failure. Made null-safe. Regression: `a_rejection_that_is_not_an_object_still_reaches_the_caller_unmasked`.

## `core/atlas.ts` — the workspace atlas

| Call site                                   | 404                          | 429 / 5xx / timeout                               | 401/403 | Test                                                                             |
| ------------------------------------------- | ---------------------------- | ------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `repos.get` `:343`                          | **fallback** → `EMPTY_ATLAS` | **fallback** → `{packages: [], truncated: true}`  | fail    | `atlas.test.ts`                                                                  |
| `git.getTree` `:362`                        | **fallback** → `EMPTY_ATLAS` | **fallback** → truncated                          | fail    | `atlas.test.ts`                                                                  |
| root manifest → `repos.getContent` `:407`   | **skip** → no globs          | **fallback** → truncated                          | fail    | `atlas.adversarial.test.ts` "a GitHub failure never makes a package look absent" |
| member manifest → `repos.getContent` `:425` | **skip** → package absent    | **fallback** → keep what was read, mark truncated | fail    | same                                                                             |

The distinction the whole module rests on: `EMPTY_ATLAS` means "this repository has no packages"; `truncated: true` means "this run could not tell". Conflating them makes `propose` retire an area label whose package it merely failed to read.

## Filesystem reads inside the review duty

Not GitHub, but the same classifier was being asked — and that was a defect.

| Call site                          | Missing file                      | Other read error     | Test                                                                                             |
| ---------------------------------- | --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `review/rules.ts` `readRules`      | cold start, **silent**            | warn + cold start    | `rules.adversarial.test.ts` "a\_missing\_rules\_file\_is\_the\_cold\_start\_without\_a\_warning" |
| `review/rules.ts` `readPackFile`   | fail, naming the ref and the path | fail, naming the ref | "a\_referenced\_pack\_that\_is\_not\_on\_disk\_names\_the\_reference\_and\_the\_path"            |
| `review/risk.ts` `readRiskProfile` | default, **silent**               | warn + default       | `risk.adversarial.test.ts` "a\_missing\_profile\_is\_the\_default\_without\_a\_warning"          |

**DEFECT, fixed.** All three classified a `readFile` rejection with `forge.ts`'s `isMissing`, which reads an HTTP `status`. A Node `ENOENT` carries `.code` and no `.status`, so the "missing is the cold start" branch was **unreachable in all three**: every repository without a rules file or a risk profile — the overwhelming majority — got a spurious `could not read …` warning on every run, and a mistyped pack reference reported a raw `ENOENT` instead of the sentence naming what to fix. Replaced with a local `isMissingFile` mirroring `warrant.ts:392` and `respond/guidance.ts:55`.

---

## Open rows, for adjudication

| #   | Where                                  | What                                                                                                                                                                                                                                                                                                                | Priority |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `core/forge.ts:947` `isCapacityError`  | **Adjudicated and fixed** — see "Settled since the first pass" below.                                                                                                                                                                                                                                               | **P1**   |
| 2   | `core/forge.ts:664` `listOpenThreads`  | No page ceiling when `maxPages` is undefined.                                                                                                                                                                                                                                                                       | P2       |
| 3   | `core/forge.ts:527`                    | The label mapping does not guard a `null` entry (`label.name` throws) while the assignee mapping one line below does (`assignee?.login`). GitHub does not send one today. Pinned both ways.                                                                                                                         | P3       |
| 4   | everywhere                             | **No retry on any GitHub failure.** Already recorded in `failure-matrix.md`; restated here because it is the single largest semantic in the table and every row above depends on it.                                                                                                                                | P1       |
| 5   | `review/threads.ts:181`                | `uncertain` is only reported when **zero** owned threads were found. A PR with owned threads on page 1 and more past page 10 reports `uncertain: false` and can still duplicate the ones it never saw. Narrower than the two defects fixed above, and the fix is not obvious (the walk would have to be unbounded). | P2       |
| 6   | `review/threads.ts:185`                | `threadBody`'s cap does not apply when `budget <= 0` — a finding whose rule id and path alone exceed 8000 characters is carried uncapped. Bounded in practice by GitHub's own 65536 ceiling.                                                                                                                        | P3       |
| 7   | `review/capabilities.contract.test.ts` | Evasions 2 and 3 in the table above — dynamic call-name construction, and a port method declared at a deeper indentation than the shape regex counts. Both need a type-level or module-graph check.                                                                                                                 | P2       |

### Settled since the first pass

**`core/forge.ts` `isCapacityError` — a rate limit's run colour depended on which status GitHub chose.** docs.github.com ("Rate limits for the REST API" → _Exceeding the rate limit_; "Troubleshooting the REST API" → _Rate limit errors_) states that a secondary limit "returns a 403 or 429 response" and that exceeding a primary limit answers "403 or 429" with `x-ratelimit-remaining` at 0. One cause, two statuses, GitHub's choice — so classifying by status alone made an identical rate limit green on 429 and red on 403.

**Adjudicated 2026-08-18: fixed, narrowly.** A 403 is capacity only when its `.response.headers` are GitHub naming the limit — a non-empty `retry-after`, or `x-ratelimit-remaining` at exactly 0 (the number, or `"0"` trimmed; never coerced). A bare 403, a 403 on a healthy quota, a 403 whose headers are absent, a string, an array, or reachable only through a prototype, all stay the red permission error they were. No other status gained a header-driven path, and 401 is excluded outright. Pinned in `forge.test.ts` ("isCapacityError — GitHub's 403/429 rate-limit ambiguity") and `forge.adversarial.test.ts` ("isCapacityError — header shapes that must not decide a run's colour").

**`review/disposition.ts` — a multi-line reply loses every disposition in it.** `LINE_FORM`/`PATH_FORM` are anchored `^…$` with `/i` and no `/m`, and `readDispositions` runs one `.exec` over the whole reply body. A reply holding two triage lines matches neither anchor and yields nothing — including the line that would have worked alone. That is silent data loss from a human's deliberate input, so it was reclassified from "adjudicate" to **P1**.

**Adjudicated 2026-08-18: code wins as behaviour; the doc was wrong and has been corrected.** A `/m` parse over untrusted reply bodies widens the surface on which a disposition — the one thing on a review thread that speaks for a person — can be minted, and that widening was not authorised in this round. `disposition.ts`'s module header and `readDispositions`' doc comment now state the loss plainly, and `disposition.adversarial.test.ts`'s `a_multi_line_reply_loses_every_disposition_including_the_one_that_would_have_worked` pins it with the working spelling (two separate replies) beside it.
