/**
 * One repository-wide invariant: every TypeScript file under `src/` is text a
 * human can read a diff of.
 *
 * A control character in a source file is not a style question. Git classifies
 * a file holding a NUL as binary, so a pull request touching it renders
 * `Bin 12990 -> 16484 bytes` where the diff belongs — and a module nobody can
 * read a diff of is a module nobody reviewed, however carefully they meant to.
 * It reached `publish.ts` once, as the separator `fingerprint` hashes with, and
 * survived two pull requests over exactly the code that decides what gets
 * written into a public thread.
 *
 * The escape `\u0000` hashes the identical byte and leaves the file text, so
 * this costs the code nothing. Tab, newline and carriage return are ordinary;
 * the rest of C0 is not.
 *
 * **Why this lives here rather than once per duty.** Four suites used to carry
 * a copy — two whole-`src` walks byte for byte identical, two scanning a single
 * duty's directory — and two of them argued in a comment that the repetition
 * was deliberate: "repeated here rather than trusted to run elsewhere … this
 * duty's own files are exactly the ones this brief added." That argument does
 * not hold. All four copies ran inside the same `pnpm test` invocation, so
 * there was never a configuration in which one duty's suite ran and this file
 * did not; the duplication bought four recursive tree reads per run and bought
 * no coverage. The invariant is about `src/`, not about any one duty, so it
 * belongs at the root of `src/` where its scope is legible — and living here it
 * also covers `src/core`, `src/doctor` and every duty that never thought to add
 * a copy of its own.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

describe("every source file is reviewable as text", () => {
  it("no TypeScript file under src holds a C0 control character", async () => {
    const offenders: string[] = [];
    for (const file of await readdir(SRC, { recursive: true })) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(join(SRC, file), "utf8");
      // eslint-disable-next-line no-control-regex -- finding one is the point
      const found = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(text);
      if (found !== null) {
        const at = found[0].codePointAt(0) ?? 0;
        offenders.push(`${file} holds U+${at.toString(16).padStart(4, "0").toUpperCase()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
