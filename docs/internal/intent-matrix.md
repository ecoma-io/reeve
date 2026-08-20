# Reeve intent matrix

Internal engineering document, not marketing. Each row states an intent, the
invariant that makes it real, the scope it applies to, required and forbidden
behaviour, the failure semantics, and the tests that already pin it down. Every
row is grounded in the implementation at the commit this was written against
(`hardening/intent-contract`). Where the implementation and documented intent
disagree, the disagreement is recorded under **For adjudication** at the end,
not resolved here. Where a required capability is missing in code, the row is
marked **[GAP]** with `file:line` evidence.

A row is not a promise the product makes; it is the engineering contract the
code already keeps, written down so a future change knows what it may not
break. `Tests:` entries cite existing executable evidence — nothing below asks
for a test that already exists.

Legend: **A** provider orchestration · **B** authority/warrant · **C** duty
contract (per duty) · **D** configuration · **E** finding lifecycle ·
**F** review · **G** untrusted input.

---

## A — MODEL/PROVIDER ORCHESTRATION

### A1 — The roster is an ordered rotation, never `models[0]`

- **Intent:** stages consume models as an ordered fallback chain, named by the
  roster, never by unconditional first-index access.
- **Invariant:** `rotateModels` walks the roster in order, asks each still-
  standing model exactly once, and stops at the first success. A `models[0]`
  index appears nowhere in a model-consumption path (`grep` shows one at
  `src/duties/harmonise/draft.ts:330`, which is a fallback _label_ after an
  ordered `find` — not a consumption decision).
- **Scope:** `src/core/provider.ts` (`rotateModels` 918-936), every duty stage.
- **Required:** first-listed model asked first; a failure rotates to the next;
  a never-retry rule; success stops the chain.
- **Forbidden:** skipping a roster entry, retrying a failed model inside one
  run, `models[0]` as a consumption choice.
- **Failure:** whole chain fails → the stage reports its failures and the caller
  decides green/red (see A5).
- **Tests:** `src/core/provider.test.ts` — rotation order / no-retry / no-skip
  (656, 666), `stub.asked` exclusion assertions in `src/duties/*/main.integration.test.ts`.

### A2 — Malformed model output is NOT success

- **Intent:** a provider that answers with something that is not the requested
  shape has not completed the stage; the protocol error is distinguished from
  capacity weather and is never glossed into an empty-but-green result.
- **Invariant:** `readCompletion` classifies body-level malformation (bad JSON,
  no choices, non-string/empty content, an `error` field inside a 200) as
  `protocol`, and protocol failures are deliberately _not_ grounded in Weather
  (`src/core/provider.ts:553-612`, `classifyStatus` 624-628).
- **Scope:** `src/core/provider.ts`; every duty's parse boundary.
- **Required:** a 200 carrying `{"error":…}` is a protocol failure; a verdict
  that fails `parseVerdict` yields NO verdict, an `unreadable` warning, and
  nothing applied (`src/duties/triage/verdict.ts:119-155`).
- **Forbidden:** best-effort mining of a half-parsed answer, treating an
  `error` field as capacity weather, posting an unparsed translation.
- **Failure:** all-protocol exhaustion → red run naming the reasons
  (see A6).
- **Tests:** `provider.test.ts` 380-494 (200-with-error, string error, no
  field); `triage/verdict.test.ts` 112-118 (`unreadable` handed back whole);
  `triage/main.integration.test.ts` 790 (`does nothing at all with a verdict it
could not read`).

### A3 — Capacity is weather; auth is configuration

- **Intent:** 429/5xx/timeout is weather the roster rotates through; 401/403 is
  a broken credential that fails the run red, immediately (or, on a
  multi-endpoint run, once every endpoint auth-failed).
- **Invariant:** `reckon` `"capacity"` grounds the model in Weather; `"auth"`
  throws `AuthenticationFailure` at once on a single endpoint, and on a
  multi-endpoint run defers to `settleAuth` so the run ends red only when every
  endpoint auth-failed (`src/core/provider.ts:873-885`, `settleAuth` 897-901).
- **Scope:** all duties.
- **Required:** a 429 mid-run is a warning plus `remaining`, never red; a 401 is
  red on the first model that reports it; `authSection` names refused endpoints
  on every run's page.
- **Forbidden:** rotating past an auth failure on a single-endpoint run;
  carrying on silently after an endpoint refused the key.
- **Failure:** red with the provider's reason quoted and the API key masked.
- **Tests:** `provider.test.ts` auth-throw 697, settleAuth multi-endpoint
  971-1063, weather grounding 737-775; `triage/main.integration.test.ts` 843;
  `translate/main.integration.test.ts` 668.

### A4 — No unnecessary calls after success, and retries never disturb the roster

- **Intent:** a stage stops spending once it has an answer; a retry (translate
  chunk draft) re-enters the rotation at the next still-standing model and
  cannot double-ask an established model.
- **Invariant:** `rotateModels` returns on first success; Weather's `grounded`
  consultation means an exhausted model is never asked again by a later stage.
- **Scope:** all stages; translate chunk loop (`engine.ts`), triage stage chain.
- **Required:** first successful answer ends the stage; a chunk draft's probe is
  keyed per model.
- **Forbidden:** asking a grounded model again later in the same run; calling a
  next stage before the previous stage's answer is in hand.
- **Tests:** `provider.test.ts` 1161-1211 (`assembleClient` seeds), 1192
  (grounded models never re-asked).

### A5 — Starvation (all-capacity) delivery vs protocol exhaustion (all-config)

- **Intent:** “every model is out of capacity” and “every model returned a
  protocol error” are different failures with different run colours.
- **Invariant:** `starved()` (all roster models grounded) → duty warns and
  stays green, delivering what it finished; `protocolExhausted()` (every failure
  protocol AND `failures.length >= models.length`) → `failIfProtocolExhausted`
  sets the job red naming each reason (`src/core/provider.ts:814, 828-837`;
  `src/core/summary.ts:129-146`). Empty roster → neither (a duty that asked no
  model has not starved).
- **Scope:** all model-asking duties (call sites `triage/main.ts:1009`,
  `respond/main.ts:462`, `duplicate/main.ts:630`, `translate/main.ts:366,468`,
  `harmonise/main.ts:668`).
- **Required:** capacity-only exhaustion ends green with a named “every model
  failed” note and `starved` output true; protocol-only exhaustion ends red.
- **Forbidden:** red-failing a 429-only run; a malformed-answer run reported as
  clean “nothing to do”.
- **Tests:** `provider.test.ts` 777-806 (`starved`/`protocolExhausted`);
  `summary.test.ts` `failIfProtocolExhausted` block; `triage/main.integration.test.ts`
  814 (stays green when every model failed).

### A6 — screen-models: the cheap roster, with a documented fallback

- **Intent:** `screen-models` is the cheap roster for spam/off-topic and for
  language detection; an empty `screen-models` turns screening off and detects
  language with the main `models` roster — the documented default, not a
  degraded mode.
- **Invariant:** `sift` returns `{dropped: null}` immediately when its models
  list is empty (`src/core/spam.ts:66`); detection falls back at
  `src/duties/triage/main.ts:911`
  (`settings.screenModels.length > 0 ? settings.screenModels : settings.models`).
- **Scope:** `core/spam.ts`, `core/detect.ts`, triage/respond decision paths.
- **Required:** empty `screen-models` → no cheap call is made and no expense is
  skipped; non-empty → the cheap roster is the only roster asked for screening
  and detection, and the expensive roster is not reached.
- **Forbidden:** an empty cheap roster silently making the expensive roster do
  cheap-roster work; screening being bypassed when a roster IS configured.
- **Failure:** cheap roster all-fails → fails open, thread carried on to the
  expensive roster (a dropped real report costs a contributor the answer).
- **Tests:** `core/spam.test.ts` 59 (off when no roster, asks nothing), 67
  (carries on when the cheap roster failed); `triage/main.integration.test.ts`
  1026, 1037, 1051.

### A7 — The separators keep one meaning: `,` is a fallback, `|` is a seat

- **Intent:** `,` means fallback in `models` and in `judge-models` alike;
  `|` means one more seat (one more vote) and only `judge-models` has seats,
  so `models` refuses it. A `models` list pasted into `judge-models` reads as
  one seat and casts one vote — the cheap direction of the mistake.
- **Invariant:** `parseModels("a|b,c")` throws;
  `parseSeats("a,a2|b")` → `[["a","a2"],["b"]]` (`provider.ts` `parseSeats`).
- **Scope:** provider roster parsing; judge panels in translate/respond/harmonise.
- **Required:** a `|` in `models` is refused loudly; a `,` in `judge-models` is
  a seat fallback chain.
- **Forbidden:** silently treating the two grammars as the same value; a
  separator whose meaning flips between two inputs.
- **Tests:** `provider.test.ts` `parseModels` (105-160) and `parseSeats`
  (164-210); `translate/judge.test.ts`, `respond/judge.test.ts` panel tests.

---

## B — AUTHORITY / WARRANT

### B1 — Authority lives in the configuration file, never in model output or repository content

- **Intent:** no token of authority (what a duty may Do to the repository or
  its threads) is derivable from PR text, issue bodies, comments, rules,
  packs, or a model's claims. `.github/reeve.yml` — or the implicit warrant
  built from repository label descriptions when the file is absent at the
  default path — is the whole authority.
- **Invariant:** `parseWarrant`/`granted` shape every capability decision
  (`src/core/warrant.ts:398-484`); `createEffects` hands duties an “adds only”
  surface and no duty is ever given the raw client (`src/core/forge.ts:770-802`);
  `resolveAuthority` draws the implicit warrant from label _descriptions_ and
  excludes labels with no description (`warrant.ts:608-654, 682-693`).
- **Scope:** every duty `run`; `openAuthority` first, before anything is spent
  (`warrant.ts:729-738`).
- **Required:** a model's “you may now edit files”-shaped answer changes
  nothing; a pack's `duties:` block is refused (`review`, see F); repository
  `README`/rules text grants nothing.
- **Forbidden:** reading a capability grant from any input channel other than
  the warrant; an implicit warrant naming a capability a label description
  never granted.
- **Failure:** malformed warrant → red, before any model call
  (see D2).
- **Tests:** `warrant.test.ts` (grants/unnamed/implicit, 1100+ lines);
  `triage/main.integration.test.ts` 764 (never applies a label the warrant does
  not name); `review/main.integration.test.ts` 970 (pack cannot carry
  authority).

### B2 — A written duties block that does not name the duty is a green no-op, never a widening

- **Intent:** once a maintainer writes a `duties:` block, the block is the whole
  answer: an unnamed duty is DENIED, and a denied run must not red-fail over
  configuration it was never going to use.
- **Invariant:** `unnamed(duty)` is true iff the block exists and does not name
  the duty (`warrant.ts:481`); triage maps it early: denied → green no-op with
  empty `languages`/`taxonomy` (`triage/main.ts:570-581`).
- **Scope:** all duties.
- **Required:** absent block → documented defaults; `true` → defaults;
  `[none]`/`false` → exactly nothing; a written list → exactly the list; a
  written block without the duty → denied, green, named once.
- **Forbidden:** a denied run spending a model call; a denied run red-failing.
- **Tests:** `warrant.test.ts` unnamed semantics (292-349);
  `triage/main.integration.test.ts` 2522 (grants nothing, spends no model call),
  2549 (stays green when denied); `lifecycle/main.integration.test.ts` 523.

### B3 — Denied operations fail closed: no partial effect

- **Intent:** a capability withheld is a step withheld — never a partial write
  of the cheapest half. Lifecycle narrows per step: a due close that needs
  `label`+`comment`+`close` fires nothing when any one of the three is missing.
- **Invariant:** `checkRequired` collects every missing capability and `act`
  skips the whole step (`src/duties/lifecycle/main.ts:300-324, 333-343`);
  triage applies only `decision.applied` after gating `permitted.includes("label")`
  (`triage/main.ts:1046`); translate decides first and gates the write at
  `text.ts:218` after drafting — declared, intentional ordering.
- **Scope:** lifecycle `act`, triage `apply`, translate publish, review comment
  gate, dependa `mayPublish = canEdit && canOpenPr && !dryRun`
  (`dependa/main.ts:486-488`).
- **Required:** the whole step is withheld when any requirement is missing; the
  summary names the withheld step and why.
- **Forbidden:** apply-label-without-comment partial firing; an edit without the
  PR that would review it; a remediation write under a propose-only grant.
- **Tests:** `lifecycle/summary.test.ts` 141 (names every step due but
  withheld), `triage/main.integration.test.ts` 958 (touches nothing when the
  warrant grants none), `duplicate/main.integration.test.ts` 532 (withholds the
  comment).

### B4 — Dry-run can never mutate

- **Intent:** `dry-run: true` changes nothing anywhere — no label, comment,
  edit, PR or state write — while still reporting the full would-do ledger.
- **Invariant:** each duty routes effects behind `if (!dryRun)`: triage
  `NOTHING_DONE` (`triage/main.ts:742-753`), lifecycle `act`
  (`lifecycle/main.ts:338-364`), translate before publish (`text.ts:196-212`),
  duplicate rehearsal (`duplicate/main.ts:781-807`), review `rehearse` +
  `dryRunThreads` (`review/main.ts:734-760`), harmonise gates state writes
  (`harmonise/main.ts:339`) and passes `dryRun` to `publishSync`
  (`harmonise/main.ts:721`), dependa `mayPublish` excludes dryRun,
  remediation reports proposals and writes nothing.
- **Scope:** all duties.
- **Required:** dry-run output still reports processed/remaining/proposed and
  the would-be publication body; no side effect touches GitHub.
- **Forbidden:** a dry-run run that applies, closes, edits or opens anything.
- **Tests:** per-duty `main.integration.test.ts`: triage 1182, translate 906,
  lifecycle 545, duplicate 664, respond 727, review 1294, remediation 390 (all
  assert no mutation + full report).

### B5 — Doctor and runtime resolve authority consistently

- **Intent:** `doctor` checks the same warrant semantics a run acts under.
- **Invariant:** both read `readWarrant`/`resolveAuthority`; a malformed
  warrant is red in both; an explicitly-chosen missing path is red in both.
- **Tests:** `src/doctor/diagnose.test.ts` 111 (red when the warrant does not
  parse), 119 (red when a named path has no file).

### B6 — Model/human voice separation: model confidence never grants, human disposition never pretended

- **Intent:** the `confidence` floor and verify-evidence ladder decide what a
  model MAY say; only a maintainer reply can dispose a review finding, and a
  disposition is attributed and strict.
- **Invariant:** `enforceLabels` refuses NaN/Infinity confidence always
  (`src/core/enforce.ts:107`); review `verifyFindings` reports findings only at
  evidence ≥ 1 (`src/duties/review/evidence.ts`); dispositions parse from a
  strict anchored grammar and only from an eligible (non-bot, non-author,
  OWNER/COLLABORATOR/MEMBER) reply (`src/duties/review/disposition.ts:40-44,
77-99`).
- **Tests:** `enforce.test.ts` confidence block (NaN/Infinity refusal);
  `review/evidence.test.ts` 22-33; `review/disposition` grammar and
  eligibility via `review/findings.test.ts` disposition-carrying rows.

---

## C — DUTY CONTRACT

Each row: default capabilities, model-fallback posture, dry-run placement,
failure semantics, idempotency marker, mutation boundary. Intentional
differences are documented at the end of each row, and the cross-duty
deliberate-difference table is in **Disagreements**.

### C1 — triage

- **Intent:** screen → detect language → recall corrections → model verdict →
  enforce taxonomy/floor against the thread-as-stood → apply exactly what
  `label` grants; close duplicates only via `gateClose`, always as
  `not_planned`.
- **Defaults:** `DEFAULT_CAPABILITIES=["label"]` (`capabilities.ts`).
- **Marker/idempotency:** `markerFor("triage")` split — first marker wins,
  truncation reads as never-published; `closeMarkerFor("triage")` for
  attribution (`src/duties/triage/outcome.ts:49`).
- **Failure:** all-capacity → green with “every model failed”; all-protocol →
  red; auth → red immediately; unparsed verdict → nothing applied + warning.
- **Bounded exception:** `record` writes corrections through the Contents API
  behind `recordGrantedByRun(permitted)` + `open-pr` for branch writes
  (`triage/main.ts:639-653`); lifecycle's removeLabel is the only other
  bounded exception (`src/core/forge.ts:1158-1174`).
- **Tests:** `triage/main.integration.test.ts` (the sweep ~90 cases),
  `triage/verdict.test.ts`, `triage/outcome.test.ts`.

### C2 — translate

- **Intent:** append a translation into the body, never overwrite the author's
  half; capability withheld = a reason not to write, not not to have decided
  (dry-run and the `edit-body` gate sit AFTER drafting).
- **Defaults:** `DEFAULT_CAPABILITIES=["edit-body"]`.
- **Marker:** `markerFor("translate")`; `fingerprint` keyed on text+keys,
  order/case-insensitive.
- **Failure:** one chunk failing skips the whole language
  (`engine.ts:157`); protocol-exhaustion → `failIfProtocolExhausted` at the
  single-operation boundary; capacity → deliver-what-finished.
- **Tests:** `translate/main.integration.test.ts` (dry-run 906, edit-body
  withholding 1556, auth-red 668), `engine.test.ts` 242/261/295, `text.test.ts`.

### C3 — duplicate

- **Intent:** find the strongest duplicate from a shortlist, only ever comment
  with a verdict naming an offered candidate; a verdict naming a thread the
  shortlist never offered is refused whole.
- **Defaults:** `DEFAULT_CAPABILITIES=[]`, `DUPLICATE_CAPABILITIES=["comment"]`.
- **Marker:** `postOrReplace`/`rehearse` fingerprint.
- **Failure:** `judge.model===null` → `failIfProtocolExhausted`
  (`duplicate/main.ts:630`); all failing/capacity → green + note; over-floor
  verdict under floor → report-withhold.
- **Tests:** `duplicate/verdict.test.ts`, `duplicate/proposal.test.ts`,
  `duplicate/main.integration.test.ts` 478-731.

### C4 — respond

- **Intent:** speak once, never over a human, never over its own fingerprint
  drawn marker, and fail closed when the reply list is truncated before either
  guard can rule.
- **Defaults:** `DEFAULT_CAPABILITIES=[]`, `RESPOND_CAPABILITIES=["comment"]`.
- **Marker:** `isFingerprint(marker.split(...))` — a forged public-shaped
  marker is NOT this duty's reply (`respond/main.ts:234-241`).
- **Failure:** truncated list → no draft, no post, red? (green with a
  refusal note — see Disagreements), auth-red, protocol → red.
- **Tests:** `respond/main.integration.test.ts` 501/518/529/547 (human-first,
  bot-author, once-only, forged marker), `walkReplies` truncation case.

### C5 — lifecycle

- **Intent:** run a staleness policy from labels/timestamps alone (no model);
  A13 whole-step capability narrowing; never remove a label a human applied;
  the bounded removeLabel exception for a track's own clock-hand.
- **Defaults:** `DEFAULT_CAPABILITIES=["label","comment"]`,
  `LIFECYCLE_CAPABILITIES=["label","comment","close"]`.
- **Marker:** `MARKER` + `fingerprintFor(track, stepIndex, anchor)`.
- **Failure:** malformed warrant → red before spending; policy absent → green
  no-op naming the missing key; capacity mid-sweep → still-green, stopped
  early, `processed`/`remaining` honest.
- **Note:** languages resolve LENIENTLY — `[]` reads as English, unlike every
  other duty (`lifecycle/main.ts:126-137`). Adjudication row D below.
- **Tests:** `lifecycle/main.integration.test.ts` 512-764, `lifecycle/summary.test.ts`.

### C6 — harmonise

- **Intent:** synchronise documentation across languages; state-branch writes
  require BOTH `edit-file` AND `open-pr`; default-branch writes require
  `edit-file`; dry-run passes through to `publishSync` and writes nothing.
- **Defaults:** `DEFAULT_CAPABILITIES=[]`.
- **Failure:** source-language null → `core.setFailed`
  (`harmonise/main.ts:250`), a config error not weather; protocol exhaustion →
  `failIfProtocolExhausted` (`harmonise/main.ts:668`); classify whole-roster
  protocol → throw (`harmonise/main.test.ts:34`).
- **Tests:** `harmonise/main.test.ts`, `harmonise/publish.test.ts`,
  `harmonise/draft.integration.test.ts`, `harmonise/budget.test.ts`.

### C7 — dependa

- **Intent:** discover updates, assess risk (deterministic facts + optional
  model interpretation), open reviewable PRs; publication requires BOTH
  `edit-file` AND `open-pr` and is excluded under dry-run.
- **Defaults:** `DEFAULT_CAPABILITIES=[]`, `DEPENDA_CAPABILITIES=
["edit-file","open-pr"]`.
- **Recomposition:** sequential manifest edits composed cumulatively — the only
  place edits are combined (`dependa/main.ts:509-535`).
- **Failure:** invalid edit round-trip → publication refused; budget
  `max-requests` exhaustion → remaining groups skipped with a warning; any
  refused/missing risk parses dropped, never best-effort.
- **Tests:** `dependa/risk.test.ts` (parseInterpretation strict refusals
  292-316), `policy.test.ts`, `publish.test.ts`, `validation.adversarial.test.ts`.

### C8 — review

- **Intent:** review a pull request, keep exactly one owned summary comment plus
  one owned inline thread per diff-proven finding, dedupe/reconcile against the
  previous run, never stamp a diff nobody read as clean, and never mutate
  source.
- **Defaults:** `DEFAULT_CAPABILITIES=[]`, `REVIEW_CAPABILITIES=["comment"]`.
- **Guards:** `silentNoVerdict` (allClearEarned false && final empty →
  withhold), `allShownIgnored` (an `ignore.paths` removal of every file can
  never act alone → withhold), `belowFloor` (nothing below the floor reaches
  the PR), comment-not-granted → green withheld, threads sync BEFORE the
  summary write (`review/main.ts:624-733`).
- **46-2b:** every model finding is verified against deterministic evidence and
  **badged with the result** — never dropped for failing verification
  (`review/verify.ts`, `review/publish.ts:622-625`).
  - **ADJUDICATED (2026-08-18): badging, code wins.** This row previously read
    "must be verified … before it may be reported", which is false against the
    code and was confirmed three ways: `publish.ts:625` renders `· not
verified` on a finding's own line, `main.ts:577-592` passes
    `verifyFindings`' output straight into `reconcile` with no filter on
    `verification`, and `summary.ts:155-163` prints a `N verified · M not
verified` tally that only means anything if unverified findings are
    reported. The code is authoritative and its posture is the right one:
    `verify.ts` proves a snippet against a line the diff actually carries,
    which is a provenance check rather than a truth oracle. A real finding
    whose snippet the model paraphrased would be discarded silently by a
    gate; badged, it reaches the maintainer marked for exactly what is
    unproven about it. No behavioural change — the matrix was wrong, not the
    duty. The mutation table pins both halves of the boundary
    (`tools/mutation.mjs`: "empty proven text verifies every claim",
    "zero-weight evidence marks a finding verified").
- **Failure:** corrupt envelope → loud, treated as nothing found, never a
  partial read (`review/publish.ts` decodeEnvelope); 422 on a thread write →
  fallback to the summary comment, never silence + no report.
- **Tests:** `review/main.integration.test.ts` 1049 (rules-only skip withholds),
  1225 (all-clear withheld on unreadable verdict), 1294 (dry-run posts
  nothing), 779 (never reviews its own proposal PR); `review/threads.test.ts`
  (stdio ownership, create/update/fallback, anti-duplicate guard).

### C9 — remediation

- **Intent:** derive deterministic remediation proposals for the review
  envelope — proposal-only, never written to the repository.
- **Defaults:** `REMEDIATION_DEFAULTS=[]`, `REMEDIATION_CAPABILITIES=["propose"]`.
- **Over-grant:** a warrant granting `edit-file` or `open-pr` FAILS RED — the
  grant is refused loudly so a silent inert grant cannot read as authority
  (`remediation/main.ts:77-100`).
- **Failure:** proposal-only; any capability outside `propose` → red; missing
  envelope → green, “nothing to propose”.
- **Tests:** `remediation/main.integration.test.ts` 370 (over-grant fails red
  naming the capability), 390 (dry-run writes nothing), 358 (missing name →
  nothing).

---

## D — CONFIGURATION

### D1 — One canonical authority model; no legacy `apply` semantics

- **Intent:** capability grants flow only through `duties:` blocks (or the
  implicit warrant); the legacy `apply` key is refused by name.
- **Tests:** `warrant.test.ts` (apply refusal), `eval/contract/contract.test.ts`
  EXPECTED_GRANTS / true→default / list→exact / none-vs-false.

### D2 — Malformed configuration fails deterministically, before unsafe mutation

- **Intent:** unparseable YAML, a non-mapping file, an absent `version`, or an
  explicitly chosen missing path is a red run that spends nothing.
- **Tests:** `warrant.test.ts` 126-140 (absent version, non-mapping, unparseable
  YAML), Doctor red cases, triage integration 1200 (fails loudly before
  spending), 2506 (explicit missing path red).

### D3 — Unknown configuration handled intentionally — never silently widening

- **Intent:** unknown keys/values either warn, are refused, or are inert — they
  never expand scope. A capability string nothing implements is refused loudly.
- **Tests:** `triage/main.integration.test.ts` 1232 (fails loudly on a
  capability nothing can do), `review/main.integration.test.ts` 1484 (risk
  config cannot escalate capability), `remediation` over-grant red (C9).

### D4 — Configuration errors happen before mutation

- **Intent:** sweep+`number` refusal, bad confidence fraction, and taxonomy
  validation all fire before any effect call.
- **Tests:** `inputs.test.ts` 173 (sweep+number), `triage/main.integration.test.ts`
  1223/1286, and the `readShared` refusal in `core/inputs.ts`.

### D5 — Duty-specific defaults are documented, not invented per run

- **Intent:** each duty's default capabilities and default languages are
  constants in its `capabilities.ts` and the warrant resolution honours them
  only when the warrant is silent.
- **Tests:** capability constant tests per duty
  (`lifecycle/capabilities.test.ts`, `harmonise/capabilities.test.ts`,
  `remediation/capabilities.test.ts`); `triage/main.integration.test.ts` 1073
  (documented default used when warrant silent).

---

## E — FINDING LIFECYCLE (review)

- **E1 create/persist/change/reopen/resolve:** statuses are derived against the
  previous run's memory, keyed by intention (rule+file, never line) so a moved
  claim follows the diff; a line the patch no longer proves resolves; a
  reintroduced intention reopens.
  - Tests: `review/findings.test.ts` 95-244 (created/persists/changed/resolved/
    reopened; moved lines; ambiguous move → created-not-collapsed).
- **E2 deleted file / moved line / force push / amended commit:** a file that
  left the PR resolves its active findings; reviewed SHAs are appended capped
  at eight with the previously-reviewed SHA shown on the summary; a rerun on
  the same SHA posts nothing.
  - Tests: `review/findings.test.ts` (SHA cap 284-321), `review/main.integration.test.ts`
    559 (same review unchanged → posts nothing).
- **E3 human disposition distinct from model confidence:** dispositions ride a
  finding by intention key across line movement, force pushes and comment
  replacements (`review/main.ts:595-600`); a fresh disposition beats the
  mirror; the mirror survives only while its reply and login still stand
  (`review/disposition.ts:176-195`).
  - Tests: `review/findings.test.ts` 179/231/244 (disposition carried across
    move/reopen/resolve), thread/envelope tests in `review/publish.test.ts` and
    `review/threads.test.ts`.

---

## F — REVIEW SPECIFIC (event surface, dedup, contradiction, injection)

- **F1 draft/ready/synchronize/intent:** the review runs on ready-for-review
  and synchronize; a draft PR is skipped with a named reason
  (`review/main.ts:370`); a rerun on the same diff posts nothing.
  - Tests: `review/main.integration.test.ts` draft case, 559 unchanged-rerun.
- **F2 custom rules/packs/instructions/ignored paths:** rules + packs + custom
  instructions compose; `ignore.paths` may never act alone (allShownIgnored);
  a pack carrying `duties:` is refused; a referenced pack's blocked phrase can
  still produce deterministic findings.
  - Tests: `review/rules.test.ts`, `review/packs.test.ts` 970, integration
    915/951/991/1049.
- **F3 repository context and evidence verification:** context reads bounded and
  only inside the workspace, never reads a secret file, never emits the review
  fence itself, and drops context sections under cap without half-showing one.
  - Tests: `review/context.security.test.ts` (75-169), integration 1811-1867, 1839.
- **F4 deduplication/contradiction:** merged/corroborated same-position findings;
  two passes claiming different rules at one line are annotated, never silently
  resolved to the louder one.
  - Tests: `review/passes.test.ts` 176-267.
- **F5 inline thread lifecycle:** thread marker ownership (bot-authored, valid
  fingerprint, non-empty key), one thread per anchorable finding key, first at
  a position owns the thread, straddles page-2, 422 → fallback, dry-run
  rehearses.
  - Tests: `review/threads.test.ts` 220-527, integration 1553 (rerun does not
    stack a second thread).
- **F6 remediation proposal:** derived from the review envelope; carried to the
  remediation duty's own boundary; never written to the repository (C9).
- **F7 REVIEW MUST NOT GAIN AUTONOMOUS SOURCE MUTATION AUTHORITY:** the review
  duty's surface is comment-post + thread-sync; `Effects` is adds-only and the
  client is never handed out; no `edit-file`/`open-pr` path exists for review.
  - Tests: `forge.test.ts` (Effects adds-only), review integration comment-gate.

---

## G — UNTRUSTED INPUT

D8 applies to every boundary: input arrives from the internet addressed to a
process holding a write token, and containment is a property of the code path,
not a prompt instruction (`docs/doctrine/north-star.md#d8---every-thread-is-hostile`).

- **G1 thread text (title/body) → prompt:** fenced behind a per-call 64-bit
  nonce whose closing tag repeats the id; forged delimiters without the id can
  never close the real fence; text passes byte-for-byte; the rule text names
  this call's own boundary.
  - Tests: `core/enclose.test.ts` 14-55; `core/detect.test.ts` 322/341;
    `triage/main.integration.test.ts` 1109.
- **G2 comments / replies:** respond's forged-marker guard; review's forged
  thread-marker and forged disposition / envelope guards; duplicate's
  `duplicateOf` must be on the offered shortlist, whole-answer refusal.
  - Tests: `respond/main.integration.test.ts` 547; `review/threads.test.ts` 248;
    `review/publish.test.ts` 404; `duplicate/main.integration.test.ts` 713.
- **G3 source code / repository context:** review context refuses path
  traversal by segment, NUL, `.env`/credential denylist, source-extension
  exemption, and never surfaces a secret file; never emits the review fence
  itself.
  - Tests: `review/context.security.test.ts` 75-169.
- **G4 README, commit messages, branch names, filenames:** treated as hostile
  content, subject to the same fences and caps; nothing in them forms a
  capability grant.
  - Tests: capability non-derivation in `B1`/`B2`; context caps integration
    1811-1867.
- **G5 rules, packs:** strict top-level key whitelist for packs; a pack
  attempting `duties:` is refused red; unreadable rules/packs throw (fail red).
  - Tests: `review/packs.test.ts`, integration 951/970.
- **G6 model output as untrusted input:** every parse boundary refuses whole
  (strict JSON schema, finite confidence, offered-only candidates), because the
  shapes that fail to parse are the shapes an injection produces.
  - Tests: `triage/verdict.test.ts`, `duplicate/verdict.test.ts`,
    `respond/draft.test.ts`, `dependa/risk.test.ts` 292-316, `provider.test.ts`
    380-494.
- **G7 falsified trigger/author:** `sweep`+`number` refusal, a bot-authored
  thread not owed a reply, an untrusted reopener carrying no standing.
  - Tests: `inputs.test.ts` 173; `respond/main.integration.test.ts` 518;
    `triage/main.integration.test.ts` 2184.

---

## GAPS (missing required capability in code)

1. **[GAP] `screen-models` detect-roster fallback is implemented but has no
   integration-level assertion.** `triage/main.ts:911` falls back to
   `settings.models` when the cheap roster is empty, yet no suite pins that
   path (existing tests cover the non-empty cheap roster, `triage/.../1026`),
   and `docs/guides/cost.md:45-52` documents empty-as-default only for the
   spam screen, not for detection. → contract test below (F1/F2).
2. **[GAP] No unit pins the “all-protocol → red vs all-capacity → green”
   distinction at a duty boundary.** `provider.test.ts` and `summary.test.ts`
   pin the predicates; no test drives `failIfProtocolExhausted` from a real
   duty call. → contract test below.
3. **[GAP] Propose-marked PR recursion guard (`isReeveProposalPr`) has no
   lifecycle-main coverage** (triage/harmonise/respond/duplicate/review all
   gate it; lifecycle does not list it among its integration cases).
   → listed for adjudication; the guard exists at
   `lifecycle/main.ts:223-228` and is exercised only via `marker.test.ts`.
4. **[GAP] No test asserts `getSettings` returns `editor` for terminal
   sessions while handing a non-terminal run a non-editor fallback** — the
   `asEditor`/`session.interactive` pattern in `getSettings` is untested.
   → out of scope for contract tests (interactive-session only), flagged here
   for a downstream owner.

## IMPLEMENTATION-vs-DOC DISAGREEMENTS — for adjudication

1. **`respond` truncated-reply-list failure colour.** The code returns a green
   refusal note (`respond/main.ts`); the module doc once read as “better to
   fail a run than to draft on a guess”. A truncated thread is the one case
   where respond refuses under a _green_ run while the doc sentences read as
   expecting red. Neither side is blessed here.
   - **ADJUDICATED (2026-08-18): GREEN, code wins.** The truncated-thread
     refusal is a self-healing miss, not a misconfiguration: the next run over
     the same thread answers it once the whole reply list fits in one page.
     The module doc, `walkReplies`' doc comment and the inline comment now
     state the green posture; the run still returns exit 0 and writes the
     refusal `note`. No behavioural change.
2. **`harmonise` requires edit-file AND open-pr for state-branch writes; the
   doctrine sentence at `north-star.md:607-610` says both duties require the
   pair.** The doc matches for the branch; the default-branch merit write used
   `edit-file` alone (`harmonise/main.ts`) — that narrowing is not in the
   doctrine text and was recorded as the implementation's deliberate choice,
   to confirm.
   - **ADJUDICATED (2026-08-18): pair required on both paths.** The
     default-branch state write now also requires both `edit-file` AND
     `open-pr`, mirroring the state-branch sibling and the sync-PR gate; the
     notice names both capabilities. A warrant granting only `edit-file` no
     longer writes provenance state to the default branch.
3. **`lifecycle` resolves languages leniently (`[]`→English) while every other
   duty's warrant resolution refuses an unconfigured list.** The divergence is
   declared in code (`lifecycle/main.ts:126-137`); the doctrine does not state
   it. Confirm it is intended product behaviour.
   - **ADJUDICATED (2026-08-18): confirmed intended.** A repository whose
     tracks all use built-in English text or an explicit `say:` map never had
     a reason to configure `languages:`; `[]` reads as English throughout
     `message.ts`. No code change.
4. **`dry-run` placement differs per duty.** Triage dry-runs at the call-site
   boundary AND inside `act`; translate dry-runs AFTER drafting and BEFORE the
   `edit-body` gate (`text.ts:196-218`), and review dry-runs after the
   comment/floor gates. The variable is the duty's semantics (what “would have
   happened” means), not a mistake.
   - **ADJUDICATED (2026-08-18): confirmed intended.** Each placement reflects
     its duty's own answer to “what would have happened”. No code change.
5. **`spam` fails open; `screen` fails closed.** The cheap spam screen's
   all-models-failed posture is carry-on (`spam.ts:67-78`); the length/evidence
   screen is deterministic and fails closed. This asymmetry is intended and is
   asserted by `spam.test.ts` 67 — recorded so a reader does not “fix” it.
   - **ADJUDICATED (2026-08-18): confirmed intended.** Carry-on into the
     expensive stage beats skipping a thread on a cheap model's verdict; the
     deterministic screen must not let a hostile thread through on a read
     error. No code change.
6. **Disposition case-insensitivity change landing separately (TL2).** The
   parse grammar is already case-insensitive via the `/i` flag
   (`review/disposition.ts:41-44`); TL2's change normalizes the value through
   `.toLowerCase()` before it is matched to the union. That normalization is a
   hardening of the same behaviour (a value can only be read as one of the
   four unions under `/i` anyway) — the matrix records it as a compatible
   refinement, to confirm no behavioural cliff.
   - **ADJUDICATED (2026-08-18): confirmed intended.** Compatible hardening;
     the `/i` flag already admitted every casing, so the normalization changes
     no accepted value. No code change.

## Intent categories covered by existing tests (cited above)

Every `Tests:` entry above is existing executable evidence. No test in this
matrix is proposed for duplication; the contract tests added in this change
close only the three GAP rows above.
