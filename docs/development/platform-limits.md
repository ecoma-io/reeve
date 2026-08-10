# Platform limits

GitHub behaviours that shaped the design. Each one is here because a decision
elsewhere in this repository is only explicable if you know about it.

Claims are marked **documented** (GitHub says so), **measured** (we checked), or
**inferred** (neither, and treated as a risk).

## 1. A `GITHUB_TOKEN` write does not trigger a workflow

**Documented.** Events raised by the ambient `GITHUB_TOKEN` do not start
workflows. GitHub does this to prevent recursion, and it does it **silently** —
no warning, no annotation, no trace in the run that caused it.

**What it shapes:**

- A consumer whose downstream workflow listens on `issues: [labeled]` will never
  see Reeve's label. The usage docs say so, and the fix is a GitHub App token
  from `actions/create-github-app-token`.
- **Idempotency is not allowed to rely on it.** Writing a body fires `edited`,
  which would start a run — except under `GITHUB_TOKEN`, where it does not. A
  consumer passing a PAT or an App token gets no such protection, and plenty of
  them do. So the loop is stopped by the marker's fingerprint, in Reeve's own
  code, which works under every token.

That second point is the one worth carrying: **any protection GitHub gives only
to `GITHUB_TOKEN` is not a protection Reeve may depend on**, because the token is
the consumer's choice.

## 2. `issues: write` cannot be subdivided

**Documented.** Applying a label, posting a comment, closing a thread and editing
a body are all `issues: write`. There is no narrower scope.

**What it shapes:** the entire warrant. A consumer who wants labels-only cannot
express it to GitHub, so Reeve has to express it — in a file, enforced in its own
code. Capabilities are not defence in depth here; they are the only mechanism.

The same applies to `pull-requests: write`.

## 3. `pull_request` from a fork has a read-only token and no secrets

**Documented.** A workflow triggered by `pull_request` on a fork's branch gets a
read-only token and no access to repository secrets.

**What it shapes:**

- Duties that write to a pull request must be triggered by `pull_request_target`,
  which runs against the **base** ref with a full token.
- That is safe here only because nothing from the PR head is checked out or
  executed. It stops being safe the moment a workflow adds
  `ref: github.event.pull_request.head.sha` to a checkout, which is the obvious
  edit when something else in the job needs the code.
- **The evaluation harness cannot be a required check.** It needs a provider key;
  a fork's pull request has no secrets; a required check that cannot pass on a
  fork closes the project to contributors. See
  [evaluation](evaluation.md#running-it).

## 4. An issue body has a hard length ceiling

**Documented.** GitHub rejects an issue or comment body over 65,536 characters
with a `422`.

**What it shapes:** a duty that appends to a body is appending to something with a
budget, and the author's half is not Reeve's to shrink.

- Input is bounded by `max-body-chars`, measured against the author's half only —
  the block a previous run wrote never eats into it.
- When the author's text is longer than that, the tail is left behind and the
  published block **says so** rather than pretending otherwise.
- The fingerprint is over the part that was actually read, so raising the limit
  later translates the rest instead of recognising its own claim and stopping.

A body that would exceed the ceiling after the block is added is a real case with
no good answer. Currently it fails loudly rather than truncating a person's text.

## 5. Comment listing is paginated, and a thread can be long

**Documented.** The comments endpoint returns at most 100 per page.

**What it shapes:** one run reads the most recent hundred replies and **warns when
there were more**, so a very long thread is handled from its newest end rather
than silently in part. Walking every page of a thousand-comment thread on every
`issue_comment` event would spend the rate limit on threads nobody is reading.

## 6. Review comments are not issue comments

**Documented.** A pull request's review comments — the ones attached to lines of
the diff — live on a different endpoint from its conversation comments.

**What it shapes:** they are deliberately excluded. A translation appended to a
line comment moves the review conversation away from the line it is about, which
is worse than not translating it. This is a product decision that the API shape
made easy to hold.

## 7. GitHub strips empty HTML comments before autolinking

**Measured**, against GitHub's own renderer, not assumed.

`@a<!---->lice` renders as `@alice` with no link and no notification. `#<!---->42`
renders as `#42` with no link.

**What it shapes:** the entire reference-defanging strategy. Nothing is deleted
and nothing is escaped — the reader sees exactly the words the model wrote, and
nobody is notified. Escaping would be visible; deleting would change the text.

Also measured: GitHub does not autolink inside a code fence or span, so nothing
in one is touched.

**Risk, and it is real:** this is renderer behaviour, not a documented contract.
It could change. If it does, the failure is unwanted notifications rather than
anything unsafe, and the test that would catch it is a rendering test rather than
a unit test.

## 8. Markdown structures Reeve must not break

**Measured.** GitHub reads meaning out of a body that plain Markdown does not:

| In a body                    | GitHub does                                         |
| ---------------------------- | --------------------------------------------------- |
| `Fixes #42`                  | Links the issue to the PR                           |
| `- [ ]` items                | Counts them as a task list                          |
| `Co-authored-by:`            | Attributes a commit                                 |
| An issue template's headings | Feeds forms and search                              |
| The first paragraph          | Becomes the link preview and the project-board card |

**What it shapes:** the author's text is kept **first and byte-for-byte**, and the
machine's block goes below it. Every one of the behaviours above keeps working,
and the references in the author's half keep linking and notifying — because that
half is never rewritten or defanged.

It is also why a duty writes into the body at all rather than leaving a comment: a
comment is read after the body, and the body is the only thing that appears in a
search result, a link preview and a board card.

## 9. `<details>` is the only collapsible, and it can be closed early

**Measured.** A published translation lives inside a `<details>` section. A model
that emits `</details>` mid-answer closes the section early and spills the rest of
the block out of it.

**What it shapes:** scoring **refuses** such a draft rather than sanitising it.
The two cases are told apart by balance, not by the tag: a draft that opened its
own section is reproducing the source and is correct, while a closer with no
opener before it is reaching outside the draft.

## 10. An action can live in a subdirectory; the Marketplace only sees the root

**Documented.** `uses: owner/repo/path@ref` resolves an action from
`path/action.yml`. The Marketplace listing, however, comes from an `action.yml` at
the repository root.

**What it shapes:** the one-repository-several-duties layout. Consumers get one
version line and one core; the cost is that individual duties are not separately
listed on the Marketplace. That trade was made deliberately — see
[architecture](architecture.md).

## 11. `runs.using` pins a Node major, and the bundle must be committed

**Documented.** A JavaScript action declares `runs: using: node24, main:
dist/index.js`, and the runner executes that file as-is. There is no install step
and no build step on the consumer's runner.

**What it shapes:**

- `dist/` is committed, and CI fails when a rebuild produces a diff. A tag whose
  `dist/` does not match its source is a release that runs old code.
- Dependencies are bundled, so a dependency change is visible in the committed
  bundle's diff.
- The Node major is a breaking change for consumers on older runners, and moves
  on its own schedule rather than with a dependency bump.

## 12. Rate limits, and the one that is not the obvious one

**Documented.** `GITHUB_TOKEN` gets 1,000 requests per hour per repository for
most endpoints. That is rarely the binding constraint.

The one that bites is the **secondary rate limit on content creation**: rapid
successive writes to issues get throttled with a `403` that is not a permissions
error. A backfill that writes to two hundred threads as fast as it can will hit
it.

**What it shapes:** the same-answer check matters more for rate limits than for
money. A second pass over a backfill makes one read per thread and no writes, so
it does not approach either limit.

**Inferred, and treated as a risk:** exactly where the secondary limit sits is not
published and changes. A backfill should be paced by the consumer's workflow —
Reeve does not sleep on their runner's clock.

## 13. `concurrency` cancels, and a cancelled run is not a failed one

**Documented.** `cancel-in-progress: true` cancels the in-flight run when a new
one starts for the same group.

**What it shapes:** the recommended workflows all set a per-thread concurrency
group. A rapid edit supersedes the previous run, and only the newest text is worth
spending calls on. A cancelled run leaves the thread exactly as it found it,
because nothing is written until the publish stage.

## 14. Some events name no thread

**Measured.** `schedule`, `push` and a bare `workflow_dispatch` carry no issue or
pull request in the payload.

**What it shapes:** a duty with no `number` and no thread in the event **fails and
names the event**, rather than asking GitHub for issue `NaN` and reporting a 404
as if the thread had been deleted.

---

## Adding to this page

One entry per behaviour, with the mark. If a claim is **measured**, say what was
measured against — GitHub's renderer, a real API response, a run — because the
next person to touch that code will want to re-measure it rather than trust a
sentence.

If a behaviour turns out to have changed, the entry stays and gains a date. A
constraint that used to exist explains a decision that still does.
