/**
 * Fixture discovery, pinned: what the runner lists, and that a nested
 * "shadow" directory inside a fixture is refused rather than silently skipped.
 *
 * A fixture is one self-contained scenario — a flat directory under
 * `eval/fixtures/<duty>/`. A nested directory would be invisible to the flat
 * listing walk, so a scenario it held would read as covered but never run:
 * the silent skip this suite exists to prevent. `fixturesFor` refuses it, and
 * `hasFixtures` never gets a chance to claim a duty is evaluated.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturesFor, hasFixtures, rejectShadowFixture } from "../fixtures.ts";

const temp = await mkdtemp(join(tmpdir(), "reeve-fixtures-"));
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });
});

describe("fixture discovery", () => {
  it("lists exactly the direct fixture directories, in order", async () => {
    await mkdir(join(temp, "review", "a"), { recursive: true });
    await mkdir(join(temp, "review", "b"), { recursive: true });
    await writeFile(join(temp, "review", "lint.txt"), "not a fixture");

    const names = await fixturesFor("review", temp);
    expect(names).toEqual(["a", "b"]);
    expect(await hasFixtures("review", temp)).toBe(true);
  });

  it("reports a duty with only stray files as having no fixtures", async () => {
    await mkdir(join(temp, "review"), { recursive: true });
    await writeFile(join(temp, "review", "stray.txt"), "nothing");
    expect(await hasFixtures("review", temp)).toBe(false);
    await expect(fixturesFor("review", temp)).resolves.toEqual([]);
  });

  it("refuses a fixture that holds a nested directory — never a silent skip", async () => {
    await mkdir(join(temp, "review", "open-pr", "shadow"), { recursive: true });
    await writeFile(join(temp, "review", "open-pr", ".expected.json"), "{}");

    await expect(fixturesFor("review", temp)).rejects.toThrow(
      /open-pr.*holds a nested directory `shadow`/,
    );
    await expect(rejectShadowFixture("review", "open-pr", temp)).rejects.toThrow(
      /nested directory/,
    );
  });

  it("ignores the `.expected.json` itself when scanning a fixture for shadow entries", async () => {
    await mkdir(join(temp, "review", "clean-pr"), { recursive: true });
    await writeFile(join(temp, "review", "clean-pr", ".expected.json"), "{}");
    await expect(rejectShadowFixture("review", "clean-pr", temp)).resolves.toBeUndefined();
  });
});
