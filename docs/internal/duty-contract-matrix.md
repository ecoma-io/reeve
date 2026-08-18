# Duty contract matrix

Internal engineering document, and a companion to
[`intent-matrix.md`](./intent-matrix.md) rather than a replacement for it. The
intent matrix states what each duty promises; this states **where that promise
is executable**. Every cell is either a `file:line` that would go red if the
behaviour changed, or a `GAP` with a priority.

A cell is not filled by "there is a test that touches this code". It is filled
by a test whose assertion fails when the behaviour is wrong — the standard the
whole round is held to. Where a cell cites a test that runs but could not fail
on a real regression, it is marked `GAP` regardless of the coverage number.

**Duties intentionally differ.** Where a duty's answer is deliberately unlike
its siblings', the difference is stated with the code or doc that declares it,
and the difference itself is asserted. Do not read a divergent row as a defect
to be tidied: `spam` fails open where the deterministic screen fails closed,
`lifecycle` resolves `languages: []` as English, dry-run sits at a different
point in each duty. All three are adjudicated intent, not drift.

Line numbers are as of the `round1/tl2` branch.

---

## Legend

| Mark     | Meaning                                                                |
| -------- | ---------------------------------------------------------------------- |
| `file:N` | Pinned. A regression in this cell turns that test red.                 |
| `GAP P0` | Unpinned, and a wrong answer here changes somebody's repository.       |
| `GAP P1` | Unpinned, and a wrong answer here costs a run or a maintainer's trust. |
| `GAP P2` | Unpinned, low blast radius.                                            |
| `GAP P3` | Unpinned, cosmetic or diagnostic only.                                 |
| `n/a`    | The duty does not have this axis. The reason is given in its notes.    |

Short names: `PC` = `src/core/provider.contract.test.ts`,
`II` = that duty's `main.integration.test.ts`.

---

## A — Model selection, fallback and failure semantics

Every model-consuming duty is held to the same six-part matrix, asserted by
**which models were asked, in order** — never by reading a settings object
back. The shared core contract lives in `PC` and is not repeated per duty;
what each duty row pins is that ITS OWN stage is wired to it.

| Duty        | Rotates whole roster                    | A→B fallback | All exhausted | Never re-asks a grounded model | Auth ends the run red | Malformed output refused               |
| ----------- | --------------------------------------- | ------------ | ------------- | ------------------------------ | --------------------- | -------------------------------------- |
| triage      | `triage/verdict.contract.test.ts:82`    | `:92`        | `:112`        | `:137`                         | `:182`                | `:197`                                 |
| translate   | `translate/draft.contract.test.ts:90`   | `:99`        | `:118`        | `:150`                         | `:184`                | `:199`                                 |
| duplicate   | `duplicate/verdict.contract.test.ts:69` | `:79`        | `:101`        | `:126`                         | `:151`                | `:165`                                 |
| respond     | `respond/draft.contract.test.ts:83`     | `:92`        | `:111`        | `:141`                         | `:170`                | `:184`                                 |
| harmonise   | `harmonise/draft.contract.test.ts:98`   | `:106`       | `:123`        | `:144`                         | `:177`                | `harmonise/draft.contract.test.ts:194` |
| lifecycle   | `n/a` — asks no model at all            | `n/a`        | `n/a`         | `n/a`                          | `n/a`                 | `n/a`                                  |
| dependa     | `GAP P1`                                | `GAP P1`     | `GAP P1`      | `GAP P1`                       | `GAP P1`              | `dependa/risk.test.ts:292`             |
| remediation | `n/a` — derives deterministically       | `n/a`        | `n/a`         | `n/a`                          | `n/a`                 | `remediation/envelope.test.ts`         |

**Core rows, shared by all of the above.** The stack itself — real
`createProvider` over a stubbed `fetch`, through `readCompletion`,
`classifyStatus`, `reckon` and `rotateModels`:

| Contract                                                       | Pinned at          |
| -------------------------------------------------------------- | ------------------ |
| First model succeeds → later models never asked                | `PC:103`           |
| A fails → B answers                                            | `PC:112`           |
| A and B fail → C answers                                       | `PC:122`           |
| Whole roster fails                                             | `PC:131`           |
| No model skipped between first and answering                   | `PC:141`           |
| Empty roster asks nothing, and is NOT "starved"                | `PC:148`, `PC:157` |
| A failed model is never re-asked, in one rotation or across    | `PC:174`, `PC:184` |
| A grounded model mid-roster is skipped without stopping        | `PC:200`           |
| 429 / 500 / 502 / 503 / 504 rotate and ground                  | `PC:220`           |
| Whole-roster capacity → starved, green, NOT protocol-exhausted | `PC:245`           |
| Network error grounds the whole endpoint                       | `PC:263`           |
| Timeout grounds only the model that hit it                     | `PC:288`           |
| 401 / 403 throw on the first model, asking no other            | `PC:325`           |
| Eleven malformed body shapes rotate rather than being accepted | `PC:382`           |
| Malformed is `protocol`, never grounded in Weather             | `PC:395`           |
| Whole roster malformed → protocol exhaustion, NOT starvation   | `PC:406`           |
| A 200 carrying both an error and a choice is refused whole     | `PC:441`           |
| An empty `error: {}` beside a good answer is not a failure     | `PC:462`           |
| Rotation across endpoints, with `@alias` stripped              | `PC:517`           |

Judge panels keep a second, deliberate implementation of the same rules
(`core/judge.ts` says why), so they are pinned separately in
`src/core/judge.contract.test.ts`: the `|` chain walks to its third link
(`:113`), a grounded link mid-chain is skipped without ending the seat
(`:152`), an auth failure from a seat ends the run red (`:208`), and one model
never votes twice across seats (`:250`).

The cheap rosters are pinned at `src/core/spam.contract.test.ts` and
`src/core/detect.contract.test.ts` — including the documented fallback where an
empty `screen-models` turns screening off (`spam.contract.test.ts:82`) and the
triage pivot's own copy of that rule (`triage/record.test.ts:1157`).

---

## B — Input validation, authority and GitHub interaction

| Duty        | Input validation                   | Authority / capability gate                                       | GitHub interaction                             |
| ----------- | ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| triage      | `triage/inputs.test.ts`            | `II:764` (never applies an unnamed label)                         | `II` sweep, ~90 cases                          |
| translate   | `translate/inputs.test.ts`         | `II:1556` (`edit-body` withheld)                                  | `translate/publish.test.ts`                    |
| duplicate   | `duplicate/corpus.test.ts`         | `II:478`–`731`                                                    | `duplicate/publish.test.ts`                    |
| respond     | `respond/guidance.test.ts`         | `II:501`/`518`/`529`/`547`                                        | `respond/publish.test.ts`                      |
| harmonise   | `harmonise/inputs.test.ts`         | `harmonise/capabilities.test.ts`                                  | `harmonise/publish.contract.test.ts:186`       |
| lifecycle   | `lifecycle/clock.test.ts`          | `II:512`–`764`                                                    | `II`                                           |
| dependa     | `dependa/inputs.test.ts`           | `dependa/authority.contract.test.ts`                              | `dependa/publish.test.ts:786`                  |
| remediation | `remediation/capabilities.test.ts` | `remediation/main.integration.test.ts:370` (over-grant fails red) | `remediation/envelope.adversarial.test.ts:112` |

`remediation/envelope.adversarial.test.ts` is the trust boundary row: the
envelope remediation derives from rides in a comment on a public thread, and
the two guards that keep a human from planting one (`isBotAuthor`, and the
marker splitting with an empty author half) had never been driven. `:112`
supplies a byte-identical envelope from a human author and asserts it is
refused for who wrote it.

---

## C — Dry-run, idempotency, retry and state

**Dry-run placement differs per duty by design** — adjudicated 2026-08-18,
intent matrix disagreement 4. Each duty's placement answers its own version of
"what would have happened": triage dry-runs at the call-site boundary AND
inside `act`; translate dry-runs AFTER drafting and BEFORE the `edit-body`
gate, because a withheld capability is a reason not to write rather than a
reason not to have decided; review dry-runs after the comment and floor gates.

| Duty        | Dry-run writes nothing                         | Idempotency marker                                                   | Retry / conflict                                            | State transitions              |
| ----------- | ---------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| triage      | `II:1182`, `II:2046`                           | `markerFor("triage")`, `triage/outcome.test.ts:49`                   | `n/a`                                                       | `triage/store.test.ts`         |
| translate   | `II:906`, `II:1152`                            | `fingerprint`, `translate/text.test.ts`                              | `n/a`                                                       | `translate/publish.test.ts`    |
| duplicate   | `II:664`                                       | `postOrReplace`/`rehearse`, `duplicate/publish.test.ts`              | `n/a`                                                       | `n/a`                          |
| respond     | `II:727`                                       | `isFingerprint`, `II:547`                                            | `n/a`                                                       | `n/a`                          |
| harmonise   | `harmonise/publish.contract.test.ts:147`       | `harmonise/publish.contract.test.ts:281` (updates, never duplicates) | `GAP P2`                                                    | `harmonise/provenance.test.ts` |
| lifecycle   | `II:545`                                       | `MARKER` + `fingerprintFor`, `lifecycle/summary.test.ts`             | `n/a`                                                       | `lifecycle/timeline.test.ts`   |
| dependa     | `GAP P1` — `publish.ts:202` gate is not driven | `dependa/publish.test.ts:812` (unchanged PR left alone)              | `dependa/publish.test.ts:900` (409 re-read and retry, once) | `dependa/publish.test.ts:826`  |
| remediation | `remediation/main.integration.test.ts:390`     | `n/a` — proposal only                                                | `n/a`                                                       | `n/a`                          |

`harmonise`'s dry-run row was the loudest gap in this table before this round:
`publish.ts:139` was the only duty's dry-run gate with no case anywhere
asserting it writes nothing, while all eight siblings had one. It is now
pinned on the recording — no branch created, no file committed, no pull
request opened or updated — rather than on the flag.

---

## D — Multilingual behaviour

| Duty        | Language resolution                                                         | Pinned at                                                                                                      |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| triage      | Detect, then tell the model what it is reading                              | `triage/verdict.test.ts:256`, `detect.contract.test.ts`                                                        |
| translate   | Source and target both named to the model                                   | `translate/draft.test.ts:100`                                                                                  |
| duplicate   | Language carried into the prompt                                            | `duplicate/verdict.test.ts`                                                                                    |
| respond     | Answer in the thread's language                                             | `respond/draft.test.ts:245`                                                                                    |
| harmonise   | Source language null → `core.setFailed`, a config error not weather         | `harmonise/main.test.ts`                                                                                       |
| lifecycle   | **`languages: []` resolves LENIENTLY to English** — unlike every other duty | `lifecycle/message.test.ts`; declared at `lifecycle/main.ts:126-137`, adjudicated intent matrix disagreement 3 |
| dependa     | `n/a` — no natural-language output                                          | —                                                                                                              |
| remediation | `n/a` — proposal payload only                                               | —                                                                                                              |

---

## Deliberate asymmetries, and where each is asserted

Every row here is intent, confirmed in `intent-matrix.md`'s adjudication
section on 2026-08-18. A future change that "fixes" one of these is a
regression, and the cited test is what says so.

1. **`spam` fails OPEN; the deterministic screen fails CLOSED.** A cheap
   roster that could not answer carries the thread on to the expensive stage;
   the length/evidence screen refuses on a read error. Dropping a real report
   costs a contributor their answer, while carrying one on costs a request.
   Asserted: `core/spam.contract.test.ts:135`.
2. **`lifecycle` resolves `languages: []` as English.** A repository whose
   tracks use built-in English text never had a reason to configure the key.
   Asserted: `lifecycle/message.test.ts`.
3. **Dry-run placement differs per duty.** See section C.
4. **`remediation` fails RED on an over-grant.** A warrant granting
   `edit-file` or `open-pr` to a proposal-only duty is refused loudly, so a
   silently inert grant cannot read as authority.
   Asserted: `remediation/main.integration.test.ts:370`.
5. **Protocol failures are NOT weather.** A malformed answer to one prompt says
   nothing about the same model on a different one, so it keeps its place in
   the rotation while a 429 does not. Asserted: `PC:395`.
6. **`judge` keeps its own rotation loop rather than calling `rotateModels`.**
   A seat stops on a usable _vote_, which is a stricter stop than a usable
   _completion_. The duplication is deliberate and is why the panel needs its
   own copy of every D12 rule. Asserted: `core/judge.contract.test.ts`.

---

## GAPS, by priority

### P0 — none outstanding in this area

The three P0 rows this round opened are closed: harmonise's dry-run
(`harmonise/publish.contract.test.ts:147`), the remediation envelope trust
boundary (`remediation/envelope.adversarial.test.ts:112`), and the run-wide
`Weather` threading at all nine model-consumption sites.

### P1

1. **dependa's model roster has no contract test.** The risk-interpretation
   rotation lives at `dependa/main.ts:381`, inside the entry point, and dependa
   has no `main.integration.test.ts` at all — so the six columns of section A
   are unpinned for this duty. Every other model-consuming duty's rotation was
   extractable to a stage function; dependa's is not. Closing this needs either
   a bundle-driving integration test (the pattern `triage` uses) or a minimal
   seam extraction of the risk stage.
2. **dependa's dry-run gate (`publish.ts:202`) is not driven.** Every sibling
   has a case; this one is reachable and simply unasserted.
3. **`harmonise/main.ts` has no behavioural evidence at all.** Its
   `main.integration.test.ts` imports nothing from `src/` and spawns no bundle
   — it is a static `action.yml` conformance check — and `main.test.ts` tests
   `classify.ts`, not `main.ts`. That is 896 lines of orchestration with no
   test that runs it. Note that closing this earns NO coverage points
   (`main.ts` is coverage-excluded by design); it is a proof gap, not a
   percentage gap, and should not be deprioritised for that reason.
4. **`dependa/main.ts:383` delivers the `enclose()` injection-fence rule in a
   `user` message** while all eight other model-facing sites deliver it as
   `role: "system"`. Untested either way, and NOT changed here — the divergence
   is reported for a ruling rather than resolved by a test author's judgement.

### P2

5. **`dependa/managers/npm.ts` pnpm peer-suffix defect**, pinned to current
   behaviour with an `// ADJUDICATE:` block at
   `dependa/managers/npm.test.ts:820`. A pnpm 6+ entry
   `/lodash@4.17.21(react@18.0.0):` splits on the last `@`, so `currentVersion`
   resolves EMPTY for every peer-resolved dependency. The code's own comment
   says it means to strip the parenthetical, so the intent is declared and
   unmet. One-line fix named in the test; not applied, because the downstream
   treatment of an empty `currentVersion` is another owner's contract.
6. **`npm` datasource accepts a `versions` ARRAY**, fabricating a release named
   after the array index and reporting `available`. Pinned to current behaviour
   with an `// ADJUDICATE:` block at
   `dependa/datasources/npm.test.ts:333`. No real registry sends this shape and
   a `"0"` target does not survive semver comparison, so the blast radius is
   small — but the module's own doc says malformed documents degrade to
   `malformed-metadata`.
7. **`docker-registry`'s `isSafeRegistry` has a `localhost` arm that a bare
   `localhost/x` cannot reach**, because `parseImageName:366` classifies a
   first path component as a registry only when it contains a `.` or a `:`.
   Not an SSRF — the request goes to Docker Hub, not to the loopback interface,
   and `localhost:5000/x` IS refused — so current behaviour is pinned at
   `dependa/datasources/docker-registry.test.ts:264` with an `// ADJUDICATE:`
   note rather than changed.

### P3

8. `dependa/capabilities.ts` is 0% covered. It is a constant table; a test
   would assert the constants against themselves. **EXCLUSION-CANDIDATE** —
   reported rather than excluded here, for root to adjudicate.
