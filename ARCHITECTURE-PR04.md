# PR 04 — Inline findings + GitHub review threads: architecture (approved)

Review duty evolved from one owned comment to:

```
Review
 ├── summary            (kept — the owned marker-carrying issue comment, idempotent)
 └── findings           (each finding with a proven line → one owned inline review thread)
```

All prior research (Grand Architect + GitHub API workflow reviewers) incorporated.

## Design decisions (locked)

1. NEW module `src/duties/review/threads.ts`. Own structural port `ReviewThreadApi`:
   - `rest.pulls.listReviewComments({owner,repo,pull_number,per_page,page})` — **paginated** (walk pages until < per_page; this is the anti-duplicate guard for 100+ threads, Architect F).
   - `rest.pulls.createReviewComment({owner,repo,pull_number,body,commit_id,path,line})` — line = proven new-file line (RIGHT side default), commit_id = headSha.
   - `rest.pulls.updateReviewComment({owner,repo,comment_id,body})` — body ONLY. **Position is immutable** (Architect D, API research §1).
2. Local thread marker `<!-- reeve:review:thread source=<payload> -->` (string literal inside threads.ts — NOT core markerFor; avoids touching core and re-churning all bundles). Payload = `${findingFingerprint}.${findingId}` where findingId is the run's own stable-at-position key. Strict final parse via `isFingerprint` + nonempty id; any body with the prefix but no valid payload is NOT owned (matches `official === ""` rule from publish.ts findMarked). Bot author required (`isBotAuthor`).
3. THREAD KEY = **position-based** `ruleId|path|line` (NOT finding.id — preflight findings all share id `review-preflight`, Architect A). This matches reconcile's atPosition semantics exactly. A finding is a single thread when two findings share key → the first wins the thread, the second renders summary-only (avoid same-position collision the Architect flagged).
4. **Anchorability** (`anchorable`): `line !== null && status !== "resolved" && diffStanding.files.get(path)?.has(line) === true`. All non-resolved findings with a line are anchorable by construction (parse proved the line; reconcile only persists when the line stands).
5. **Plan** (per reconciled entry, in canonical order):
   - not anchorable → summary-only, never touch any existing thread for it.
   - anchorable + no existing owned thread at key → CREATE.
   - anchorable + existing owned thread at key:
     - listing position (path+line from the listing) === finding position → PATCH body (update).
     - listing position !== finding position → CREATE new thread at the finding's proven line (leave old thread; GitHub marks it outdated itself).
   - existing owned thread whose key matches NO current finding → leave untouched (resolved/outdated).
     Thread body = `findingLine(finding)` line + `\n\n` + thread marker + `\n\n` + fixed machine-written notice (`chrome("reviewFooterFloor", null)`); body capped (findings can be huge — cap at ~8000 chars, enough for the finding body + notice).
6. **Failure semantics** (`syncThreads`):
   - try create/update; on **422 only** (unanchorable — line not in diff at commit, race) → capture finding as thread-fallback (goes to summary only), do NOT throw.
   - on **403 / 401 / 404 / any other error** → throw (fail red, D5 loud). 404 = scope missing (pulls.get already succeeded).
   - **Ordering: all thread writes complete BEFORE the summary write** (main.ts wiring). A thread permission failure aborts before the summary is written — summary never corrupted, rerun re-lists threads and reconciles (no duplicates). 422 fallbacks never block the summary write.
7. **Idempotency**: derived from the live listing each run (D6 repository is database). No envelope/Previous change. A rerun: listing returns the owned threads, plan yields unchanged → no writes. Never duplicates.
8. Dry-run: list review comments, compute plan, log it (no writes). `posted` output stays summary-only.
9. **No new inputs** — threads are always-on when `comment` is granted. action.yml, .env.example, contract test untouched.
10. main.ts wiring: after the guarded gates (permitted/includes/floor/silentNoVerdict/allShownIgnored/dryRun) — threads `await syncThreads(...)` BEFORE `postOrReplace(...)`. The thread sync needs `diffStanding`, `final`, `pr.headSha`.

## File changes

- NEW `src/duties/review/threads.ts` (+ unit tests `threads.test.ts`, `threads.integration.test.ts`? — see Tester).
- `src/duties/review/publish.ts` — export `findingLine` (it is already defined, currently private `findingLine` at :370) for reuse, and export `sanitize`/`chrome`? No — only export `findingLine`.
- `src/duties/review/main.ts` — wire syncThreads; import `syncThreads`/`planThreads`.
- `docs/reference/duties/review.md` — update single-comment invariant section (:181-223), non-goal (:363-370), `commented` output description (:291), `github-token` row (:136), :9 and :23.
- `docs/doctrine/north-star.md:627` — Stage 5c copy ("exactly one comment" → owned summary + inline threads).
- `README.md:159` + `docs/development/duties.md:117` + `docs/getting-started/installation.md:72` — same copy.
- `eval/drivers/review.ts` — ReviewTracker gains thread counts; reviewRoutes serves `pulls/{n}/comments` GET/POST and `pulls/comments/{id}` PATCH; ReviewEffect gains threads fields; scenarioOf reads new fixture fields.
- `eval/runner.ts` — reviewLine asserts thread count; ReviewEffect type updated.
- NEW eval fixture `eval/fixtures/review/inline-threads/.expected.json` (+ content files) — MUST be a finding.
- `eval/contract/exit-code.integration.test.ts` — update "5 review = 48" → count becomes 49 with the 6th fixture.
- Possibly update existing fixtures (open-pr now has anchorable findings → 1 thread).

## Thread marker payload details

```
renderThreadMarker(finding): `<!-- reeve:review:thread source=${fp}.${id} -->`
  where fp = findingFingerprint(finding) (16 hex), id = `${ruleId}|${path}|${line||""}` (the key, also used for dedupe across findings)
splitThread(body): { key: string | null } — parse after prefix, up to ` -->`; validate fp with isFingerprint(str.split('.')[0]); key remainder must be nonempty. If parse fails → not owned.
```

## Fallback on 422 (documented behavior)

A finding whose createReviewComment returns 422 → rendered summary-only; log a line; run stays green. The summary comment when written will 100% contain every finding (existing render logic — threads are additive, summary unchanged).

## Interactions to be careful about

- `main.integration.test.ts` stub MUST serve `pulls/{n}/comments` GET before ANY case runs — otherwise listReviewComments 404s and every case fails red. The existing integration stub does NOT serve these routes today.
- eval driver reviewRoutes likewise (listReviewComments NOT served → 404 → run red).
- `open-pr` fixture: line 3 has BOTH a preflight blocked finding AND a model dedup finding — two findings, same key? No: keys use ruleId, so `review-preflight|src/app.ts|3` vs `dedup|src/app.ts|3` differ. open-pr would create TWO threads (both lines = 3). Verify GitHub allows two comments on one line (it does).
- The 422 test path: use a stub that 422s createReviewComment.
- Preflight findings `line` may be proven lines; blocked findings carry `line`.
- `pnpm eval all` gate: the new inline-threads fixture must be a finding; existing open-pr may need expected.gain threads.
