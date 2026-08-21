/**
 * Locale-aware link rewriting for the `harmonise` duty.
 *
 * A translated document that keeps its links pointing at the source-language
 * files sends the reader back to a language they just chose to leave. When a
 * locale variant of the linked file exists, the translation should link to it:
 *
 *   [guide](docs/getting-started.md)   → [guide](docs/getting-started.vi.md)
 *   ![flow](images/flow.png)           → ![flow](images/flow.vi.png)
 *
 * The rule is deliberately conservative — a link is rewritten only when the
 * locale variant is **known to exist**: it is in the repository tree already,
 * or it is one of the files this same sync writes (the same pull request, so
 * the two land together). A link whose variant does not exist is left alone;
 * a working link to the source language beats a broken link to the target.
 *
 * What is never touched:
 * - external URLs (`https://…`, `mailto:…`, any scheme) and protocol-relative
 *   `//host` links — those are not files in this repository;
 * - pure fragments (`#section`);
 * - links that already carry a locale suffix (`guide.zh.md`) — a deliberate
 *   cross-locale reference is a decision, not an oversight;
 * - anything inside code fences or inline code spans, via `core/markdown`'s
 *   segmentation — code is preserved byte for byte everywhere in this duty.
 */
import { segments } from "../../core/markdown.js";

/** What `localiseLinks` needs to know about one rewrite pass. */
export interface LinkContext {
  /** The target locale code, exactly as it appears in file suffixes. */
  readonly locale: string;
  /** The path of the document being written — relative links resolve against its directory. */
  readonly docPath: string;
  /** Whether a repository-relative path exists (or will exist after this sync). */
  readonly exists: (path: string) => boolean;
}

/**
 * The same locale-suffix shape `discover.ts` matches file paths against,
 * anchored to the tail of a link target: `.<locale-code>.<ext>`.
 */
const LOCALE_SUFFIX = /\.[a-z]{2,3}(?:-[A-Z][a-zA-Z]+)?\.[a-zA-Z0-9]+$/;

/** Image extensions worth looking for a locale variant of. */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|svg|webp)$/i;

/** Inline links and images: `[text](target)` and `![alt](target "title")`. */
const INLINE_LINK = /(!?\[[^\]]*\]\()\s*(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\s*\))/g;

/** Reference-style definitions: `[id]: target` at the start of a line. */
const REFERENCE_DEF = /^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)(.*)$/gm;

/**
 * Rewrites internal Markdown links and images to their locale variants.
 *
 * Only prose is rewritten — fenced blocks and inline code spans pass through
 * verbatim, using the same segmentation the chunker relies on (concatenating
 * segments reproduces the input byte for byte).
 */
export function localiseLinks(markdown: string, context: LinkContext): string {
  return segments(markdown)
    .map((segment) =>
      segment.kind === "prose" ? rewriteProse(segment.text, context) : segment.text,
    )
    .join("");
}

function rewriteProse(prose: string, context: LinkContext): string {
  const rewritten = prose.replace(
    INLINE_LINK,
    (whole, open: string, target: string, close: string) => {
      const next = rewriteTarget(target, context);
      return next === null ? whole : `${open}${next}${close}`;
    },
  );
  return rewritten.replace(REFERENCE_DEF, (whole, open: string, target: string, rest: string) => {
    const next = rewriteTarget(target, context);
    return next === null ? whole : `${open}${next}${rest}`;
  });
}

/**
 * Rewrites one link target to its locale variant, or returns null to leave it
 * exactly as written.
 */
export function rewriteTarget(target: string, context: LinkContext): string | null {
  // Angle-bracket targets carry the path inside the brackets.
  const bracketed = target.startsWith("<") && target.endsWith(">");
  const inner = bracketed ? target.slice(1, -1) : target;

  // Not a repository file: schemes, protocol-relative URLs, pure fragments.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(inner)) return null;
  if (inner.startsWith("//")) return null;
  if (inner.startsWith("#") || inner.length === 0) return null;

  // Split off the fragment and query — they ride along unchanged.
  const hash = inner.indexOf("#");
  const path = hash === -1 ? inner : inner.slice(0, hash);
  const fragment = hash === -1 ? "" : inner.slice(hash);
  if (path.length === 0) return null;

  // A target that already names a locale is a deliberate cross-locale link.
  if (LOCALE_SUFFIX.test(path)) return null;

  const candidate = localeVariant(path, context.locale);
  if (candidate === null) return null;

  // The rewrite happens only when the variant is known to exist, resolved
  // from the document's own directory the way the rendered link would be.
  const resolved = resolve(directoryOf(context.docPath), candidate);
  if (resolved === null || !context.exists(resolved)) return null;

  const next = `${candidate}${fragment}`;
  return bracketed ? `<${next}>` : next;
}

/**
 * The locale variant of one path: `docs/guide.md` → `docs/guide.vi.md`,
 * `images/flow.png` → `images/flow.vi.png`. Null when the path is not a
 * Markdown document or an image.
 */
function localeVariant(path: string, locale: string): string | null {
  if (path.endsWith(".md")) {
    return `${path.slice(0, -".md".length)}.${locale}.md`;
  }
  const image = IMAGE_EXT.exec(path);
  if (image !== null) {
    const stem = path.slice(0, path.length - image[0].length);
    return `${stem}.${locale}${image[0]}`;
  }
  return null;
}

/** The directory a document's relative links resolve against. */
function directoryOf(docPath: string): string {
  const slash = docPath.lastIndexOf("/");
  return slash === -1 ? "" : docPath.slice(0, slash);
}

/**
 * Resolves a link target against a base directory into a repository-relative
 * path, or null when the target escapes the repository root.
 *
 * A hand-rolled normaliser rather than `node:path`: link targets are POSIX
 * by definition whatever the runner's OS, and the failure mode has to be
 * "leave the link alone", never an exception.
 */
export function resolve(baseDir: string, target: string): string | null {
  // A leading slash is repository-root-relative in most renderers.
  const joined = target.startsWith("/") ? target.slice(1) : `${baseDir}/${target}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}
