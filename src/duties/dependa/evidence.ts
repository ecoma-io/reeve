/**
 * Evidence gathering and enclosure for `dependa`.
 *
 * External metadata — changelogs, release notes, package descriptions,
 * security advisory text — is *evidence*, never *authority*. The distinction
 * is load-bearing: a changelog that says "breaking change" is evidence that
 * an update is risky, but it is not authority to skip the update; that
 * decision belongs to the policy. A security advisory is evidence that an
 * update is important, but it does not force dependa to propose it.
 *
 * Every piece of evidence is:
 * 1. **Attributed** — carries a `source` URL or path so a maintainer can
 *    verify it.
 * 2. **Sanitised** — passed through `core/sanitize.ts` before any model
 *    sees it, and again before any publication.
 * 3. **Marked** — `deterministic: true` when it came from a registry API,
 *    `deterministic: false` when a model summarised or interpreted it.
 * 4. **Length-capped** — evidence longer than `MAX_EVIDENCE_CHARS` is
 *    truncated so it cannot exhaust a model's context or a PR body.
 *
 * Evidence is enclosed using `core/enclose.ts` before any model call — the
 * same boundary every other duty draws around untrusted content. A changelog
 * is stranger input until proven otherwise: it was written by someone the
 * maintainer has no reason to trust, and it is being fed into a model that
 * might treat it as instruction.
 */
import { enclose, type Enclosed } from "../../core/enclose.js";
import { sanitize } from "../../core/sanitize.js";
import type { Evidence, Release, SecurityAdvisory } from "./model.js";

/** Evidence longer than this is truncated. */
const MAX_EVIDENCE_CHARS = 4000;

/**
 * Build evidence from a release's changelog or release notes.
 *
 * Fetches the content (the caller provides the fetched text — this module
 * does no network calls), sanitises it, caps its length, and wraps it in
 * an Evidence object.
 */
export function fromChangelog(url: string, content: string, deterministic: boolean): Evidence {
  return {
    kind: "changelog",
    source: url,
    content: cap(sanitise(content)),
    deterministic,
  };
}

/**
 * Build evidence from a GitHub release.
 */
export function fromGithubRelease(url: string, content: string): Evidence {
  return {
    kind: "github-release",
    source: url,
    content: cap(sanitise(content)),
    deterministic: true,
  };
}

/**
 * Build evidence from a security advisory.
 *
 * Security advisories are always deterministic — they come from a registry
 * API or a GitHub advisory database, never from a model.
 */
export function fromSecurityAdvisory(advisory: SecurityAdvisory): Evidence {
  return {
    kind: "security-advisory",
    source: advisory.id,
    content: cap(
      `[${advisory.id}] ${advisory.severity.toUpperCase()}: ${advisory.summary}` +
        (advisory.patchedVersions !== null ? `\nPatched in: ${advisory.patchedVersions}` : ""),
    ),
    deterministic: true,
  };
}

/**
 * Build evidence from a commit log (list of commits between versions).
 */
export function fromCommitLog(compareUrl: string, content: string): Evidence {
  return {
    kind: "commit-log",
    source: compareUrl,
    content: cap(sanitise(content)),
    deterministic: true,
  };
}

/**
 * Gather evidence from a list of releases between current and target.
 *
 * Returns one Evidence per release that has a changelog or release notes URL,
 * plus one for any security advisory. Does NOT fetch URLs — the caller must
 * fetch and pass the content.
 *
 * When `fetchedContent` is provided (a map from URL to fetched text), the
 * evidence includes the full content. When a URL has no entry in the map,
 * the evidence is still created but with an empty content string — the URL
 * itself is still evidence, even if the text was not fetched.
 */
export function gather(
  releases: readonly Release[],
  securityAdvisory: SecurityAdvisory | null,
  fetchedContent: ReadonlyMap<string, string>,
): readonly Evidence[] {
  const evidence: Evidence[] = [];

  for (const release of releases) {
    const url = release.changelogUrl ?? release.diffUrl;
    if (url !== null) {
      const content = fetchedContent.get(url);
      if (content !== undefined) {
        evidence.push(fromChangelog(url, content, true));
      } else {
        // URL exists but content was not fetched — still evidence
        evidence.push({
          kind: "changelog",
          source: url,
          content: "",
          deterministic: true,
        });
      }
    }
  }

  if (securityAdvisory !== null) {
    evidence.push(fromSecurityAdvisory(securityAdvisory));
  }

  return evidence;
}

/**
 * Enclose evidence for a model prompt.
 *
 * All evidence is fenced inside a single `enclose()` boundary, so the model
 * is told where the untrusted content starts and stops. Evidence is joined
 * with clear attribution — the model can see what came from where, but it
 * cannot treat evidence as instruction.
 */
export function encloseEvidence(evidence: readonly Evidence[]): Enclosed | null {
  if (evidence.length === 0) return null;

  const parts = evidence.map((e) => {
    const header = `[${e.kind}] Source: ${e.source}${e.deterministic ? "" : " (model-derived)"}\n`;
    return e.content.length > 0 ? `${header}${e.content}` : header;
  });

  return enclose("dependa-evidence", parts.join("\n\n---\n\n"));
}

/**
 * Render evidence for a PR body.
 *
 * Unlike `encloseEvidence` (which fences for a model), this renders for a
 * human reading a pull request. Each piece of evidence is a collapsible
 * section with its source URL and content.
 *
 * Evidence content is sanitised for PR publication: HTML tags are escaped
 * to prevent injection, and Markdown links are defanged so they render as
 * plain text rather than clickable links from untrusted sources.
 */
export function renderForPr(evidence: readonly Evidence[]): string {
  if (evidence.length === 0) return "";

  const sections = evidence.map((e) => {
    const label = e.kind.replace(/-/g, " ");
    const attribution = e.deterministic ? "" : " *(model-derived)*";
    const safeSource = escapeMarkdown(e.source);
    if (e.content.length === 0) {
      return `- **${label}**: ${safeSource}${attribution}`;
    }
    return (
      `<details><summary><strong>${label}</strong>: ${safeSource}${attribution}</summary>\n\n` +
      `${escapeMarkdown(e.content)}\n\n</details>`
    );
  });

  return `### Evidence\n\n${sections.join("\n\n")}`;
}

/**
 * Escape text for safe inclusion in a Markdown PR body.
 *
 * Strips HTML tags and defangs Markdown links from untrusted content so
 * they cannot be used for injection or phishing. Intentionally conservative:
 * evidence is rendered as plain text within a details block, so losing
 * formatting is acceptable — safety is not.
 */
export function escapeMarkdown(text: string): string {
  return (
    text
      // Defang Markdown images: ![alt](url) → alt (url)
      .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
      // Defang Markdown links: [text](url) → text (url)
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
      // Escape angle brackets first — prevents both complete (<script>)
      // and incomplete (<script) HTML element injection
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  );
}

/** Sanitise evidence text — defang references and empty HTML comments. */
function sanitise(text: string): string {
  return sanitize(text);
}

/** Cap evidence text to `MAX_EVIDENCE_CHARS`, with a truncation marker. */
function cap(text: string): string {
  if (text.length <= MAX_EVIDENCE_CHARS) return text;
  return text.slice(0, MAX_EVIDENCE_CHARS) + "\n\n[… truncated]";
}
