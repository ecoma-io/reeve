## Description

<!-- What changes, and why. Link the issue this closes. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New capability in the core (provider / warrant / score / judge / sanitize / memory / publish)
- [ ] New or changed duty
- [ ] Provider or protocol handling
- [ ] Breaking change (a consumer must edit their workflow file to upgrade)
- [ ] Documentation
- [ ] Build, CI, or repository tooling

## Consumer impact

<!-- Consumers pin a floating major tag, so whatever lands here reaches them on
their next run with no version bump they chose. `action.yml` is the breaking
surface: an input renamed, a default changed, an accepted value narrowed, an
output whose meaning moved. Say what a consumer sees. Write "none" if nothing
changes for them, and say so explicitly rather than leaving it out. -->

- [ ] No change to `action.yml` — no input, default, or output moved
- [ ] `action.yml` changed, and the change is described above

## Behaviour when things go wrong

<!-- Delete this section only if the change touches nothing in the pipeline.
This is the section a reviewer reads first: the interesting question is never
what happens when the model behaves. -->

- [ ] A provider failure (non-2xx, timeout, HTML, or an error object inside a 200) is handled, and the next model is tried
- [ ] Model output that is not the demanded shape is rejected rather than parsed optimistically
- [ ] Every model failing produces a loud, red result — never a silent no-op
- [ ] Nothing new is written to a thread without passing the sanitiser
- [ ] Nothing acts outside the warrant, and the check reads the file rather than the model's claim
- [ ] No new logging path can print the configured `api-key`

## Generality

<!-- Reeve is general; it is not designed around the repository that maintains
it. And the core belongs to every duty — see docs/north-star.md. -->

- [ ] Nothing here special-cases the repository that maintains it, and any project-specific rule is derived from a file the consumer wrote
- [ ] Nothing here assumes a strong model, a paid tier, or a specific provider beyond the OpenAI chat-completions protocol
- [ ] Nothing a duty needs was added to the core that another duty could not use

## How this was verified

<!-- What you actually ran and saw, not what should happen. -->

**Steps:**

1.
2.

- [ ] Unit tests added or updated (`pnpm test`)
- [ ] Failure cases covered, not only the success case
- [ ] Exercised end to end against a real thread with `dry-run: true`, and the log is quoted above

## Bundle

- [ ] `pnpm build` was run and `dist/` is committed in this pull request
- [ ] The `dist/` diff is generated output only — no hand edits

## AI-assisted development

- [ ] This pull request is AI-assisted (drafted or substantially written by an AI coding agent)
- [ ] Each such commit carries its disclosure trailer: `Assisted-by: <tool>`, or `Generated-by: <tool>` where the tool produced substantially the whole commit

<!-- Name the tool and model, e.g. "Claude Code, opus". A description can be
edited later and no clone carries it — the commit trailer travels with the code. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm format:check` all pass locally
- [ ] I have self-reviewed this diff
- [ ] Documentation is updated in the same pass as the behaviour it describes
- [ ] No unrelated changes are included
- [ ] I have the right to contribute this work under the Apache License 2.0
