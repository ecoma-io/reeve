/**
 * The harmonise action's own contract: `action.yml` against the source.
 *
 * Renamed out of `main.integration.test.ts`, because it never was one. It
 * spawns nothing and imports nothing from `src/` — it is a regex read of
 * `action.yml` checked against a regex read of `main.ts`, and while that
 * catches drifts no other test can see (a renamed input reads an empty string
 * silently, for ever, on every run), it is not evidence that the duty does
 * anything. Carrying the name `main.integration.test.ts` made the gap
 * invisible: two auditors found harmonise's capability gates unobserved, and
 * part of the reason nobody had noticed is that the file list said otherwise.
 *
 * The real one now lives in `main.integration.test.ts` and drives the bundle.
 */
import { readFile } from "node:fs/promises";
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

  it("declares the entry point the runner loads", async () => {
    const text = await readFile(join(DUTY, "action.yml"), "utf8");

    expect(text).toContain("main: dist/index.js");
  });

  it("writes every output it declares", async () => {
    // The dual of the input check: an output in `action.yml` that never gets
    // written is always empty, and a consumer reading it sees nothing — without
    // this test, nothing else would notice.
    expect([...(await writtenOutputs())].sort()).toEqual([...(await declaredOutputs())].sort());
  });
});
