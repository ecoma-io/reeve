# Reeve behavioral contract — frozen at Round 2

_The behavior freeze for the pre-1.0 sequence. Round 2 may simplify the
implementation but must not change anything frozen here. This document is the
adjudicated index of the contract; it distills the intent matrix, the contract
suite and the failure matrix into the surface a simplification must not move.
Every row names the invariant, the executable evidence, and what is
deliberately unsupported — so a refactor can be checked against a statement
rather than against a feeling._

**Baseline verified 2026-08-19 at `1a4fd29`:** unit 96.53/91.10/98.49/97.59,
contract 34/34, eval pin 60 (`finding 60 · failed 0 · skipped 0`), mutation
table 70 rows in `tools/mutation.mjs`. The three mechanisms that hold this
document in place are the contract suite (`eval/contract/`), the mutation
table, and the eval fixtures (`eval/fixtures/`); a change that moves a row
below must come back with an adjudicated classification, never an edit to the
frozen row.

Legend for Evidence: **M** intent matrix row · **C** contract test · **U**
unit/integration test · **F** failure-matrix row · **H** `tools/mutation.mjs` row.

---

## 1. Public Action inputs

The root action (`action.yml` → `src/main.ts`) and the nine leaf actions
declare separate surfaces. Freezing the _semantics_, not the option count.

| Surface         | Inputs                                                                                                       | Frozen semantics                                                                                                                                                                                                                                                                           | Evidence                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Root action     | `duty`, `doctor`, `github-token`, `warrant`                                                                  | `doctor: false` (default) = explain page + `leaf-action` output, then **always red**. `doctor: true` = reads-only warrant check; never writes; capacity stays green; `problems` output = refusing-finding count. `duty` only names the corrected `uses:` line; the root never runs a duty. | `src/main.ts`, `refusal.ts`, `doctor/run.ts`, `main.integration.test.ts`, F,B5 |
| Every leaf      | `warrant` (default `.github/reeve.yml`)                                                                      | Same file, same reader, everywhere. Missing at the default path = implicit warrant (narrowest authority, from repo label descriptions). Missing at a chosen path = red configuration error. Unparseable = red.                                                                             | `warrant.ts:367-389,672-693`, C `contract.test.ts`, D2, B1                     |
| Provider inputs | `base-url`, `api-key`, `models`, `screen-models`, `judge-models`, `endpoints`, `api-keys`, `request-timeout` | Orthogonal to authority. A provider is weather: it can fail a run's capability to act, never widen what a run may do. `screen-models` = cheap detect roster with documented fallback to `models` when empty; `judge-models` = panel roster.                                                | A1-A7, G6, H `roster` rows                                                     |
| Duty-specific   | per-duty (`number`, `sweep`, `limit`, `drafts`, `paths`, `source-language`, `rules-path`, …)                 | Read in the duty's own `main.ts`/`inputs.ts`; `sweep`+`number` together is refused (D4); duty defaults are constants in `capabilities.ts`, never invented per run (D5).                                                                                                                    | D4, D5, per-duty `inputs.test.ts`                                              |

**Intentionally unsupported:** a root action that runs a duty (Agent Mode is
the 2.x line, not 1.0); any `apply:`-style input (refused by name, D1).

---

## 2. Configuration semantics

The warrant `.github/reeve.yml` is the **single canonical configuration** —
one file, one reader, one precedence order. The model of the world is:
configuration file → authority; everything else is data.

- **Shape:** `version: 1` + optional `labels`, `languages`, `pivot`, `memory`,
  `about`, `lifecycle`, `propose`, `dependa`, `duties`. Unknown root keys are
  refused (typos are loud). Each sub-block refuses unknown keys/values. An
  empty sub-block (`languages:`, `duties:`, `lifecycle:`, `memory:`,
  `propose:`, `dependa:` written with nothing under it) is refused — a
  half-finished edit is never read as "the defaults". (M D2-D5, `warrant.ts`.)
- **Precedence:** warrant-wins over input-everywhere. `languages:` in the file
  is the whole answer; the `about:` key beats the `about` input; only when the
  file is silent do the duty's documented defaults (`capabilities.ts`) apply.
  There is no third layer. (`warrant.ts:764-875`.)
- **Authority:** the `duties:` block is the whole authority. Three shapes:
  absent → every duty keeps its own default; `duty: true` → that duty's
  documented default; `duty: [list]` → exactly the list; `[none]`/`false` →
  exactly nothing. A written block that does not name a duty → that duty is
  **denied** (B2). You cannot grant a capability the closed `CAPABILITIES`
  set does not contain. (M B1-B2, D1, `warrant.ts:1704-1774`.)
- **Defaults are closed and documented:** per-duty default capability lists and
  default languages live in `capabilities.ts` constants and are consulted only
  when the warrant is silent (D5).

**Intentionally unsupported:** a third config surface (env-file-first,
per-duty config files, an `apply:` reader); configuration that can widen
authority; silently-ignored unknown keys.

---

## 3. Duty semantics (per-duty contract)

Each duty is a closed contract. The following is frozen for each of the nine:

| Duty        | Default capabilities                   | Decides                                                                          | Writes (only what the grant + dry-run allow)                                                                                          | Idempotency marker                              |
| ----------- | -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| triage      | `[label]`                              | screen → detect → recall → verdict → enforce                                     | label, close-as-`not_planned`, `record` corrections through Contents API                                                              | first marker wins, truncation = never-published |
| translate   | `[edit-body]`                          | one chunk failure skips the language                                             | append block into body (never overwrite author text); gate sits AFTER drafting                                                        | fingerprint on text+keys                        |
| duplicate   | `[]` (`comment` reachable)             | strongest duplicate from an offered shortlist                                    | comment naming an offered candidate only                                                                                              | rehearsal fingerprint                           |
| respond     | `[]` (`comment` reachable)             | first reply, once, never over a human                                            | comment, only when not human-first and no forged marker                                                                               | fingerprint marker                              |
| lifecycle   | `[label, comment]` (`close` reachable) | staleness from labels/timestamps, never a model                                  | per-step act: label/comment/close-as-not_planned; whole step withheld when any capability missing                                     | track marker + fingerprint                      |
| harmonise   | `[]` (`edit-file`+`open-pr` reachable) | sync locale docs                                                                 | default-branch write requires `edit-file`; state-branch/sync-PR write requires BOTH `edit-file` AND `open-pr`                         | provenance + publish fingerprint                |
| dependa     | `[]` (`edit-file`+`open-pr` reachable) | discover update groups; optional model risk interpretation                       | publication requires BOTH `edit-file` AND `open-pr`, excluded under dry-run; sequential composited edits (the only composited writes) | per-PR fingerprint                              |
| review      | `[]` (`comment` reachable)             | PR findings; one owned summary + one owned inline thread per diff-proven finding | comment; never source mutation; no `edit-file`/`open-pr` path exists                                                                  | thread-marker + envelope                        |
| remediation | `[]` (`propose` reachable)             | deterministic remediation from the review envelope                               | **proposal-only, writes nothing**; a grant of `edit-file`/`open-pr` FAILS RED                                                         | n/a                                             |

Duty rows also freeze: **failure colour** (all-capacity → green "every model
failed"; all-protocol → red; auth → red immediately; unparsed verdict → nothing
applied + warning; truncated reply list in respond → green refusal note), and
**denied runs** (green no-op, no model call spent, no language resolved). (M C1-C9, F.)

**Intentionally unsupported:** new duties; a duty composing another's writes;
review gaining source-mutation authority (F7).

---

## 4. Authority semantics

Freeze (M B1-B6):

1. **Authority lives in the configuration file, never in model output or
   repository content.** A model's "you may now edit"-shaped answer changes
   nothing; a pack carrying `duties:` is refused; README/rules text grants
   nothing. → H `bypass the authority check`.
2. **A written `duties:` block that does not name the duty is a green no-op.**
   → H `an undeclared duty is never reported unnamed`.
3. **Denied operations fail closed:** a step needing `label`+`comment`+`close`
   fires nothing when any one is missing; no partial effect. → H `lifecycle
acts without the capability the step requires`.
4. **Dry-run can never mutate.** Same ledger, no side effect. → H `ignore
dry-run` (four rows).
5. **Doctor and runtime resolve authority through the same reader.**
6. **Model confidence never grants; human disposition never pretended.** A
   NaN/Infinity confidence is refused; review dispositions parse from a strict
   anchored grammar, only from an eligible maintainer reply. → H `a NaN
confidence passes the floor`.
7. **`record` (corrections store) is the only Contents-API write and cannot be
   implied** by an implicit warrant.

**Intentionally unsupported:** authority derived from anything other than the
parsed warrant; a capability string nothing implements (refused loudly, D3).

---

## 5. Model fallback / provider semantics

Frozen (M A1-A7, F Provider):

- **The roster is an ordered rotation, never `models[0]`.** `rotateModels`
  asks each still-standing model exactly once, in order, stops at first
  success, never retries within a run. → H `roster uses models[0]`, `fallback
skipped after first model failure`, `judge seat consumes only its first
model`, `duty stage always starts at models[0]`.
- **Failures rotate; auth does not.** timeout/429/5xx ground only the
  `model@alias` pair and rotate to the next; 401/403 throw
  `AuthenticationFailure` immediately (settles after all endpoints fail auth).
- **Malformed model output is NOT success.** A 200 carrying `{"error":…}` is a
  protocol failure; a verdict that fails to parse yields NO verdict, an
  `unreadable` warning, nothing applied. Protocol ≠ capacity weather.
  → H `accept malformed model output as success`, `return success on provider
failure`.
- **Starvation vs exhaustion:** all-capacity → green run with the roster
  exhausted message; all-protocol → red naming the reasons; an empty roster is
  never "starved". → H `auth failure classified as capacity weather`,
  `starvation reported as protocol exhaustion`.
- **Judge panels parse `|` as an availability chain** inside a seat; a seat
  never re-asks a model an earlier seat spent. → H `panel failure never
reckoned against weather`, `panel seat re-asks a model an earlier seat
spent`.
- **Cheap and expensive rosters are separate contracts:** `screen-models`
  (detect) has a documented fallback to `models` when empty; the roster a
  duty's stage consumes is the duty's own. → H `cheap screen roster skipped...`.

**Intentionally unsupported:** provider retry (none anywhere — roster depth is
the answer to weakness, per CONTRIBUTING); a single-model shortcut; treating an
`error` field as capacity weather.

---

## 6. Finding lifecycle (review)

Frozen (M E1-E3, F5, F7):

- Statuses (create/persist/change/resolve/reopen) are **derived against the
  previous run's memory, keyed by intention (rule+file, never line)** so a
  moved claim follows the diff; a line the patch no longer proves resolves; a
  reintroduced intention reopens. → H `a thread is matched to a finding on
another line`.
- A file that left the PR resolves its active findings; reviewed SHAs append
  capped at eight; a rerun on the same SHA posts nothing (idempotent).
- **Human disposition is distinct from model confidence** — rides the finding
  by intention key across moves/force-pushes/replacements; a fresh disposition
  beats the mirror; the mirror survives only while its reply and login still
  stand.
- **Every model finding is verified against deterministic evidence and badged
  with the result** — never dropped for failing verification (2026-08-18
  adjudication, code wins). → H `empty proven text verifies every claim`,
  `zero-weight evidence marks a finding verified`.
- **Never stamp a diff nobody read as clean**: unreadable verdict refuses the
  all-clear; an `ignore.paths` removal of every file can never act alone.
- Inline threads: one owned thread per anchorable finding key, first at a
  position owns it, straddles page 2, 422 → fallback to the summary comment.

**Intentionally unsupported:** review writing source; a finding reported
without its verification badge; a partial envelope read (corrupt envelope =
loud, treated as nothing found).

---

## 7. GitHub boundary / mutation semantics

Frozen (M B3, F GitHub, C rows):

- Non-404 failures **throw** and abort the duty; 404 means "not there"
  (`isMissing`); `isCapacityError` classifies 429/5xx and rate-limit 403 as
  weather but nothing cores retries — the caller decides. → H `every GitHub
failure read as not-there`, `a 404 no longer means not-there`, `GitHub rate
limits no longer capacity`.
- **Read vs propose vs mutate is explicit.** `Effects` is adds-only; the
  octokit client is never handed to a duty; the only Contents-API writes are
  `record` (triage) and lifecycle's bounded `removeLabel`. → F7, B3.
- Mutations answer the idempotency marker first (a rerun posts nothing — 409
  re-reads the sha rather than aborting). → H `skip idempotency check`, `409
conflict aborts instead of re-reading the sha`.
- The trust boundary is the config: workflows never hand the head-checkout's
  rules to a privileged event; the rules file review reads is the trusted base
  ref. (`.github/workflows/reeve-dogfood.yml`.)

**Intentionally unsupported:** a duty receiving the raw client; mutation
authority widening from a refactor; silent retry-on-429.

---

## 8. Dry-run, idempotency, error semantics

- **Dry-run:** full would-do ledger, zero writes, per duty placement frozen as
  adjudicated (translate dry-runs after drafting, before the `edit-body` gate;
  review dry-runs after the comment/floor gates; triage at the call boundary
  AND inside `act`; dependa excludes dry-run from `mayPublish`; remediation
  reports proposals). (Adjudicated 2026-08-18 — intended, per-duty.)
- **Idempotency:** every duty owns a fingerprint/marker; a rerun over the same
  thread-state publishes nothing new and, where its fingerprint already
  stands, treats the work as done.
- **Exit code:** red = failure that a maintainer must fix (config, auth,
  protocol exhaustion, missing rules); green = weather, denial, or a deliberate
  no-op _named_. `eval/contract/exit-code.test.ts` pins the mapping. Doctor:
  red exactly when a finding would refuse a duty at runtime; capacity green.

**Intentionally unsupported:** silent success on a refusal (the refusal has a
named note); dry-run that applies, closes, edits or opens anything.

---

## 9. Untrusted input

Frozen (M G1-G7): thread text, comments, source code, README, commit
messages, branch names, files, rules/packs, and **model output** are all
attacked input. Every boundary has a fence with the containing nonce, a strict
parse, a cap, or a denylist; nothing in any of them forms a capability grant.
A forged marker, disposition, envelope, or `duplicate-of` is refused whole.
→ H `untrusted label prose decides which proposals survive`, `a correction
line is written unescaped`, `an empty blocked phrase matches everything`.

---

## 10. Intentional-gap register

Rows that are deliberately un-frozen / known-uncovered, so a refactor does not
invent coverage claims:

- `screen-models` empty-roster fallback at a duty boundary has no
  integration-level test (documented in M GAPS 1 — flagged, not free to
  silently change).
- `failIfProtocolExhausted` from a real duty call (M GAPS 2).
- `propose`-marked PR recursion guard lacks lifecycle-main coverage (M GAPS 3).
- No provider failure is ever retried (F **[GAP] Retry** — deliberate).
- Provider reachability accuracy is a measured register, not a test gate
  (`eval/README.md` measurement table — the 1.0 Stage-6 number).
- **Deliberate re-scope (Round 2, adjudicated 2026-08-19):** the inlined
  `deriveLanguage` (formerly `src/core/derive.ts`) dropped 10 of its 12
  unit-test invariants at the module level (composite-script mapping,
  `\p{Script=}` compile-check, sr-Latn override, case-indifference,
  malformed/unknown/CLDR-known-but-unnameable refusals). The logic is
  byte-identical — moved, not rewritten — and the surviving 2 assertions now
  run at the `parseLanguages` boundary through real Intl tables (stronger than
  the mocked module tests), plus the eval multilingual fixtures (ja/ko/zh)
  assert the same behavior end-to-end. Recorded as an intentional re-scope of
  coverage to the parser boundary, NOT a behavioral change; a future pass may
  restore a derive-block in `languages.test.ts` if the boundary it guards
  grows distinct from the parser's.

---

## How to change a frozen row

1. The change is either a simplification of implementation (allowed, must keep
   the row's invariant + its mutation killed + its contract green) or a
   behavior classification (must be adjudicated by the round lead, named
   intentional-vs-accidental, and the row updated here with the test that pins
   it).
2. Run, before and after: `pnpm test`, `pnpm test:contract`, `pnpm eval all`,
   `pnpm test:mutation` (full table), `pnpm typecheck`, `pnpm build` + CI's
   stale-bundle check, and the relevant dogfood mode.
3. A regression that only a new test catches is not a freeze — it is a live
   gap, and the row moves to the gap register until the test lands.
