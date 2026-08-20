<!-- source of truth: review/action.yml -->

# `review`

_Full contract for the `review` duty — every input, every output, checked against `review/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

A pull request changes, and the finding that was true at the previous SHA may
be one thing now: still standing, changed, resolved, or back after the code
came around again. `review` answers the pull request with one owned summary
comment — its own, idempotent under its marker — that tracks its findings
across `synchronize` events instead of reposting them, and with an owned
inline review thread per finding whose line the diff still proves. It
reviews; it does not code.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for, and what it will never become

The gap between a pull request and a careful reader is where the useful parts
of review live: a diff read against the repository's own rules, the findings
written down where the author can answer them, and the review that said a
thing once not repeating itself on every force-push. `review` fills that gap
with a single owned summary comment plus an owned inline thread per
diff-proven finding — the useful half of what a review bot does, without the
part that makes review bots noise.

**It is not a coding agent, and this is not a soft claim.** [The north
star](../../doctrine/north-star.md#8-non-goals) says Reeve does a duty and
stops; for `review` that means exactly one write is even thinkable — a
comment — and the warrant can grant no capability besides `comment`. It does
not edit code, open a fixing pull request, run a test suite, request changes
on the review API, or hold a conversation about its own findings. A
maintainer who wants any of that does it themselves; no input here, and no
warrant entry, turns it on. Review comments and threads only, and only where
the warrant grants `comment`. A riskier diff gets more passes over the same
reading — depth is priced, capability is not: no risk profile can ever grant
`comment` or anything else, and the warrant alone decides what this duty may
write.

Remediation proposals are a separate duty, not a review capability.
[`remediation`](remediation.md) reads this review's own owned comment and
derives deterministic proposals for its standing findings — it proposes, and
it never edits repository state. Nothing review-side can ever turn it on.

**It is the top rung of [the ladder](../../doctrine/north-star.md#3-the-ladder),
and it is granted nothing on any default.** A finding printed on a pull
request reads, to everyone downstream, as though somebody from the project
reviewed it — which is the whole reason every default in this duty is the
strictest in this repository. `review` is granted nothing until a warrant
names it, whether the file is missing entirely or merely silent about this
duty. There is no cheap version of publishing a claim that reads as a project
review; `comment` is the only capability it has, and it is off until written
down.

## When to use it

A repository whose pull requests outpace how quickly a maintainer can say
something back. Grant nothing at first — the default warrant already runs this
duty with `comment` withheld, so a workflow can read the findings off the job
summary on real pull requests before deciding to let it post. Start from
`trigger: pr` and `dry-run: true`, watch a few `synchronize` events, and only
then grant `comment` and remove the dry-run.

## Example (minimal workflow YAML)

```yaml
name: Review

on:
  pull_request:
    types: [ready-for-review, synchronize, opened]

concurrency:
  group: reeve-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      # The rules file is part of the job's own pinned checkout, so a pull
      # request cannot replace it before the review reads it. Without `ref:`,
      # `checkout` would check out the pull request's merge ref — and until the
      # PR is merged, that ref carries the PR author's own `.github/reeve-rules.yml`.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - uses: ecoma-io/reeve/review@v0.6 <!-- roadmap ref -->
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

That alone reviews and posts nothing: the checker reads the warrant, and a
`.github/reeve.yml` that does not grant `review: [comment]` leaves the findings
on the job summary and the thread untouched. Grant `comment` once you trust
it. The `pull-requests: write` scope covers both the read and the one write —
see [Required permissions](#required-permissions).

## Required permissions

**Token:** `pull-requests: write`. `GITHUB_TOKEN` is enough — this is one
indivisible GitHub scope, a token that can comment can also merge and close,
which is why what this run may actually do is decided in code against the
warrant file rather than by what the token can reach.

**Warrant grant:** like [`duplicate`](duplicate.md#required-permissions) and
[`respond`](respond.md#required-permissions), `review` is granted nothing by
default, and the `duties:` block in the warrant is the whole authority:

```yaml
# .github/reeve.yml
duties:
  review: [comment]
```

Leave the block silent about `review` and the run decides, reports on the job
summary, and posts nothing — a real answer, not a misconfiguration, and the
job summary says so. There is no smaller grant than `comment`; `review` has
exactly one capability to give. It needs `pull-requests: write` on the token,
and nothing on the workflow can widen the block. See
[the duties table](../../guides/warrant.md#duties). Like `duplicate` and
`respond` before it, `review` is one of the comment-posting duties with no
default at all — a written `duties:` block that simply leaves it unnamed
grants it nothing, exactly as an absent file does.

## Required inputs

`models` is the only input this action requires — the roster that reads the
diff, in preference order. Everything else has a default. `api-key` is not
required by the schema, but almost every real provider needs one — see
[Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `review/action.yml` declares.

| Input               | Required | Default                     | What it does                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-token`      | no       | `${{ github.token }}`       | Token used to read the pull request and write the owned summary comment and inline threads. `pull-requests: write` on the token covers all three (list, create, update); the warrant decides whether anything is written at all.                                                                                                                       |
| `number`            | no       | _(empty)_                   | The pull request to review. Defaults to the one that triggered the workflow — meant to run on `pull_request` events, not on a backfill. An event that carries no pull request fails red naming the event.                                                                                                                                              |
| `base-url`          | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint.                                                                                                                                                                                                                                                                                                     |
| `api-key`           | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                                                                                                                                                                                                                                        |
| `models`            | **yes**  | —                           | Model ids, comma or newline separated, in preference order. The roster that reads the diff.                                                                                                                                                                                                                                                            |
| `warrant`           | no       | `.github/reeve.yml`         | Where the permissions live. `comment` is granted here, under `duties:`. A missing file grants `review` nothing, same as one that is silent about it.                                                                                                                                                                                                   |
| `rules-path`        | no       | `.github/reeve-rules.yml`   | The repository's own review rules, in the same YAML grammar the warrant uses. Missing is an empty rules set, not an error — the built-in default rules alone review the diff.                                                                                                                                                                          |
| `packs-path`        | no       | `.github/reeve-packs`       | Where the rule packs this rules file references live — `<namespace>/<name>.yml` under it. A `packs:` reference resolves here; a missing or non-matching pack fails red. See [Rule packs](../rule-packs.md).                                                                                                                                            |
| `risk-path`         | no       | `.github/reeve-risk.yml`    | The repository's own risk profile — deterministic signal weights and path globs that price review depth. Missing is the default profile, not an error. It prices depth only and cannot grant a capability — the warrant alone does that.                                                                                                               |
| `trigger`           | no       | `pr`                        | `pr` — the default — waits for ready-for-review and skips a draft green, with the reason in the job summary. `prod` also reviews drafts.                                                                                                                                                                                                               |
| `max-diff-chars`    | no       | `12000`                     | The whole-run budget of diff text one review may carry to the model, in characters — cumulative across files, walked in listing order, with the first file that does not fit and everything after it skipped as capped. `none` removes the bound. `0` is refused.                                                                                      |
| `max-context-chars` | no       | `12000`                     | The whole-run budget of the repository context the review engine assembles (changed symbols, imports, related tests, configuration, surrounding base-branch source, callers, change history) that one review may carry to the model, in characters. Sections drop whole past the budget with a visible mark. `none` removes the bound. `0` is refused. |
| `confidence`        | no       | `0.6`                       | The floor for the whole review's reported confidence, between 0 and 1 — one number for the whole answer, not a per-finding bar. Below it, findings are still reconciled and shown in the job summary, but the comment is withheld.                                                                                                                     |
| `dry-run`           | no       | `false`                     | Run the whole pipeline, write every output, post nothing. The review comment that would have been posted is printed to the log, and the job summary still shows the full verdict.                                                                                                                                                                      |
| `endpoints`         | no       | _(empty)_                   | Extra `alias = url` endpoints beyond `base-url`, each with an optional `timeout=`. A model id routes to one with `model@alias`.                                                                                                                                                                                                                        |
| `api-keys`          | no       | _(empty)_                   | One `alias = key` per line for each `endpoints` alias that needs one. Each key — everything after its first `=` — is registered as a secret before any entry is validated.                                                                                                                                                                             |
| `request-timeout`   | no       | `120s`                      | How long one request may run before it counts as weather — whole seconds or minutes; a bare number names no unit and is refused.                                                                                                                                                                                                                       |
| `temperature`       | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request — some providers reject it outright.                                                                                                                                                                                                                                           |

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the
same four provider inputs every duty takes — the full grammar, the
`model@alias` routing rule, and what more than one endpoint changes about
auth failures are all in
[Providers and the runtime](../../guides/providers.md#more-than-one-endpoint).

**`rules-path` is read from the checkout and trusted — and the checkout is
the workflow's own, pinned to the base branch.** You have to be able to say
_who wrote the rules the model is following_, and nothing here can prove that
if the workflow checks out the pull request's merge ref: until the PR is
merged, that ref carries the PR author's own rules file. So review.md's
example checks out `github.event.pull_request.base.ref` — the rules a model
ever follows are the ones that already survived a review of their own. The
file is your own maintainers' text, reviewed like any other change, so it
enters the model's instructions unwrapped — the same shelf the taxonomy sits
on — but its values are never authority on their own (see
[Security considerations](#security-considerations)). The diff, and the pull
request it came from, are a stranger's words and stay behind the sanitising
boundary regardless. A repository that has not written the file yet is the
cold start — reviewed by the built-in default rules alone — not a
misconfiguration.

**Rule packs let a rules file reuse policy by reference.** A `packs:` entry —
`- pack: security/owasp@1` — resolves to `<packs-path>/security/owasp.yml` in
the same pinned checkout, and its rules, ignores, generated suffixes and
blocked phrases compose with the local file under
[composition and precedence](../rule-packs.md#composition-and-precedence):
the local rules file stays authoritative, then packs in reference order, then
the built-in defaults. A pack is committed repo text on the same shelf as the
rules file — it enters the prompt unwrapped, it is never fetched, and it can
never grant authority: a pack carrying `duties:`, `capabilities:`, `warrant:`
or `labels:` is refused red. The full grammar — references, version pins, hard
limits, and the security model — is in [Rule packs](../rule-packs.md).

**`confidence` is a whole-answer floor worth measuring, not inheriting.**
The model states one confidence for the entire review — not a per-finding
number — and the floor admits or withholds the comment as a whole. [Measure
it](../../development/evaluation.md) against your own diffs before you move
it — what `0.6` means for one project's tolerance for a slightly-off finding
is not what it means for another's.

## The owned summary comment, the ladder, and inline threads

**Exactly one owned summary comment per pull request, ever, and an owned
inline review thread per finding the diff still proves.** The core
anti-pattern this duty exists to avoid is a bot that reposts the same findings
on every synchronize event. The summary comment carries this duty's marker — a
fingerprint of the rendered review plus a base64 envelope holding the previous
run's findings and the SHAs it reviewed. The next run recomputes the
fingerprint: a run that reached the same review changes nothing
(`commented: false`, the comment left in place), and a run whose findings
moved replaces the comment in place. Reruns never stack a second review under
the first.

**The inline threads are the useful half a comment alone lacks** — each
finding with a line the diff proves gets to be answered where it lives, not
scrolled past in a wall of findings. Every thread is owned the way the summary
is: it carries its own marker (`<!-- reeve:review:thread source=<fingerprint>.<position key> -->`)
written by a bot author, keyed by the finding's position (rule, file, line),
and only a body whose marker parses as a real fingerprint over a nonempty key
is ever touched as Reeve's own — a forged, truncated, or human-authored thread
is left alone. Idempotency comes from the live listing, never from memory:
each run lists the pull request's review comments, and a thread whose rendered
body already matches is left alone, so a rerun never stacks a second copy. A
finding whose line GitHub can no longer anchor (422 from the review-comments
API) falls back to the summary, which renders every finding — a threading
problem can never lose a finding, and a thread-listing failure throws before
the summary is written, so a permission problem can never leave a duplicate
on the next run's relisting. When a pull request has so many review comments
that this duty's own threads cannot be listed with certainty, threads are
withheld — the summary still posts, exactly once.

**The changes a finding passes through.** A finding is a rule, a file, a line
and a reason, with a stable identity across runs. Comparing this run's
findings against the previous run's envelope gives each one a status:
`created` (new), `persists` (still standing), `changed` (the claim moved),
`resolved` (the diff moved on), or `reopened` (a resolved finding is back
with new evidence). The comment renders them under headings a human review
uses — "New findings", "Still standing", "Resolved" — so a thread's history
reads the way a reviewer's own comment would.

**Two code guards enforce "one summary comment, and it holds its memory."**
This duty's marker, found the same bot-author walk every duty uses, stops a
rerun from treating an existing comment as absent, and the marker's
`official === ""` check means a forged or quoted marker is never overwritten
as if it were Reeve's own. When a pull request has so many comments that this
duty's own cannot be found with certainty, the review is withheld —
`withheld` — rather than risk a duplicate. Neither guard is configurable,
because an input can be misconfigured and these two cannot be. The inline
threads answer to the same ownership rule through their own marker, and the
same walk: a thread the listing cannot prove is this duty's own is never
touched, and a listing that never reaches a short page withholds thread
writes rather than risk a copy.

**`resolved` is evidence, never agreement — and the ladder carries a human
axis beside it.** A finding the diff has truly moved past is `resolved` by
evidence — the line or file it named left this run's review — not by anything
anyone said. `reopened` is driven only by the model re-citing a finding this
duty's own memory recorded as resolved; a human resolving the GitHub
conversation, or replying "done", never changes the statuses above, because
those statuses are always this duty's own claims about the diff. "Resolved"
never means "the author agreed with the reviewer".

What a human _does_ say is read, attributed, and shown beside the ladder as a
separate **disposition** axis. A maintainer (an `OWNER`, `COLLABORATOR` or
`MEMBER` account — never a bot, never the pull request's own author) can
reply to the owned comment with a strict, anchored line naming a finding and a
judgment — `verified`, `accepted-risk`, `wont-fix`, or `rejected` — and the
next run reads those replies off the thread and renders the disposition under
that finding, keyed to the finding's intention (rule and file), not its
mutable line or body, so it survives synchronize, force push, line movement
and comment replacement. The thread reply is the durable home; the envelope
only mirrors it, and a mirrored disposition that no longer has its reply on
the thread is dropped. A disposition is additive — it records what a
maintainer decided, it never overrules the evidence ladder, and it is never
silently reverted.

This keeps the ladder honest (the duty documents only what its single owned
summary comment and its own inline threads decided) while giving the thread
the last rung a human review has — conversation itself, heard. See
[what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Deterministic findings, before any model

The repository rules file carries four deterministic pre-checks that fire
before a model is asked anything, each _always-right by construction_:

- **`ignore.files` / `ignore.paths`** — files that never reach the model.
- **`generated`** — suffixes (default `.min.js`, `.min.css`, `.map`) skipped
  as generated before the diff is shown.
- **`blocked`** — phrases the diff must not contain, reported once per line
  per phrase (capped at 40 per phrase) with the printed line number — the
  only reason a deterministic check can report a line a model was never
  shown.
- **`architecture`** — forbidden dependency boundaries: layers (a name → a
  list of path globs) and edges (a `from` side that must not depend on a `to`
  side, each a layer name or a path glob). An import in the diff that crosses
  a forbidden edge is a finding with the printed line number and the
  evidence sentence — a deterministic check where the repository's own rules
  prove the violation, before any model is asked. Direction matters:
  `domain → infrastructure` fires only on `domain` importing `infrastructure`,
  never the reverse, never same-layer. `node:`/`https:` builtins and bare
  packages never resolve into the repo and can never fire; an intra-repo
  package boundary is caught with a glob (`packages/a/**` → `packages/b/**`)
  or an alias (`@/` → `src/`). Type-only imports count as edges — a type
  import is still a dependency. Capped at 40 findings per run.
- **`rules`** — the named rules a finding can cite, replacing the one
  built-in default rule (`dedup`, repeated code).
- **`tests`** — the opt-in test-aware pass (off by default; see below).

```yaml
# .github/reeve-rules.yml
version: 1
ignore:
  files: [docs/legacy.md]
  paths: ["vendor/**"]
generated: [".min.js", ".min.css", ".map"]
blocked:
  - phrase: "TODO-FIXME"
    severity: critical
    note: "Must be resolved before merge."
architecture:
  layers:
    domain: ["src/domain/**"]
    infrastructure: ["src/infra/**"]
  edges:
    - from: domain
      to: infrastructure
      severity: critical
      note: Domain must not depend on infrastructure.
  aliases:
    "@/": "src/"
rules:
  - id: dedup
    name: Repeated code
    marker: duplication
    body: Flag code that is repeated and could share one definition.
tests:
  enabled: true
  missing-severity: warning
  dangerous: ["encrypt", "decrypt", "payment", "checkout", "sql"]
```

The `tests:` section fires a deterministic **change-completeness** pass that
reads the test files in the base-branch checkout and reports coverage gaps the
diff itself proves:

- `tests-map` — a changed source file with additions but no covering test.
  Escalated to `critical` when the diff touches a `dangerous` marker
  (case-insensitive whole-word; the default list covers crypto, payments,
  filesystem writes, eval, and the like).
- `tests-only` — a modified or renamed test whose referenced production
  modules did not change in the same pull request. A regression test for code
  that never moved is a signal worth naming, not a claim of fault; a test that
  moved _with_ its code is a pair changing together, which is what a review
  wants to see.

A pure deletion never fires `tests-map` — an addition-free change introduces
no new untested behavior. Test discovery is bounded (`MAX_TEST_FILES`), and a
coverage claim a diff cannot prove stays silent (D5). When the pass is enabled,
its verdict line appears as the `Tests` row of the summary page.

A phrase like `TODO-FIXME` in the diff is a finding with a line number — one a
model could not be trusted to make about a line it was never shown, and one
this check can. A misspelled key is a warning, not a silent drop; a rules file
that yields no usable rule at all fails the run red, the same loudness the
warrant gives a file that does not parse.

## Verification: model findings against deterministic evidence

An admitted model finding is checked against evidence the diff already proves
before it is reported — a deterministic, in-process engine over what this run
already read, with no new model pass and no command execution. Two providers
establish evidence:

- **The claimed snippet vs the diff-proven line.** A finding that names a line
  is verified only when the exact text the model claimed (the `snippet` it was
  asked for) agrees with the text the patch proves at that line — trimmed, and
  accepting either side as a substring of the other. Agreement on significant
  text is the strongest evidence this duty has: `weight 1`, `verified`.
- **The cited rule exists.** When the repository's rules snapshot contains the
  rule the finding cites, the finding is _consistent with_ the rules the run
  read — `weight 0.6`, which alone never upgrades a finding past `unverified`.

A finding is `verified` only on actual deterministic evidence (`weight >= 1`).
**Model confidence is not an input**: a 0.99-confidence claim about a line
whose text the diff does not prove stays `unverified`, and no number from the
model upgrades absence. Evidence is bounded per finding and per run (8 items
per finding, 128 per run, 4096 detail chars per run); when a limit is reached
the evidence is truncated to the highest-weight items, never the finding
itself.

**Unverified findings are still shown** — with a `not verified` mark on their
line — and are never silently dropped. The run stays fail-closed: an
all-unverified review is still posted, because the alternative — the empty
chrome over a diff whose findings were all unverifiable — would be a false
clean. Deterministic pre-check findings (the marker rules above) need no
verification and carry no mark: they are always-right by construction.

**No commands are ever run.** Verification reads only the diff-proven lines
and the rules snapshot this run already read. `code.write` — running tests or
commands to confirm a claim — stays permanently forbidden; there is no
command-execution path in this duty at all.

## The context engine

A review that only ever sees the diff is a review in a vacuum. Beside the
diff, the run assembles a deterministic, bounded picture of the repository
around it — but never as another thing the model may invent findings about.
The context engine reads the workflow's own base-ref checkout (the same
`GITHUB_WORKSPACE` the rules file lives in, pinned the same way) and renders
what it finds into sections, in a fixed priority order, against one budget:

- **changed symbols** — the declarations the diff's added lines define or
  change (`function`/`class`/`interface`/`type`/`const`/`let`/`var` in
  TS/JS, `func`/`type` in Go, `fn`/`struct`/`impl` in Rust).
- **imports** — the base file's existing imports unioned with the ones the
  diff adds.
- **related tests** — files named like the changed file's tests, found by a
  fixed naming convention, never read and never quoted.
- **configuration** — the nearest ancestor `package.json`, `tsconfig.json`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`, `requirements.txt`, or
  `.eslintrc*`, from a fixed allowlist of names, quoted to 400 characters.
- **surrounding source** — the base-branch excerpt around each hunk's old-file
  line numbers, capped per file.
- **callers** — breadth-bounded directory walk looking for lines that mention
  a changed symbol, capped per symbol.
- **change history** — recent commit messages per changed file, capped.

Every read goes through `withinWorkspace` (a path outside the workspace is
refused before any path arithmetic) and `isSecretPath` (a segment denylist:
`.env`, `.env.*`, `.ssh`, `.npmrc`, `.netrc`, `id_rsa`, `*.pem`, `*.key`,
and `secret`/`credential`/`token`/`password` as whole words in a segment —
never in a source file's name like `tokens.ts`). Every read attempt is
counted, every section has a fixed cap, and hostiled-looking history is
truncated at the budget. Two runs over the same checkout and diff produce
byte-identical text.

**`max-context-chars` (default `12000`) budgets these sections only, not the
diff** — the diff already has `max-diff-chars`, and a section that does not
fit the whole-run context budget drops whole, never half-shows, with a
visible `… (context truncated: context sections cut)` mark. `none` removes
the bound.

**The context is evidence, never instructions, and findings stay
diff-proven.** It enters the model's prompt inside the same sanitising
boundary as the diff itself, framed as evidence about the repository. A
finding must still name one of the diff's files and one of the lines the
patch proves (`parseFinding` enforces this) — a file the context mentions
but the diff never showed cannot authorise a finding about itself. The
single model pass and the single owned summary comment are unchanged.

## Risk-based review depth

A small diff and a diff that rewires an auth boundary are not the same review.
`review` prices that deterministically before a model is asked anything: the
diff is scored against a risk profile — signal weights per trigger, path globs,
and `medium`/`high` score thresholds — and the price pays in how many passes
the model gets, not in what it may do.

- **low** — one standard pass.
- **medium** — a second, independent pass (`second-opinion`) that reads the diff
  fresh and prefers ground the first pass missed.
- **high** — the two above plus an adversarial verification pass, fed the
  earlier passes' findings as untrusted material and told to attack each one,
  reporting a finding again only when it survives.

Two rules outrank the score. A diff touching an auth path, a security-sensitive
path, or a DB migration is **high by policy**, however small. A diff with no
qualitative signal at all — no sensitive path, no dependency change, no
migration, no public API, no auth, no infra, no security material — is **low
by construction**, however many lines it moves. The passes' verdicts are merged
by identity (`rule:path:line`, first one wins), so three passes still produce
the same single owned comment and one finding per claim.

The profile is `.github/reeve-risk.yml`, read from the checkout and trusted the
same way `rules-path` is — it enters no prompt and carries no logic of its own.
It prices **depth** only: a hostile profile that sets every weight to 100 and
names files under a `capabilities:` key changes how many passes a diff gets,
and nothing it can say widens what the warrant grants. See
[Security considerations](#security-considerations).

## Unreadable output is no verdict

A model's answer is read strictly, and what does not parse is discarded, not
salvaged. A finding that names a file the diff never showed, or a line number
the patch cannot prove, is dropped — an anti-invention gate that refuses a
model's claim about a file nobody offered it. `finish_reason: length` is
treated as the protocol failure it is: an answer that ran out of room before
the JSON closed is unparseable the same as a malformed body. An unreadable
answer is recorded on the job summary as discarded, and it is never converted
into a verdict.

Two consequences follow. **Capacity is weather**: a model that fails on
capacity — a 429, a 5xx, a timeout — is rotated past, never retried, and a
roster that fails on all of them leaves `starved: true` without failing the
run. **An all-clear has to be earned**: if the diff had files to show and no
model produced a readable verdict — a capacity failure or an
injection-shaped answer — posting the empty chrome would stamp a diff nobody
actually reviewed as clean, which is precisely the false clean an injected
pull request is best served by. The comment is withheld instead; the job
summary still says what happened.

## Outputs

Every output `review/action.yml` declares.

| Output      | Value                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commented` | `true` when the single owned summary comment was posted or replaced this run. `false` on every other path — including one that reconciled findings but the warrant, the confidence floor, or `dry-run` withheld the write. Never unset; there is no update-in-place beyond this duty's own owned comment. |
| `note`      | Why this run stopped before a verdict, when it did — merged, closed, a draft under `trigger: pr`, or a Reeve proposal pull request. Empty when the run reached a verdict.                                                                                                                                 |
| `head-sha`  | The pull request's head SHA at review time. Empty when the run stopped before reading the pull request.                                                                                                                                                                                                   |
| `starved`   | `true` when every model in `models` failed on capacity this run. Weather, never a failure by itself.                                                                                                                                                                                                      |
| `findings`  | How many findings this run's reconciliation produced — created, persisted, changed, resolved and reopened combined. The summary comment, when one was posted, carries the same count.                                                                                                                     |
| `risk`      | `low`, `medium`, or `high` — the tier this diff was assessed at, and how many model passes it got. Empty when the run stopped before assessment.                                                                                                                                                          |

Inline threads are not an output — they are a write, like the comment itself.
The summary's `### Verdict` table carries a `Threads` row naming what the
sync did: how many threads were posted inline, how many updated in place, and
how many findings fell back to the summary because the API could not anchor
them at the current commit.

**`findings` is the output that matters most for a repository still tuning
`confidence`.** It is populated on every run that reached a verdict, whether
or not the floor or the warrant let the comment reach the pull request — so a
workflow can post the count to a review queue instead of the thread while you
watch how it does.

## Failure behavior

| What happened                                                                      | What you get                                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A blocked phrase was in the diff                                                   | Deterministic findings, `commented: true` when `comment` is granted   |
| Confidence below the floor                                                         | Findings reconciled and on the summary, `commented: false`, **green** |
| `comment` not granted                                                              | Findings on the summary, `commented: false`, **green**                |
| High-risk diff with fewer than two readable verdicts, or a failed adversarial pass | Comment withheld, summary says why, **green**                         |
| No readable verdict, files were shown                                              | Comment withheld, summary says why, **green**                         |
| Every file skipped by the rules file                                               | Comment withheld, coverage names each file and why, **green**         |
| Every model failed on capacity                                                     | `starved: true`, whatever survived, **green**                         |
| A draft under `trigger: pr`, merged, closed, a Reeve proposal PR                   | `note` set, no model asked, **green**                                 |
| The warrant or a readable rules file does not parse                                | **Red**, naming the file                                              |
| A referenced pack is missing, over-budget, or does not match its pin               | **Red**, naming the pack and the version it declares                  |
| The pull request cannot be read                                                    | **Red**                                                               |
| This duty's own comment could not be found with certainty                          | Comment withheld, **green**                                           |
| This duty's own threads could not be listed with certainty                         | Threads withheld, summary still posts, **green**                      |
| A finding's thread could not be anchored at the current commit (422)               | Finding falls back to the summary, **green**                          |
| The review-comment API is missing scope or denied                                  | **Red**, before the summary is written                                |

**The failure mode of this duty is a withheld write, never a wrong or a
doubled comment.** Every branch above ends without posting, or posts exactly
once — the same summary comment in place, replaced only when its findings
moved, and one owned inline thread per anchorable finding, never a second
copy of one.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and posts
nothing. The disposition a real run would have taken — `posted`, `replaced`,
`unchanged` — is rehearsed and printed to the log, and the job summary still
shows the full verdict, including the `Threads` row naming the inline threads
a real run would have written. `commented` is `false` on a dry run, because
nothing was written, and no thread is posted either. See [Rehearsing a
run](../../guides/dry-run.md).

## Cost

The risk tier prices how many passes read the diff: one correctness pass on a
low-risk diff, a second independent read on medium, and an adversarial
verification pass on top of that on high — and nothing repeats across
`synchronize` events: an event that changed nothing is recognised by the
marker's fingerprint and skipped at the write. The synthesis deduplicates the
same finding found by more than one pass (reported once, corroborated), ranks
by severity then corroboration then position, and annotates a contradiction
where two passes claim different things at the same line. An unreadable pass is
never dressed up as a readable empty answer: it is priced into the review's
confidence (10% off per pass that could not answer) and named in the summary,
exactly as loud as D5 asks. Every admitted model finding is then verified
against deterministic evidence before it is reported (see
[Verification](#verification-model-findings-against-deterministic-evidence)).

`max-diff-chars` (default `12000` for the whole run, `none` for no bound) is the
lever that bounds the total diff text a review may carry, and `endpoints`
spreads a roster across providers so a capacity failure demotes only the
`model@alias` that hit it. The context engine costs no provider requests — its
reads hit the checkout's disk only — but its assembled text enters the same
single prompt, so `max-context-chars` (default `12000`) is the second lever on
total prompt size. Risk prices the passes; the warrant prices the capabilities.
See [Cost](../../guides/cost.md) for the full arithmetic.

## Security considerations

- **The pull request's words sit inside a per-call random nonce boundary**,
  not a fixed delimiter. See [Security](../../security/security.md).
- **The diff is untrusted and framed as untrusted**: every line entered the
  prompt behind `enclose`, and a pull request that quotes "ignore this rule"
  at the model stays a quotation. Only the repository's own rules file enters
  unwrapped **— and its contents are pre-injected bare strings, never
  authority.** A path in `ignore:` matching a file is one skip among the
  diff's own facts, decided in code against the parsed file; the rules file's
  values and its `MAX_RULES_CHARS` (20,000) cap are documented in
  [Deterministic findings](#deterministic-findings-before-any-model), and a
  file's `blocked` phrases and `rules` enter the model's system prompt exactly
  as the maintainer wrote them — never as instructions the diff can act on
  alone. When a rules value would be the sole reason the review has nothing to
  say, the review is withheld rather than stamped clean (see
  [Failure behavior](#failure-behavior)).
- **Rule packs are the same shelf and the same boundary.** A pack is committed
  repo text read from the same pinned checkout, parsed by the same grammar,
  and it enters the prompt unwrapped like the rules file — but a pack can
  never grant authority: composition yields only rules, ignores, generated
  suffixes and blocked phrases, and a pack that names `duties:`,
  `capabilities:`, `warrant:` or `labels:` is refused red. Referenced packs
  are pinned and never optional, so a stale or missing pack is a red run, not
  a silent empty review (see [Rule packs](../rule-packs.md)).
- **The risk profile prices depth, and nothing else.** `.github/reeve-risk.yml`
  is committed repo text read from the same pinned checkout and parsed by the
  same grammar, and it can only choose how many model passes a diff gets —
  low, medium or high. It has no field for capabilities, a `capabilities:` key
  is refused with a warning, and no signal weight or path glob can widen what
  the warrant grants: a hostile profile at worst pays for more passes, which
  is a cost and never a capability (see
  [Risk-based review depth](#risk-based-review-depth)).
- **Repository context is read from the base-ref checkout only, through the
  workspace and secret gates.** The context engine reads nothing outside
  `GITHUB_WORKSPACE`, and every path passes `withinWorkspace` (traversal
  refused by segment) and `isSecretPath` (a segment denylist covering
  `.env*`, key material, and secret-named paths) before a byte is read. Its
  assembled text enters the prompt inside the same `enclose` boundary as the
  diff, framed as evidence — never as instructions — and a finding must still
  be proven by the diff, however vivid the surrounding source looks. See
  [The context engine](#the-context-engine).
- **The review summary comment and every inline thread are visibly
  machine-written, unconditionally.** The fixed closing line — "This review
  was written by a model, not decided by a maintainer — read each finding as
  a lead to check" — is unstrippable: there is no input, no
  `show-attribution`-style setting, that renders a comment without it, the
  same site rule as `respond`'s notice.
- **What it will never do:** edit code, open a fixing pull request, run a
  test suite, or otherwise touch the repository on the pull request's behalf;
  request changes on the review API or approve; post a second summary comment
  to a pull request it already owns; create a thread this duty does not own,
  update a thread whose marker it cannot verify as its own, or touch a thread
  a human wrote; overwrite a comment whose marker it cannot verify as its
  own; post without `comment` granted by the warrant; report a finding the
  diff cannot prove; hide, soften, or make removable the machine-written
  notice. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[The warrant](../../guides/warrant.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
