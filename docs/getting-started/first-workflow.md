# A complete first workflow

_Walk a complete two-duty workflow end to end. Prerequisites: [Installation](installation.md)._

One provider, one version line, two duties — level 0 with a second duty added,
nothing more.

```yaml
name: Reeve

on:
  issues:
    types: [opened, reopened, edited]

concurrency:
  group: reeve-issue-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/triage@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini

  translate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/translate@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
# `languages` is not an action input — the languages to translate
# into live under the warrant's `languages:` key. See
# ../reference/duties/translate.md.
```

Both jobs trigger off the same event and run independently — `triage` never
waits on `translate`, and either can fail or rotate through its model list
without touching the other. Each keeps its own inputs: `triage` reads nothing
about the warrant's languages, and `translate` reads nothing about a taxonomy,
because neither is meaningless to the other's job.

An issue opened against this workflow gets sorted against the labels your
repository already has, and gets a translated block appended below its own
text in every language the warrant's `languages:` key names — without either
duty being told anything about what the other decided.

**Climbing the ladder from here means writing things down, not switching
anything on:** decide what each duty is allowed to do —
[The warrant](../guides/warrant.md) — and who reads what —
[Languages](../guides/languages.md).

---

**Related:** [The warrant](../guides/warrant.md) · [Languages](../guides/languages.md)
**Next:** [The warrant](../guides/warrant.md) — write down what each duty may do before you turn on more than the default
