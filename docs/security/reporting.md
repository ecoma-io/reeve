# Reporting a vulnerability

_How to report a security problem privately, and where the full policy lives. Prerequisites: None._

**Do not open a public issue.** This action runs inside other people's
repositories holding a token that can write to their issues and pull
requests. A public report hands every one of those repositories a working
exploit before there is anything to upgrade to.

Report privately through GitHub's
[security advisory form](https://github.com/ecoma-io/reeve/security/advisories/new).

Everything else — the fallback channel, what to include, response targets,
scope, how to verify a release's provenance, and the disclosure timeline —
lives in one place, in the repository root where GitHub's own Security tab
expects to find it: the root `SECURITY.md`. That file is the policy; this
page only routes you to it, so the two can never disagree.

For why the pipeline is shaped the way it is, see
[Threat model](threat-model.md) and [Security](security.md).

---

**Related:** [Threat model](threat-model.md) · [Security](security.md) ·
the root `SECURITY.md`
