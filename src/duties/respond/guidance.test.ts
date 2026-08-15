import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as CoreT from "@actions/core";
import * as core from "@actions/core";
import { describe, expect, it, vi } from "vitest";

import { readGuidance } from "./guidance.js";

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreT>();
  return {
    ...actual,
    warning: vi.fn(),
  };
});
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

  it("warns on non-ENOENT errors like EISDIR, but still returns null", async () => {
    // A directory at the guidance path is a misconfiguration — the maintainer
    // should be told, but the run should not fail over it.
    const root = await mkdtemp(join(tmpdir(), "reeve-guidance-eisdir-"));
    vi.mocked(core.warning).mockClear();
    expect(await readGuidance(root)).toBeNull();
    expect(core.warning).toHaveBeenCalledTimes(1);
    const warnCall = vi.mocked(core.warning).mock.calls[0];
    expect(warnCall).toBeDefined();
    expect(warnCall?.[0]).toContain("could not read guidance file");
    expect(warnCall?.[0]).toContain("EISDIR");
  });

  it("does not warn on ENOENT (cold start)", async () => {
    vi.mocked(core.warning).mockClear();
    await readGuidance("/nowhere/at/all/missing-guidance.md");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("truncates and warns when guidance exceeds MAX_GUIDANCE_LENGTH", async () => {
    const longContent = "x".repeat(10_001);
    const path = await fileWith(longContent);
    vi.mocked(core.warning).mockClear();
    const result = await readGuidance(path);
    expect(result).toHaveLength(10_000);
    expect(core.warning).toHaveBeenCalledTimes(1);
    const warnCall = vi.mocked(core.warning).mock.calls[0];
    expect(warnCall?.[0]).toContain("exceeding");
  });

  it("does not truncate when guidance is exactly MAX_GUIDANCE_LENGTH", async () => {
    const exactContent = "x".repeat(10_000);
    const path = await fileWith(exactContent);
    vi.mocked(core.warning).mockClear();
    const result = await readGuidance(path);
    expect(result).toHaveLength(10_000);
    expect(core.warning).not.toHaveBeenCalled();
  });
});
