# Security policy

## Reporting a vulnerability

**Do not open a public issue.** This action runs inside other people's
repositories holding a token that can write to their issues and pull requests. A
public report hands every one of those repositories a working exploit before
there is anything to upgrade to.

Report privately through GitHub's
[security advisory form](https://github.com/ecoma-io/reeve/security/advisories/new).
If that is unavailable to you, email **john.itvn@gmail.com** with `SECURITY` in
the subject line.

Please include:

- what an attacker can do, and what they need in order to do it;
- the affected version, tag or commit;
- a reproduction — the smaller the better. A thread body that triggers the
  behaviour is the ideal report.

## What to expect

This project is maintained by one person, so these are honest targets rather
than a contractual guarantee:

| Stage                        | Target         |
| ---------------------------- | -------------- |
| Acknowledgement              | within 3 days  |
| Initial assessment           | within 7 days  |
| Fix or documented mitigation | within 30 days |

You will be told which of those applies as soon as the assessment is done,
including when the answer is that the report is not a vulnerability.

## Scope

In scope: this repository's source, the committed `dist/` bundle, `action.yml`,
and the build and release workflows — anything that decides what runs on a
consumer's runner.

Particularly in scope, because it is where this action's real risk lives:

- **anything a thread's title or body can make the action do** — prompt content
  that escapes its untrusted-data framing, or model output that reaches a
  comment without passing the sanitiser;
- **anything that lets a comment be written that a maintainer did not intend** —
  a marker forged from injected text so the action edits the wrong comment, a
  container closed early so injected Markdown escapes the collapsed block, a
  `@mention` that survives to notify people on every re-run;
- **anything that leaks the configured `api-key`** into logs, into a comment, or
  into a request to a host other than the configured `base-url`.

Out of scope:

- vulnerabilities in third-party dependencies with no exploitable path through
  this action — report those upstream;
- a consumer's own workflow being misconfigured in a way this repository's
  documentation warns against. The clearest example: checking out
  `github.event.pull_request.head.sha` inside a `pull_request_target` workflow.
  That is a real vulnerability in **their** repository, and
  [the README says not to](README.md#security) — but it is not a defect in this
  action. Tell them, not us.
- **a duty deciding wrongly.** A wrong label or a bad translation is a bug,
  sometimes a serious one, and it belongs in a public issue where it can be
  discussed. It is not a security report. A duty acting **outside its warrant**
  is the opposite: that is exactly a security report.

## A note on which providers you point this at

The `base-url` and the models behind it are your choice, and everything this
action sends goes to them: the title and body of every thread it runs on. That
data flow is inherent to the feature rather than a flaw in it, so it is not a
vulnerability report — but if you find that the action sends more than that, or
sends it somewhere other than the configured endpoint, that very much is.

## Verifying a release

What your runner actually executes is `dist/index.js`, a bundle far past what
anyone reads before pinning. Every release that carries assets ships two of
them: `reeve-action.tar.gz`, holding exactly the `dist/`, `action.yml`,
`LICENSE` and `README.md` of that tag, and `reeve-action.intoto.jsonl`, a
SLSA provenance attestation signed through Sigstore.

The attestation is the useful half. It records which workflow, in which
repository, at which commit produced those exact bytes — a claim you can check
without trusting anything this repository says about itself:

```bash
gh release download <tag> --repo ecoma-io/reeve \
  --pattern 'reeve-action.*'

slsa-verifier verify-artifact reeve-action.tar.gz \
  --provenance-path reeve-action.intoto.jsonl \
  --source-uri github.com/ecoma-io/reeve \
  --source-tag <tag>
```

The archive is built reproducibly — sorted entries, zeroed ownership,
normalised permissions, and every mtime pinned to the tagged commit's own
timestamp — so you can rebuild it from the tag and get the same sha256 the
attestation covers. That is what makes the signature checkable rather than
merely present.

Releases 0.1.0 and 0.2.0 predate this and carry no assets. Verify those by
comparing `dist/index.js` at the tag against a local `pnpm install && pnpm
build`, which is the same property CI enforces on every pull request.

## Disclosure

Fixes are released before details are published. Because consumers pin a
floating major tag, a fix is only actually delivered once that tag moves —
so an advisory is published after the release workflow has moved it, not before.

Credit goes to the reporter unless you ask otherwise.
