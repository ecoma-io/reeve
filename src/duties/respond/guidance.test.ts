import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readGuidance } from "./guidance.js";
async function fileWith(contents: string, name = "guidance.md"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reeve-guidance-"));
  const path = join(root, name);
  await writeFile(path, contents);
  return path;
}

describe("readGuidance", () => {
  it("reads the file's text, trimmed", async () => {
    const path = await fileWith("  Never promise a release date.  \n");
    expect(await readGuidance(path)).toBe("Never promise a release date.");
  });

  it("treats a file that does not exist as the cold start — quiet, not a warning", async () => {
    expect(await readGuidance("/nowhere/at/all/guidance.md")).toBeNull();
  });

  it("treats a file with nothing written into it yet the same as an absent one", async () => {
    const path = await fileWith("   \n  \n");
    expect(await readGuidance(path)).toBeNull();
  });

  it("treats an empty file the same as an absent one", async () => {
    const path = await fileWith("");
    expect(await readGuidance(path)).toBeNull();
  });

  it("treats a directory where a file was expected the same as an absent one", async () => {
    // The module's own doctrine: "a directory where a file was expected, a
    // permissions error" is also `null` — a checkout this duty cannot repair
    // must not fail the run over a file a maintainer can live without.
    const root = await mkdtemp(join(tmpdir(), "reeve-guidance-dir-"));
    expect(await readGuidance(root)).toBeNull();
  });
});
