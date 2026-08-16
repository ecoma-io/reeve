/**
 * Resolves every `uses: ecoma-io/reeve/<duty>@<ref>` in README and `docs/`
 * against the tags and action files that actually exist at this ref.
 *
 * Kills the P0-TAG class permanently: a doc that pins `@v0.1` for a duty that
 * ships only in `v0.6`, or cites `@v0.1.3` when no such release exists, fails
 * CI instead of reaching a first-contact user as a broken example.
 *
 * Lines may be exempted by appending the explicit marker `<!-- roadmap ref -->
 *` or `<!-- historical ref -->` to the ref-bearing `uses:` line — the guards
 * around a deliberately-future (`@v2`) or deliberately-historical (`@v0.1`)
 * example, never an accident.
 *
 * Checks, in order, one per `uses:` line:
 *   1. the ref parses as a commit SHA (immutable, always valid), a `vX.Y` / `vX`
 *   floating tag, or a `vX.Y.Z` exact release;
 *   2. a SHA is treated as valid without further lookup;
 *   3. a tag ref must exist as a git tag at this moment;
 *   4. every `ecoma-io/reeve/<duty>@<tag>` must resolve a `dist/index.js`
 *   bundle inside the checked-out tree at that tag — the duty-debut
 *   `git show <tag>:<duty>/action.yml` is approximated by checking the bundle
 *   file exists (action code never ships without its bundle; the exact
 *   action.yml probe is `git ls-tree`/`git show` and too slow per-line here).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REF = /uses:\s+ecoma-io\/reeve(\/[a-z0-9-]+)?@([^\s#`,]+)/g;
const MARKER = /(?:<!--\s*(roadmap ref|historical ref)\s*-->|#\s*(roadmap ref|historical ref))/;

const SHA = /^[0-9a-f]{40}$/;
const FLOAT = /^v\d+(\.\d+)?$/;
const EXACT = /^v\d+\.\d+\.\d+$/;

/** Every tag in this repository, fresh from git — never a cached list. */
function tags() {
  return new Set(execFileSync("git", ["tag"], { encoding: "utf8" }).split(/\n/).filter(Boolean));
}

/** The bundle file a duty must ship at a tag — approximates the `action.yml` probe. */
function bundlePath(duty) {
  const dir = duty.replace(/^\//, "");
  return dir === "" ? join("dist", "index.js") : join(dir, "dist", "index.js");
}

function existsAtRef(tag, duty) {
  try {
    execFileSync("git", ["cat-file", "-e", `${tag}:${bundlePath(duty)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const files = ["README.md", ...readdirSync("docs", { recursive: true })];
let failures = 0;

for (const rel of files) {
  if (!rel.endsWith(".md")) continue;
  const readPath = rel.startsWith("docs/") ? rel : join("docs", rel);
  const source = readFileSync(readPath, "utf8");
  const lines = source.split(/\n/);
  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    for (const match of line.matchAll(REF)) {
      const duty = match[1] ?? "";
      const ref = match[2];
      if (MARKER.test(line)) {
        continue; // deliberately future/historical example
      }
      if (SHA.test(ref)) continue;
      if (FLOAT.test(ref) || EXACT.test(ref)) {
        if (!tags().has(ref)) {
          console.error(
            `${readPath}:${lineNumber}: ecoma-io/reeve${duty}@${ref} — no such tag in this repository.`,
          );
          failures++;
          continue;
        }
        if (!existsAtRef(ref, duty)) {
          console.error(
            `${readPath}:${lineNumber}: ecoma-io/reeve${duty}@${ref} — no bundle at ${ref}:${bundlePath(duty)}. ` +
              `The duty likely debuts in a later tag.`,
          );
          failures++;
        }
      } else {
        console.error(`${readPath}:${lineNumber}: ecoma-io/reeve${duty}@${ref} — unparseable ref.`);
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${String(failures)} broken uses ref(s) in docs.`);
  process.exit(1);
}
console.log("All documented uses: refs resolve against real tags.");
