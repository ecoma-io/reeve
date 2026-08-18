# The authority boundary matrix

_Internal. Round 1 hardening evidence for the authority, configuration and
state boundaries. Every cell names the file and line of the test that proves
the claim. A claim with no test is a `GAP` with a priority, not an omission._

This is the executable half of
[the authority model](../concepts/authority-model.md) and of
[the threat model](../security/threat-model.md). Where those pages state what
must be true, this one says where that statement is checked and what would
have to break for the check to notice.

## What the tests assume

**Total model compromise.** Every escalation row below assumes the injection
worked perfectly at the layer it was aimed at — the model read the sentence and
did exactly what it said — and then asserts the answer still changes nothing. A
suite that assumed the model resisted would be measuring the model, which is
the part this repository does not control.

**Ten of the twelve channels are only ever a string; two are not.** The row-G
channels are listed by name because the intent matrix lists them, but at the
boundary under test ten of them have no shape of their own — a stranger's text
is a stranger's text, and there is one reader for all of it. Those ten share one
test per claim, and §1 says so rather than printing ten rows that cannot fail
independently. `rule-file` and `rule-pack` DO have readers of their own and get
real tests against them.

**PARSE evidence and CONSUMPTION evidence are different things, and this page
now says which it has.** A parse-boundary test asserts what `parseWarrant` or
`implicitWarrant` RETURNS. A consumption-site test asserts what the function
that later READS that field DOES. They are not substitutes: a security auditor
broke this boundary three times without failing a single parse-boundary
assertion, by moving one function downstream each time. Rows in §1 and §2 are
now marked **P** (parse), **C** (consumption) or **P+C**, and §2b lists every
consumption site in this area with its status.

**Negative controls, not coincidences.** Every invariant below was verified by
temporarily breaking the production check it depends on and confirming the test
goes red — 36 of them, listed in §6. Three of those mutations survived on first
attempt and the tests were fixed until they did not; that is recorded there
rather than quietly dropped, because a control that never failed is a control
nobody has calibrated.

**This page has been through two independent adversarial reviews.** The first
broke the boundary once, at parse time; the second broke it three more times,
all downstream of the parse boundary, all with the full suite green. Both sets
of corrections are marked in place. Where a draft claimed more than it proved,
the claim was narrowed rather than the evidence stretched.

> The second auditor's one-line diagnosis, worth keeping: _"every proof in this
> round is anchored at a PARSE boundary, and every hole I found is one function
> DOWNSTREAM of it."_ That is a checklist item for Round 2, not a story about
> this round.

---

## 1. Untrusted channel × escalation attempt

**Read this before the table.** The first draft of this page printed twelve
channel rows × four columns and presented forty-eight cells as forty-eight
pieces of evidence. It was not. Ten of the twelve channels share one reader,
the tests behind them did not vary by channel, and three of the four columns
could not fail independently per row. An independent reviewer said so, and the
section has been corrected to claim only what the tests prove.

**Ten channels, one reader, one test each.** A PR title, a PR body, an issue
body, a comment, source code, a README, a commit message, a branch name, a
filename and a model's own answer all reach the core the same way: as a string
put in front of a model, whose answer then meets `enforceLabels` and the
warrant. There is no per-channel parser, so there is no per-channel test — each
row of §1a is **one** test that runs every payload once, and that single run is
the whole evidence for all ten channels.

**Two channels have a reader of their own**, and those get real, separate tests
against the real parsers (`duties/review/rules.ts`, `duties/review/packs.ts`,
imported read-only) — §1b.

The payload set is `src/core/authority.adversarial.test.ts:95-125`:
`ignore-previous`, `grant-edit-file`, `grant-open-pr`, `disable-security`,
`change-configuration`, `approve-operation`, `reveal-secrets`,
`elevate-authority`, `handle-mention` (an `@handle` — without it the `owner`
column below is vacuous, which a mutation proved), four non-English variants
(vi, zh, ru, ar), `homoglyph` (Cyrillic а/е inside capability words),
`zero-width`, `base64`, `html-comment`, `yaml-injection`, `fence-escape`,
`markdown-fence-escape`, `long-padding` (20 000 characters), `null-byte`,
`rtl-override`.

### 1a. The ten channels that share a reader

| Escalation attempt                   | What is proved                                                                                                                                                            | Evidence | Test                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| Cannot widen a grant                 | `granted`/`unnamed` answer exactly what the `duties:` block wrote, with the payload in `about:`, `description`, `not` and `examples`                                      | **P**    | `authority.adversarial.test.ts:223`                         |
| Cannot set a label field             | `create`, `owner`, `confidence`, `exclusive_with`, `paths`, `color` all stay at their defaults on the **explicit** warrant path                                           | **P**    | `:248`                                                      |
| Cannot ACT on a label field          | the functions that later read those fields — `checkLabelsExist`, `owners()`, the confidence floor, the exclusivity gate — produce the same effect whatever the prose says | **C**    | `authority.consumption.test.ts:132`, `:210`, `:269`, `:316` |
| Cannot invent an outcome             | a verdict repeating the payload plus every capability name applies nothing                                                                                                | **P+C**  | `authority.adversarial.test.ts:292`                         |
| Cannot become a capability           | level 0: a repository label description is carried as prose and sets no field                                                                                             | **P**    | `:315`                                                      |
| Cannot become an effect from level 0 | the same repository label description drives `checkLabelsExist` and `owners()` and changes neither                                                                        | **C**    | `authority.consumption.test.ts:162`, `:219`                 |
| Cannot close the prompt fence        | the block carries the payload byte for byte, holds exactly one closer, and the id could not have been known in advance                                                    | **P**    | `authority.adversarial.test.ts:429`                         |

All paths in this section are relative to `src/core/`.

**Why `Cannot ACT on a label field` is separate from `Cannot set` one.** The
first reviewer's break was at parse time and the `Cannot set` row closes it. The
second auditor's three breaks were all at the consumption site, and the
`Cannot set` row cannot see them: it compares the parsed entry and never calls
the function that acts on it. Both rows are needed; neither implies the other.

**Why `Cannot set a label field` is its own row.** The reviewer broke the
boundary without it, with the whole suite green: a patch deriving a label's
`create:` from its `description` fired on this file's own fixture and nothing
noticed, because the grant row observes only `granted`, `unnamed` and label
NAMES. `create` is capability-shaped — `warrant.ts:507-529` makes
`checkLabelsExist` hand a `create: true` entry back for the caller to CREATE on
the repository instead of failing red, so a `create` derived from prose is a
write derived from prose. `owner` becomes an assignee through `owners()`;
`confidence` is that label's own floor; `exclusive_with` is what overrules a
maintainer. The row now compares the whole entry, field by field, for every
payload.

### 1b. The two channels with a reader of their own

| Channel   | Claim                                                                                                                                                                             | Test                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Rule pack | a pack carrying `duties:` is refused red, naming authority                                                                                                                        | `authority.adversarial.test.ts:708` |
| Rule pack | every payload written as a top-level key is refused                                                                                                                               | `:717`                              |
| Rule pack | using an alias is refused outright (`maxAliasCount: 0`), unlike in the warrant — asserted on the message, with the alias-free twin parsing cleanly                                | `:733`                              |
| Rule file | a `duties:` block is ignored with a warning and becomes no rule                                                                                                                   | `:753`                              |
| Rule file | every payload as a top-level key is either refused red or ignored with a warning, never read — the oversized one is refused, because YAML caps an implicit key at 1024 characters | `:766`                              |
| Both      | neither parsed shape has a field a capability could be stored in                                                                                                                  | `:809`                              |

These three readers deliberately disagree, and the disagreement is why a
name-only row was worth replacing: the warrant reader **refuses** an unknown
root key, `parsePack` **refuses** an unknown top-level key red, and `parseRules`
**warns and ignores** it. All three are safe; only two are loud.

### Property-based cover for the same rows

| Claim                                                                        | Test                             |
| ---------------------------------------------------------------------------- | -------------------------------- |
| Any grant is a subset of the closed capability set, for any file             | `authority.property.test.ts:229` |
| Free text never moves a grant off the block                                  | `:262`                           |
| An implicit warrant returns exactly the caller's fallback, by identity       | `:292`                           |
| The reader returns a warrant or throws an `Error` — never anything else      | `:318`                           |
| Applied ⊆ taxonomy, deduplicated, disjoint from labels already on the thread | `:359`                           |
| A fence encloses any text and is closed by exactly one thing                 | `:444`                           |

Two of these generators were vacuous in the first round and are not any more.
`:318` drew only hostile noise, so 0 of 400 sources parsed and the
"returns a warrant" half never ran; the store-line property at `:545` drew noise
that was never valid JSON, so it proved only that a `JSON.parse` failure is
caught. Both now draw from a mixed arbitrary **and assert that both halves were
actually reached**, so neither can decay back into testing one branch.

The vocabulary generator is not uniform noise either:
`authority.property.test.ts:47-94` mixes warrant field names, capability names
and handles into the random text, because uniform random strings never spell
`create` or `edit-file`. That half was measured sound — 300/300 runs reach the
body at `:229`/`:262` — and is unchanged.

---

## 2. Indirect escalation — seeding a value a later stage reads

Every row in §2a is **P**: it asserts the parsed value. §2b is the **C** half —
the same fields, asserted at the function that acts on them. §2b exists because
§2a alone stayed green through three working escalations.

### 2a. At the parse boundary

Direct escalation asks for a capability. Indirect escalation seeds a _value_ a
later stage reads as authority, which is the shape that actually reaches
production systems.

| Seeded value                                                                                                                                             | Stage that reads it               | Guaranteed outcome                       | Test                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- | ----------------------------------- |
| A label name only the verdict carries                                                                                                                    | `enforceLabels`                   | refused, named                           | `authority.adversarial.test.ts:482` |
| A label name in the file but outside this run's scope                                                                                                    | `enforceLabels`                   | refused exactly as an unknown name       | `:491`                              |
| Every `Label` field written into a repository label description (`create`, `owner`, `confidence`, `exclusive_with`, `color`, `paths`, `not`, `examples`) | `implicitWarrant`                 | none of them is set                      | `:515`                              |
| Capability names in a label description                                                                                                                  | `implicitWarrant`                 | grant unchanged                          | `:563`                              |
| `__proto__` / `constructor` as a label name                                                                                                              | `labelNamed`                      | ordinary map entry; no prototype reached | `:574`                              |
| A capability spelled with a homoglyph, zero-width space, fullwidth form, case change or base64                                                           | `readDuties`                      | refused by name, never dropped           | `:592`                              |
| A duty name spelled `__proto__`, `constructor`, `prototype`, `TRIAGE`, `triage `, `triаge`                                                               | `readDuties`                      | refused by name                          | `:610`                              |
| An `outcome` other than `overruled` in a store line                                                                                                      | `parseCorrection`                 | the whole line is refused                | `:625`                              |
| A label outside the taxonomy inside a committed store line                                                                                               | recall → prompt → `enforceLabels` | rendered as prose, applied never         | `:639`                              |
| `__proto__` inside a store line's JSON                                                                                                                   | `parseCorrection`                 | no prototype pollution                   | `:655`                              |
| A newline inside a store field, forging a second record                                                                                                  | `formatCorrection`                | one line, always                         | `:665`                              |

---

### 2b. At the consumption site

Every place in `src/core` and `src/doctor` where a label or warrant field is
read AGAIN after parsing, and whether the effect is observed. This is the answer
to "how would we have caught the auditor's three breaks", and it is meant to be
extended rather than admired: a new consumption site with no row here is the
next hole.

| Field                           | Consumption site                                     | Effect it produces                       | Observed?      | Test                                                                   |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| `create`                        | `checkLabelsExist` (`warrant.ts:521-522`)            | a label CREATED on the repository        | yes            | `authority.consumption.test.ts:133`, `:162`, `:178`, `:185`            |
| `owner`                         | `owners()` (`enforce.ts:187`)                        | a handle handed to the assignee endpoint | yes            | `:211`, `:219`, `:228`, `:249`                                         |
| `confidence`                    | `enforceLabels` floor (`enforce.ts:101`)             | whether a model's proposal is applied    | yes            | `:273`, `:285`, `:293`, `:304`                                         |
| `exclusive_with`                | `enforceLabels` human gate (`enforce.ts:127`)        | a maintainer's own label overruled       | yes            | `:331`, `:337`                                                         |
| `exclusive_with`                | `enforceLabels` pairwise gate (`enforce.ts:142-143`) | one proposal suppressing another         | yes            | `:317`, `:337`                                                         |
| `exclusive_with`                | `parseWarrant` cross-check (`warrant.ts:451`)        | the file refused                         | yes (P)        | `warrant.contract.test.ts:308`                                         |
| `name`                          | `labelNamed` (`enforce.ts:187`)                      | which entry a decision is read from      | yes            | `authority.consumption.test.ts:378`                                    |
| taxonomy narrowing              | the `taxonomy` argument to both gates                | which entries either gate can see at all | yes            | `:378`                                                                 |
| `paths`                         | **none in `src/core` or `src/doctor`**               | —                                        | absence pinned | `:365`                                                                 |
| lifecycle label names           | `checkLifecycleLabelsExist` (`warrant.ts:543`)       | the run refused                          | yes            | `warrant.contract.test.ts:781`                                         |
| `languages` / `pivot` / `about` | `resolveLanguages` / `resolvePivot` / `resolveAbout` | what a prompt is built from              | yes (P)        | `warrant.test.ts` — `resolveLanguages`, `resolvePivot`, `resolveAbout` |
| `granted`                       | every duty's `permitted.includes(...)`               | whether an effect fires                  | **not here**   | owned under `src/duties/**` — GAP G-A6                                 |

`paths` is the one label field this area parses and never reads. The row above
pins the absence: two taxonomies differing only in `paths` decide identically,
so a path dimension cannot appear in the core gate without failing a test.

## 3. Fail closed, no partial effect

| Claim                                                                           | Test                                |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| A refused label contributes no owner to assign                                  | `authority.adversarial.test.ts:829` |
| A run under the confidence floor assigns nobody                                 | `:854`                              |
| A maintainer's own label is never overruled                                     | `:868`                              |
| A warrant that does not parse yields no warrant at all                          | `:891`                              |
| Model confidence never grants: no value admits a name the file lacks            | `:383`                              |
| Certainty does not clear a floor it is under; `NaN`/`±Infinity` never clear one | `:390`                              |
| Model prose is defanged before it can act as a request to a human               | `:401`                              |
| Model prose cannot smuggle an HTML comment into a published body                | `:414`                              |
| Dry-run touches nothing, however many times it is replayed                      | `state.idempotency.test.ts:342`     |
| Dry-run after a real run still touches nothing                                  | `:355`                              |

---

## 4. Configuration as a public behavioural contract

Every row is asserted on the message a real run prints, not only on the fact
that something threw. Determinism is asserted separately
(`warrant.contract.test.ts:239`), as is the claim that the file path is the
only thing a message varies by (`:250`).

| Input class                                                                                          | Deterministic outcome                                                                                                                                                                                                                                                 | Test                                      |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Valid — minimal, and a whole file                                                                    | parses                                                                                                                                                                                                                                                                | `warrant.contract.test.ts:220` (rows 1–2) |
| Empty file / whitespace only / comments only                                                         | `is not a warrant`                                                                                                                                                                                                                                                    | `:220`                                    |
| Malformed YAML                                                                                       | `is not valid YAML`                                                                                                                                                                                                                                                   | `:220`                                    |
| A list or a bare string at the root                                                                  | `is not a warrant`                                                                                                                                                                                                                                                    | `:220`                                    |
| Two YAML documents in one file                                                                       | `is not valid YAML`                                                                                                                                                                                                                                                   | `:220`, `:376`                            |
| Duplicate keys, at the root and inside `duties:`                                                     | `is not valid YAML` — never last-wins                                                                                                                                                                                                                                 | `:220`                                    |
| Unknown root field, incl. pre-1.0 `capabilities:` and legacy `apply`                                 | `unrecognized key`                                                                                                                                                                                                                                                    | `:220`                                    |
| Unknown label field                                                                                  | `unrecognized key`                                                                                                                                                                                                                                                    | `:220`                                    |
| Invalid duty                                                                                         | `is not a known duty`                                                                                                                                                                                                                                                 | `:220`, `:479`                            |
| Invalid capability                                                                                   | `is not something a duty can be granted`                                                                                                                                                                                                                              | `:220`, `:413`                            |
| Conflicting config (`[none]` beside a real capability)                                               | refused                                                                                                                                                                                                                                                               | `:220`                                    |
| Missing required field (`version`, a label `description`)                                            | named                                                                                                                                                                                                                                                                 | `:220`                                    |
| Invalid model config (`version: 2`)                                                                  | `declares version`                                                                                                                                                                                                                                                    | `:220`                                    |
| `duties:` written with nothing under it                                                              | refused as a half-finished edit                                                                                                                                                                                                                                       | `:220`                                    |
| Wrong types (`labels` as a mapping, `duties` as a list, description as a number, confidence as text) | refused, naming the type                                                                                                                                                                                                                                              | `:220`                                    |
| Null vs absent (`labels:` null = empty; `duties:` null refused; a duty written null refused)         | distinguished                                                                                                                                                                                                                                                         | `:220`                                    |
| Oversized free text (100 000 characters)                                                             | carried, not truncated                                                                                                                                                                                                                                                | `:220`                                    |
| YAML anchors                                                                                         | accepted and inert; an alias cannot be parked under a second root key                                                                                                                                                                                                 | `:332`                                    |
| YAML merge keys (`<<`)                                                                               | refused at root, in `duties:`, and on a label                                                                                                                                                                                                                         | `:353`                                    |
| `version` spellings `1`, `1.0`, `0x1`, `+1`, `0o1`                                                   | all accepted as one; `"1"`, `true`, `1.5`, `[1]`, `01a` refused                                                                                                                                                                                                       | `:393` — root: PIN CORRECT                |
| Capability whitespace                                                                                | matched after `String.trim()` — which strips NBSP, BOM, the ideographic space and the line/paragraph separators as well as space and tab, and nothing else; case, homoglyph, fullwidth, base64, zero-width space, ZWJ, word joiner, bidi override and NUL all refused | `:413` — root: PIN CORRECT                |
| YAML comment after a value                                                                           | never part of the value                                                                                                                                                                                                                                               | `:470`                                    |
| `lifecycle.say`: `true`, `false`, text, mapping, empty mapping, empty string, list                   | each read or refused by name                                                                                                                                                                                                                                          | `:616`–`:669`                             |
| `lifecycle` track / step / override that is not a mapping                                            | refused, naming the entry                                                                                                                                                                                                                                             | `:675`, `:681`, `:758`                    |
| `lifecycle.exempt` not a mapping; a guard that is neither boolean nor list                           | refused                                                                                                                                                                                                                                                               | `:696`, `:719`                            |
| `lifecycle.overrides:` written null                                                                  | no overrides                                                                                                                                                                                                                                                          | `:738`                                    |
| Missing lifecycle labels                                                                             | named at once, singular/plural correct                                                                                                                                                                                                                                | `:781`                                    |
| Durations (`soon`, `7`, `0d`) in step and override                                                   | refused, naming the grammar                                                                                                                                                                                                                                           | `:822`                                    |
| `propose:` not a mapping; partial `propose.workspace`                                                | refused / each default filled independently                                                                                                                                                                                                                           | `:869`, `:875`, `:889`                    |
| dependa ignore `ecosystem:` null; duplicate `types`                                                  | no ecosystem / deduplicated                                                                                                                                                                                                                                           | `:899`, `:910`                            |
| Label `color:` (case, null, `#`-prefixed, non-hex, wrong length, list)                               | normalised to lower case, or refused                                                                                                                                                                                                                                  | `:933`–`:942`                             |
| Label `create:` (null, non-boolean)                                                                  | defaults `false`, or refused                                                                                                                                                                                                                                          | `:958`, `:963`                            |
| `endpoints` line with no alias                                                                       | quotes the whole entry                                                                                                                                                                                                                                                | `inputs.test.ts:604`                      |
| `api-keys` line with no `=`                                                                          | masked first, then refused                                                                                                                                                                                                                                            | `inputs.test.ts:612`                      |
| `api-keys` entry with no alias                                                                       | refused                                                                                                                                                                                                                                                               | `inputs.test.ts:635`                      |
| `since` naming a field the calendar has not (`2026-13-01`, day 0, day 32)                            | refused                                                                                                                                                                                                                                                               | `inputs.test.ts:639`                      |
| `since` the calendar overflows (`2026-02-30`, `2025-02-29`, `2026-04-31`)                            | refused — the parsed date is compared back against the fields it was written with                                                                                                                                                                                     | `inputs.test.ts:659` **FIXED**            |

### No partial mutation, and no spend before validation

| Claim                                                                                   | Test                           |
| --------------------------------------------------------------------------------------- | ------------------------------ |
| Every refused source yields no warrant at all                                           | `warrant.contract.test.ts:270` |
| A written `duties:` block still denies every unnamed duty, whatever else is in the file | `:287`                         |
| A taxonomy validated only at the end still refuses the whole file                       | `:308`                         |
| Malformed YAML fails before any network call                                            | `:523`                         |
| An unknown capability fails before any network call                                     | `warrant.contract.test.ts:533` |
| A chosen path that is not there fails before any network call                           | `:543`                         |
| Only a genuine absence at the default path ever reaches the forge                       | `:552`                         |
| A warrant read from disk equals the same bytes parsed in memory                         | `:561`                         |

### Doctor and runtime agree

| Claim                                                                                                                                                                                                  | Test                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Every `duties:` shape (absent, list, `true`, `false`, `[none]`, partial, cross-thread grants, all duties) resolves identically in `diagnose` and in `parseWarrant` + each duty's own `capabilities.ts` | `doctor/authority-agreement.test.ts:174`      |
| A duty-scoped report equals that duty's row in the whole-run report                                                                                                                                    | `:205`                                        |
| A level-0 report describes the same narrowest authority a level-0 run acts under                                                                                                                       | `:219`                                        |
| Every configuration a run refuses is red in doctor too                                                                                                                                                 | `:268`                                        |
| The finding is the reader's own sentence, not a second one                                                                                                                                             | `:281`                                        |
| A chosen path with no file is red in doctor                                                                                                                                                            | `:298`                                        |
| A warrant granting nothing produces a table of nothing, not a table of defaults                                                                                                                        | `:313`                                        |
| An inert grant is red and narrowed out of effective authority                                                                                                                                          | `:334`                                        |
| A denied duty is a table row, never a problem                                                                                                                                                          | `:349`                                        |
| A forge failure that is not `Error`-shaped is classified, not crashed on                                                                                                                               | `doctor/diagnose.contract.test.ts:91`–`:141`  |
| The provider probe reports a class of answer, never a provider's words                                                                                                                                 | `doctor/diagnose.contract.test.ts:186`–`:235` |

---

## 5. State and idempotency

| Replay scenario                                | Guaranteed effect                                                | Test                            |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| Same event twice                               | one pull request, updated not duplicated                         | `state.idempotency.test.ts:207` |
| Same event six times                           | one PR, one branch, one file                                     | `:220`                          |
| Replay after a first write                     | carries the existing SHA, so a concurrent write is not clobbered | `:234`                          |
| Rerun with changed content                     | same PR, new body, new content                                   | `:245`                          |
| Workflow retry                                 | no second branch, no second PR                                   | `:265`                          |
| `publishStatePr` repeated                      | one create, then updates only                                    | `:280`                          |
| `ensureBranch` twice                           | one create                                                       | `:292`                          |
| Maintainer closed the PR (declared force push) | branch reset to base, new PR                                     | `:304`                          |
| Open PR present                                | never reset out from under itself                                | `:321`                          |
| Nothing to publish                             | no call at all                                                   | `:331`                          |
| Dry-run replayed five times                    | zero calls, no branch, no PR                                     | `:342`                          |
| Dry-run after a real run                       | nothing changes                                                  | `:355`                          |
| Capacity error before the first write          | nothing written, and the warning says so                         | `:405`                          |
| Capacity error partway through                 | the warning names how many files were already written            | `:419` **REGRESSION**           |
| Partial failure                                | no PR is opened for a half-written state                         | `:444`                          |
| Retry after a partial failure                  | completes the write, one PR                                      | `:457`                          |
| A path that is a directory                     | no SHA read; the write creates                                   | `:647`                          |
| Repository reports no default branch           | published against `main`                                         | `:668`                          |
| Branch-existence check fails non-404           | propagates; no branch created                                    | `:684`                          |

### The fingerprint

| Claim                                                          | Test                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| The same decision written twice is the same bytes              | `state.idempotency.test.ts:500`                                   |
| Key order is fixed regardless of construction order            | `state.idempotency.test.ts:504`                                   |
| Write → read → write is a fixed point                          | `state.idempotency.test.ts:525`, `authority.property.test.ts:476` |
| Every meaningful field changes the bytes when it changes       | `state.idempotency.test.ts:533`                                   |
| Decided-label order is part of the record, not normalised away | `state.idempotency.test.ts:558`                                   |
| A record is always exactly one NDJSON line                     | `state.idempotency.test.ts:567`, `authority.property.test.ts:464` |
| An in-memory `note: "   "` settles on the first write          | `authority.property.test.ts:495` **ADJUDICATE**                   |

### Corruption fails safely

| Claim                                                                               | Test                             |
| ----------------------------------------------------------------------------------- | -------------------------------- |
| A line that is not a correction is refused whole, never half-read                   | `state.idempotency.test.ts:588`  |
| A context field that is the wrong type defaults rather than losing the decision     | `:609`                           |
| A pivot rendering that is not one reads as no rendering                             | `:623`                           |
| An unreadable shard is reported and the rest of the store still read                | `memory.test.ts:607`             |
| Reading a line never throws, and a readable and an unreadable line are both reached | `authority.property.test.ts:545` |

---

## 6. Negative controls

Each row is a real production check, temporarily removed; `RED` means at least
one test in this round's suites failed. All 36 were confirmed red against the
final code.

**Round 3 (Z) is the important block.** Every Z row is a mutation at a
CONSUMPTION site — the function that reads a field after parsing — and every one
of Z1–Z3 was found by an independent security auditor running GREEN against the
full 4868-test suite before this round. They are listed first because they are
the class of hole this page previously could not see.

### Round 3 — consumption sites

| #     | Check removed                                                                | File              | Result                 |
| ----- | ---------------------------------------------------------------------------- | ----------------- | ---------------------- |
| Z1    | `checkLabelsExist` derives `create` from the description (**auditor's**)     | `core/warrant.ts` | RED                    |
| Z2    | `owners()` derives `owner` from the description (**auditor's**)              | `core/enforce.ts` | RED                    |
| Z3    | `enforceLabels` derives the label floor from the description (**auditor's**) | `core/enforce.ts` | RED                    |
| Z4    | `enforceLabels` derives the human-exclusivity gate from the description      | `core/enforce.ts` | RED                    |
| Z5    | `enforceLabels` derives pairwise exclusivity from the description            | `core/enforce.ts` | RED                    |
| Z6    | `owners()` stops splitting teams from users                                  | `core/enforce.ts` | RED                    |
| Z7    | `checkLabelsExist` never offers anything for creation                        | `core/warrant.ts` | RED                    |
| Z8    | `owners()` returns nothing at all                                            | `core/enforce.ts` | RED                    |
| Z9    | a label's own floor is ignored, the run floor always used                    | `core/enforce.ts` | RED                    |
| (Z10) | `checkLabelsExist` offers every missing label for creation                   | `core/warrant.ts` | EQUIVALENT — see below |

Z10 is an **equivalent mutant**, not a gap. Replacing
`missing.filter((label) => label.create)` with `missing` changes the return
value only when some missing label lacks `create` — and in exactly that case
`toFail` is non-empty and the function throws before returning. The two forms
are provably indistinguishable to a caller, so no test can or should
distinguish them.

Z6–Z9 are the converse controls: they break the consumption site in the _other_
direction (stop honouring the written field). Without them, every "untrusted
prose changes nothing" assertion above would be satisfied by a function that had
stopped working altogether.

### Rounds 1–2 — parse boundary and behaviour

| #   | Check removed                                                | File                     | Result |
| --- | ------------------------------------------------------------ | ------------------------ | ------ |
| Y1  | `create` derived from a label description (first reviewer's) | `core/warrant.ts`        | RED    |
| Y2  | `owner` derived from a label description                     | `core/warrant.ts`        | RED    |
| Y3  | `confidence` derived from a label description                | `core/warrant.ts`        | RED    |
| Y4  | `exclusive_with` derived from a label description            | `core/warrant.ts`        | RED    |
| Y5  | `paths` derived from a label description                     | `core/warrant.ts`        | RED    |
| Y6  | fence nonce fixed                                            | `core/enclose.ts`        | RED    |
| Y7  | pack unknown top-level key accepted                          | `duties/review/packs.ts` | RED    |
| Y8  | pack alias resolution re-enabled                             | `duties/review/packs.ts` | RED    |
| Y9  | rules unknown top-level key silently dropped                 | `duties/review/rules.ts` | RED    |
| Y10 | `since` calendar-overflow check removed                      | `core/inputs.ts`         | RED    |
| Y11 | `since` overflow check made to reject every date             | `core/inputs.ts`         | RED    |
| Y12 | capability match widened past `String.trim()`                | `core/warrant.ts`        | RED    |
| Y13 | doctor emits a second finding for one configuration mistake  | `doctor/diagnose.ts`     | RED    |
| A   | taxonomy membership in the label gate                        | `core/enforce.ts`        | RED    |
| B   | deny-by-default once `duties:` is written                    | `core/warrant.ts`        | RED    |
| C   | `unnamed` always false                                       | `core/warrant.ts`        | RED    |
| F   | confidence finiteness gate dropped                           | `core/enforce.ts`        | RED    |
| G   | store `outcome` enum relaxed                                 | `core/memory.ts`         | RED    |
| H   | dry-run early return removed                                 | `core/state-branch.ts`   | RED    |
| I   | existing-PR check skipped                                    | `core/state-branch.ts`   | RED    |
| J   | implicit warrant grants every capability                     | `core/warrant.ts`        | RED    |
| M   | store line written unescaped                                 | `core/memory.ts`         | RED    |
| R   | store `thread` type check relaxed                            | `core/memory.ts`         | RED    |
| V   | partial-write warning restored to the old wording            | `core/state-branch.ts`   | RED    |
| W   | doctor's ladder narrowing skipped                            | `doctor/diagnose.ts`     | RED    |
| X   | doctor ignores `denied`                                      | `doctor/diagnose.ts`     | RED    |

Round 1 also confirmed red on checks whose mutations are unchanged: unknown root
key, unknown capability, `sanitize`, lifecycle step and `say:` type guards,
`isMissing`.

**Three mutations SURVIVED on first attempt across the three rounds**, and in
every case the TESTS were fixed, not production:

- **Y2** — the payload set carried no `@handle`, so nothing could reach `owner`.
- **Y8** — the alias test asserted a bare `toThrow` that any unrelated refusal
  satisfied.
- **Z1–Z3** — the whole consumption-site class was unobserved; this page's §2b
  and `authority.consumption.test.ts` are the fix.

## 7. Residual gaps and classified branches

### GAPs

| ID   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Priority |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| G-A1 | ~~The channel dimension in §1 is a name, not a wire fixture.~~ **RESOLVED.** §1 no longer claims a per-channel test it does not have: the ten channels that share a reader are stated as sharing one, and the two with a reader of their own (`rule-file`, `rule-pack`) now have real tests against the real parsers. What remains true and is now said in §1 rather than hidden here: no GitHub event payload is driven end to end from this page — duty-level integration suites own that. | closed   |
| G-A6 | `granted` is consumed at every duty's `permitted.includes(...)` under `src/duties/**`, which this lead does not own. §2b marks it **not here**. TL2/TL4 hold the duty-side capability gates; this page should not be read as covering them.                                                                                                                                                                                                                                                  | P1       |
| G-A7 | `paths` is parsed here and read only under `src/duties/**`. The absence is pinned in core (`authority.consumption.test.ts:365`), but the real consumption site has no row on this page.                                                                                                                                                                                                                                                                                                      | P2       |
| G-A5 | `parseRules` warns-and-ignores an unknown top-level key where `parsePack` refuses one red. Both are safe; a maintainer who assumed the two behaved alike would be wrong about which of their mistakes gets reported. Worth one sentence in the review duty's reference.                                                                                                                                                                                                                      | P3       |
| G-A2 | `docs/reference/warrant-format.md` does not state whether YAML anchors are permitted. `warrant.contract.test.ts:332` pins the behaviour; the reference should say it.                                                                                                                                                                                                                                                                                                                        | P3       |
| G-A3 | `durationField`'s `allowNever: true` overload (`core/warrant.ts:1871-1889`) has no call site in `src/`. The `never` value and the " or `never`." half of its message are unreachable.                                                                                                                                                                                                                                                                                                        | P3       |
| G-A4 | `diagnose.ts:503-506` is a ternary whose two arms produce the identical string. Harmless, but it is dead code masquerading as a branch.                                                                                                                                                                                                                                                                                                                                                      | P3       |

### Adjudicated pins

Four behaviours were pinned as found in the first round and adjudicated by root:

| Behaviour                                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version: 1.0` / `0x1` / `+1` / `0o1` accepted as the integer `1`        | PIN CORRECT — kept, with the accept-surface written out in §4                                                                                                                                                                                                                                                                                                                                                |
| Capability entries matched after `String.trim()`                         | PIN CORRECT — kept, with the exact trim surface measured in `warrant.contract.test.ts:413`                                                                                                                                                                                                                                                                                                                   |
| `since: 2026-02-30` rolling to 2 March                                   | **REAL DEFECT — FIXED.** The line above it already refused `2026-01-32` and `2026-13-01` as "not a real date"; 30 February is exactly as impossible, and the inconsistency was the bug. `inputs.ts` now compares the parsed date back against the fields it was written with. Regression proved red first (`inputs.test.ts:659`), with a leap-day guard so the check cannot eat a real 29 February (`:683`). |
| `formatCorrection` not normalising `note` the way `parseCorrection` does | PIN DEFENSIBLE — kept as documented; unreachable in production, every writer sets `note` to `null` or a trimmed sentence                                                                                                                                                                                                                                                                                     |

### Branch coverage in this area

Measured over `src/core/{warrant,enforce,inputs,memory,state-branch,recall,derive,sanitize,script,languages,pivot,list,enclose}.ts`
and `src/doctor/**` (`run.ts` stays coverage-excluded — it calls
`core.setOutput`/`core.setFailed` for real):

|                   | Branches | Covered       | Uncovered |
| ----------------- | -------- | ------------- | --------- |
| Before this round | 1045     | 961 (91.96%)  | 84        |
| After             | 1053     | 1019 (96.77%) | 34        |

`state-branch.ts`, `inputs.ts` and `pivot.ts` reach 100%; `warrant.ts` moves
90.0% → 97.2% and `diagnose.ts` 80.5% → 90.2%. The branch total grew by 8
because the `since` fix added a real check. The 34 that remain are all in the
table below, classified rather than excluded.

### Branches deliberately left uncovered

Classified rather than excluded — root adjudicates whether any of these earns a
coverage exclusion. A branch is listed here only because covering it would have
required a test that does not protect behaviour.

| Location                                                                                        | Classification                                                                                      |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `core/derive.ts:118-119` (`labelOf`'s `catch`, empty-name guard)                                | defensive; the module's own doc comment says the `catch` is unreachable from here                   |
| `core/derive.ts:89` (`scriptsOf` rejecting an ISO 15924 code Unicode has no script for)         | defensive; measured against this ICU, the four composite codes are the whole disagreement           |
| `core/enforce.ts:141` (`byName.get(kept)?.` nullish arm)                                        | unreachable; every name in `applied` came from `byName`                                             |
| `core/memory.ts:257` (`ranked`'s empty-store guard)                                             | unreachable; both callers return early on an empty store                                            |
| `core/memory.ts:309` ×2, `:383`, `:393`, `:459` ×2 (index and map-lookup `??` guards)           | defensive; bounds are established by the surrounding loop                                           |
| `core/memory.ts:516` (`error instanceof Error` false arm in the shard `catch`)                  | defensive; `readFile` rejects with an `Error`                                                       |
| `core/warrant.ts:374`, `:884` ×2 (non-`Error` rejection / non-`YAMLParseError` throw)           | defensive                                                                                           |
| `core/warrant.ts:1883`, `:1887` (`allowNever`)                                                  | dead code — see G-A3                                                                                |
| `core/warrant.ts:1939` (`best.get(bestDistance) ?? []`)                                         | unreachable; `bestDistance` is always a key the loop just wrote                                     |
| `core/warrant.ts:1953`, `:1962-1969` (Levenshtein equality shortcut and index guards)           | unreachable; `closestKeys` never compares a key with itself                                         |
| `core/warrant.ts:1983` (`bigint` arm, and the function/symbol fallback in `describe`)           | unreachable from YAML                                                                               |
| `doctor/diagnose.ts:495` (`rotateModels` throwing something other than `AuthenticationFailure`) | defensive                                                                                           |
| `doctor/diagnose.ts:503-506`                                                                    | dead — see G-A4                                                                                     |
| `doctor/diagnose.ts:545` (`auth` in the non-throwing branch)                                    | unreachable; `rotateModels` throws on the first auth failure, so the thrown branch above answers it |
| `doctor/diagnose.ts:551` ("the probe did not reach any provider")                               | unreachable; every `Failure` carries one of the three kinds above it                                |
| `doctor/diagnose.ts:584`, `:592` (`DEFAULTS_BY_DUTY`/`LADDER_BY_DUTY` `?? []`)                  | unreachable; `duty` is validated against `DUTIES` before either is read                             |

---

**Related:** [The authority model](../concepts/authority-model.md) ·
[Threat model](../security/threat-model.md) ·
[The warrant format reference](../reference/warrant-format.md) ·
[The intent matrix](intent-matrix.md)
