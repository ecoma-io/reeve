# Troubleshooting

A run went red, went green and did nothing, or did something you did not expect.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## First: green and red mean specific things

Reeve fails red for exactly two reasons: **a configuration it cannot act on**,
and **a thread it cannot read**. Both are things you can fix.

Everything else — a model with no quota, a verdict that did not parse, a language
nobody could translate — is a warning, an output, and a green job. That is
deliberate: a run that went red over one language would take the others down with
it, and a duty whose ordinary bad day is red teaches you to stop reading its
results.

So: **a green run that did nothing is usually a correct answer**, and the outputs
say which answer it was.

## Green, but nothing happened

| Output that is set                    | What it means                                                              | What to do                                                             |
| ------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `screened-out` non-empty              | The cheap pass decided this was not worth a careful read.                  | Read the reason. If it is wrong, that is a screening bug — file it.    |
| `proposed` non-empty, `labels` empty  | The verdict was below `confidence`, or named labels your warrant does not. | Compare the two arrays. The difference is what the guardrails stopped. |
| `translated: []`, `skipped` non-empty | No model produced a usable draft for those languages this run.             | Check the log for the per-model reasons. Usually quota.                |
| Nothing set, no log activity          | The fingerprint already matched.                                           | Working as intended — see below.                                       |

### "It ran, but the body did not change"

The marker in the body carries a fingerprint of what the last run did. A run that
computes the same fingerprint stops before it constructs a provider.

That is what makes the `edited` trigger safe and a backfill affordable. If you
genuinely want the work redone, **delete the block** — everything from the marker
down — and the next run regenerates it.

Model ids and `drafts` are deliberately not in the fingerprint. Changing them does
not retranslate your repository, and that is on purpose.

### "It labelled nothing, and the log shows a verdict"

Read `proposed` against `labels`.

- A label in `proposed` and not in `labels` was **refused by the warrant** — the
  taxonomy does not name it, or `exclusive_with` knocked it out.
- Both empty with a `confidence` below your floor means the model was not sure
  enough. Lower the floor only after [measuring](../development/evaluation.md)
  what that costs in precision.

## Red

### `models` is required

The only input with no default. Everything else, including the token, has one.

### The event names no thread

```
this event names no issue or pull request; pass `number` explicitly
```

A `schedule`, a `push` or a bare `workflow_dispatch` has no thread attached.
Either trigger on `issues` / `issue_comment` / `pull_request_target`, or pass
`number`. Reeve fails here rather than asking GitHub for issue `NaN`.

### The warrant does not parse

```
.github/reeve.yml: could not be parsed
```

This is the one place Reeve fails red over a file rather than warning. Every
guardrail is defined in terms of that file, and a run with no allowlist is not a
safer run — it is an unbounded one. Fix the YAML.

### The warrant names a label that does not exist

```
.github/reeve.yml names `needs-repro`, which is not a label in this repository
```

Usually a rename. The error names both sides on purpose: the alternative is a
verdict whose labels are all silently dropped at the apply stage, which looks
exactly like a model that never agreed with anything.

### The thread cannot be read

Almost always permissions. Check the job's `permissions:` block:

| Working on     | Needs                  |
| -------------- | ---------------------- |
| Issues         | `issues: write`        |
| Pull requests  | `pull-requests: write` |
| Reading files  | `contents: read`       |
| Writing memory | `contents: write`      |

On a fork's pull request under plain `pull_request`, the token is read-only no
matter what the block says. Use `pull_request_target` and read
[Installation](installation.md#pull-requests) before you do.

## Provider problems

Every provider failure is reported per model, with the HTTP status as context and
never as the verdict. Gateways and free tiers routinely answer `200` with an
error in the body, and just as routinely answer a non-2xx with an HTML page — so
the body is parsed first.

| Reason in the log                     | What it usually is                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `body was not JSON — <!DOCTYPE html…` | A gateway error page, a wrong `base-url`, or a path with `/chat/completions` already on it.                                   |
| `provider reported an error — …`      | Quota, an unknown model id, or a rejected field. The message is the provider's own.                                           |
| `message content was not a string`    | A reasoning model that put everything in `reasoning_content`, or a provider returning content parts. Rotate to another model. |
| `answered with empty content`         | The model returned nothing usable. Rotation handles it.                                                                       |
| `request timed out after 120000ms`    | A slow free tier. Give it more models rather than a longer timeout.                                                           |

**A model is rotated past, never retried.** If every model in your list failed,
the log names each attempt in order. That list is your budget — a keyless
configuration should have more entries than you think it needs.

### `base-url` shape

Give the endpoint **without** the trailing `/chat/completions`:

```yaml
base-url: https://api.openai.com/v1 # right
base-url: https://api.openai.com/v1/chat/completions # wrong
```

## Language problems

### It detected the wrong language

Detection runs on the _prose residue_ — the text left after URLs, e-mail
addresses, bare domains and digit-bearing tokens are blanked, because those are
written the same everywhere.

A thread that is mostly a stack trace has almost no residue. That is the case
where detection is genuinely hard, and where `unknown` is the honest answer.

- **If your languages share a script** (`en` and `vi`, both Latin), detection may
  reach the model. Check that every code you configured is on
  [the profile list](languages.md#which-languages-the-free-step-knows) — one code
  outside it disables the free profile step for the whole run.
- **If you used a regional tag**, `pt-BR` is not `pt` here. Put the region in the
  label instead: `pt:Português (Brasil):Latin`.

### `source-language` is empty

None of your configured languages wrote the thread. This is an answer, not an
error: a German issue in an `en, vi, zh` repository gets all three translations,
because there is nothing to leave out.

### A duty did worse in one language than another

This is a bug, and it is the specific bug this project exists to not have. File
it with the thread in both languages if you can — the
[duty quality template](https://github.com/ecoma-io/reeve/issues/new?template=duty_quality.yml)
has fields for exactly that.

## Behaviour that looks like a bug and is not

**A translated `#42` does not link, and `@alice` does not notify.** References in
_machine output_ are defanged on purpose. On a backfill, a few hundred unwanted
pings is how a translation bot gets uninstalled. The author's own `#42` still
links and their `@alice` still notifies, because their half is never rewritten.

**HTML comments in machine output come back as `<!---------->`.** Every character
between the delimiters is overwritten so injected text cannot forge the marker
Reeve anchors on. The length is kept rather than the bytes deleted, so two runs
cannot disagree about where the code fences are.

**A draft was thrown out and the log said "still in the source language".** A
cheap endpoint's most common failure is returning the input, or leaking a phrase
of a third script into the answer. Both score perfectly on everything else, so
they are refused outright rather than ranked.

**The label did not trigger my other workflow.** A label applied by
`GITHUB_TOKEN` does not start a workflow listening on `issues: [labeled]`. GitHub
suppresses it to prevent recursion, silently. Pass a GitHub App token from
`actions/create-github-app-token`. More in
[platform limits](../development/platform-limits.md).

## Still stuck

Open an issue with the workflow file, the run log with the API key still masked —
it is registered as a secret before anything can log it — and what you expected.

Never a public issue for a vulnerability: [SECURITY.md](../../SECURITY.md) has
the private channel.
