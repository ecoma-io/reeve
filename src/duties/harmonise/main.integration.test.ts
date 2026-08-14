/**
 * The harmonise duty, driven the way a runner drives it — everything except the
 * endpoint and GitHub.
 *
 * The contract test checks what the full pipeline test cannot: that every input
 * `action.yml` declares is read somewhere, that every output it declares is
 * written somewhere, and that the entry point and `.env.example` stay in sync.
 * These are the drifts no other test catches — a renamed input reads an empty
 * string silently, and a missing `.env` key means a knob nobody can turn.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Where this duty is published from: a repository subdirectory of its own. */
const DUTY = join(ROOT, "harmonise");

describe("the action contract", () => {
  /**
   * Every input `action.yml` declares, read straight out of it.
   *
   * A regex rather than the YAML parser this repository now carries: that one
   * is bundled into the duties to read a warrant at runtime, and reaching for
   * it here would make this suite agree with itself about a file it is
   * checking. The shape being read is two levels deep and fully indented —
   * every input is a key at exactly two spaces inside the `inputs:` block.
   */
  async function declaredInputs(): Promise<string[]> {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");
    const block = /\ninputs:\n([\s\S]*?)\noutputs:\n/.exec(text)?.[1] ?? "";
    return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(([, name]) => name ?? "");
  }

  /**
   * Every input the duty actually reads — its own, and the shared ones it
   * inherits from `core/inputs.ts`.
   *
   * Both files, because the shared inputs are read once in the core and
   * declared once per duty: a duty that dropped `api-key` from its `action.yml`
   * would still read it, and nothing else would notice.
   */
  async function readInputs(): Promise<string[]> {
    const sources = await Promise.all([
      readFile(join(ROOT, "src", "duties", "harmonise", "main.ts"), "utf8"),
      readFile(join(ROOT, "src", "core", "inputs.ts"), "utf8"),
    ]);
    // A set, not a list: `models` is read twice — once in `inputs.ts`, once
    // in `readSettings` via `readShared` — and that duplication is harmless
    // plumbing rather than a second, different input.
    return [
      ...new Set(
        [...sources.join("\n").matchAll(/get(?:Boolean)?Input\("([^"]+)"/g)].map(
          ([, name]) => name ?? "",
        ),
      ),
    ];
  }

  /**
   * Every output `action.yml` declares.
   */
  async function declaredOutputs(): Promise<string[]> {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");
    const block = /\noutputs:\n([\s\S]*?)\nruns:\n/.exec(text)?.[1] ?? "";
    return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(([, name]) => name ?? "");
  }

  /**
   * Every output the duty actually writes.
   */
  async function writtenOutputs(): Promise<string[]> {
    const source = await readFile(join(ROOT, "src", "duties", "harmonise", "main.ts"), "utf8");
    return [
      ...new Set([...source.matchAll(/setOutput\(\s*"([^"]+)"/g)].map(([, name]) => name ?? "")),
    ];
  }

  it("reads every input it declares, under the name it declared", async () => {
    // The one drift no other test can see: renaming an input in `action.yml`
    // alone leaves the action reading an empty string forever, silently and on
    // every run.
    expect([...(await readInputs())].sort()).toEqual([...(await declaredInputs())].sort());
  });

  it("offers every input to a local run, under the name `pnpm try` reads", async () => {
    // `tools/try.mjs` derives the `.env` key from the input name, so a new
    // input is configurable locally the moment it exists — but nothing would
    // say so, and an undocumented knob is one nobody turns. The example file is
    // the document, and this is what stops it going stale.
    const text = await readFile(join(ROOT, ".env.example"), "utf8");
    const documented = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name);

    for (const input of await declaredInputs()) {
      expect(documented).toContain(input.replace(/-/g, "_").toUpperCase());
    }
  });

  it("declares the entry point this suite drives", async () => {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");

    expect(text).toContain("main: dist/index.js");
  });

  it("writes every output it declares", async () => {
    // The dual of the input check: an output in `action.yml` that never gets
    // written is always empty, and a consumer reading it sees nothing — without
    // this test, nothing else would notice.
    expect([...(await writtenOutputs())].sort()).toEqual([...(await declaredOutputs())].sort());
  });

  it("keeps every source file reviewable as text", async () => {
    // A control character in a source file is not a style question. Git
    // classifies a file holding a NUL as binary, so a pull request touching it
    // renders `Bin 12990 -> 16484 bytes` where the diff belongs — and a module
    // nobody can read a diff of is a module nobody reviewed, however carefully
    // they meant to. It reached `publish.ts` once, as the separator
    // `fingerprint` hashes with, and survived two pull requests over exactly
    // the code that decides what gets written into a public thread.
    //
    // The escape `\u0000` hashes the identical byte and leaves the file text,
    // so this costs the code nothing. Tab, newline and carriage return are
    // ordinary; the rest of C0 is not.
    const offenders: string[] = [];
    for (const file of await readdir(join(ROOT, "src"), { recursive: true })) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(join(ROOT, "src", file), "utf8");
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
