/**
 * Resolves every `(path#fragment)` link in README.md and `docs/**` against
 * the headings of the file it points at.
 *
 * The slug used is `github-slugger`'s `slug()` — the published package GitHub
 * itself renders with, pinned here — never a hand-rolled transform. The prior
 * audit's P1-3 fix (commit efb5162) hand-asserted that an em-dash heading
 * anchors as a SINGLE hyphen; GitHub actually strips the U+2014 but keeps the
 * two surrounding spaces, each of which becomes a hyphen → DOUBLE hyphen
 * (`d12--capacity-is-weather-…`). This checker exists because that belief was
 * wrong and every link the fix "corrected" went dead.
 *
 * Checks per link:
 *   1. the target file exists at the resolved path;
 *   2. the fragment (minus any `user-content-` prefix) matches a `slug()` of
 *   one of the file's headings.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import GithubSlugger from "github-slugger";

const LINK = /\]\((\S*?)#([^)\s]+)\)/g;
const EMPTY_HEADING = /^#+\s+([^#].*)$/gm;

/** github-slugger's API is instance-based — new one per file so state never leaks across targets. */
const slugger = new GithubSlugger();

/** All docs files, resolved relative to the repo root. */
function docFiles() {
  return ["README.md", ...readdirSync("docs", { recursive: true })]
    .filter((f) => f.endsWith(".md"))
    .map((f) => (f.startsWith("docs/") ? f : join("docs", f)));
}

/** Map of absolute path → heading slugs for every doc, computed once. */
const headingsCache = new Map();
function headingsFor(targetPath) {
  if (headingsCache.has(targetPath)) return headingsCache.get(targetPath);
  const source = readFileSync(targetPath, "utf8");
  const slugs = new Set();
  for (const m of source.matchAll(EMPTY_HEADING)) {
    slugger.reset();
    slugs.add(slugger.slug(m[1].trim()));
  }
  headingsCache.set(targetPath, slugs);
  return slugs;
}

let failures = 0;

for (const file of docFiles()) {
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\n/);
  for (const [idx, line] of lines.entries()) {
    for (const match of line.matchAll(LINK)) {
      const [, rawPath, frag] = match;
      const lineNumber = idx + 1;
      if (rawPath.startsWith("http") || rawPath.startsWith("mailto:")) continue;
      const target = rawPath ? join(dirname(file), rawPath).replace(/\.md$/, "") : file;
      const resolved = rawPath ? `${target}.md` : file;
      if (rawPath && !existsSync(resolved)) {
        console.error(`${file}:${lineNumber}: ${rawPath}#${frag} — target file does not exist.`);
        failures++;
        continue;
      }
      const fragClean = frag.replace(/^user-content-/, "");
      if (!headingsFor(resolved).has(fragClean)) {
        console.error(
          `${file}:${lineNumber}: ${rawPath ?? file}#${frag} — no heading anchors to "${fragClean}" in ${resolved}.`,
        );
        failures++;
        continue;
      }
      // No legacy single-hyphen form to ban here: a fragment is either
      // present in the headings set (valid) or not (already failed above).
    }
  }
}

if (failures > 0) {
  console.error(`\n${String(failures)} broken documentation link(s).`);
  process.exit(1);
}
console.log("All documentation links resolve against real headings.");
