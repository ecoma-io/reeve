# Reporting a vulnerability

_How to report a security problem privately, and where the full policy lives. Prerequisites: None._

**Do not open a public issue.** This action runs inside other people's
repositories holding a token that can write to their issues and pull
requests. A public report hands every one of those repositories a working
exploit before there is anything to upgrade to.

Report privately through GitHub's
[security advisory form](https://github.com/ecoma-io/reeve/security/advisories/new).
If that is unavailable to you, email **john.itvn@gmail.com** with `SECURITY`
in the subject line.

Please include:

- what an attacker can do, and what they need in order to do it;
- the affected version, tag or commit;
- a reproduction — the smaller the better. A thread body that triggers the
  behaviour is the ideal report.

Acknowledgement targets within 3 days, an initial assessment within 7, and a
fix or documented mitigation within 30 — honest targets from a project
maintained by one person, not a contractual guarantee.

## The full policy

Scope, what is out of scope, how to verify a release's provenance, and the
disclosure timeline all live in the repository root, where GitHub's own
Security tab expects to find them: [`SECURITY.md`](../../SECURITY.md).

For why the pipeline is shaped the way it is, see
[Threat model](threat-model.md) and [Security](security.md).

---

**Related:** [Threat model](threat-model.md) · [Security](security.md) ·
[`SECURITY.md`](../../SECURITY.md)
