/**
 * Fixture discovery: which fixtures a duty has, in stable order, and the
 * rule that a fixture directory is one self-contained scenario.
 *
 * Extracted from `runner.ts` so the contract suite can pin the discovery
 * without importing the runner (whose `main()` would run on import). A
 * nested directory inside a fixture would be silently skipped by a flat
 * listing — a scenario that reads as covered but is not — so it is refused
 * rather than skipped.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The fixture names under one duty, in listing order. */
export async function fixturesFor(duty: string, base: string): Promise<string[]> {
  const entries = await readdir(join(base, duty));
  const fixtures: string[] = [];
  for (const entry of entries) {
    const s = await stat(join(base, duty, entry));
    if (s.isDirectory()) {
      await rejectShadowFixture(duty, entry, base);
      fixtures.push(entry);
    }
  }
  return fixtures;
}

/**
 * A fixture directory must be a self-contained scenario: every file the run
 * reads lives directly inside it. A nested directory would be silently skipped
 * — a `fixture/sub/` scenario the listing walk never reaches — which is a
 * fixture that reads as covered but is not. Refuse rather than skip.
 */
export async function rejectShadowFixture(duty: string, name: string, base: string): Promise<void> {
  const nested = (await readdir(join(base, duty, name))).filter(
    (entry) => entry !== ".expected.json",
  );
  const shadow: string[] = [];
  for (const entry of nested) {
    const s = await stat(join(base, duty, name, entry));
    if (s.isDirectory()) shadow.push(entry);
  }
  if (shadow.length > 0) {
    throw new Error(
      `eval: fixture \`${duty}/${name}\` holds a nested directory \`${shadow[0] ?? ""}\` — ` +
        "a fixture is one self-contained scenario, and a nested directory would be " +
        "silently skipped. Move it out.",
    );
  }
}

/** Whether a duty has fixtures on disk to run. */
export async function hasFixtures(duty: string, base: string): Promise<boolean> {
  try {
    const entries = await readdir(join(base, duty));
    for (const entry of entries) {
      const s = await stat(join(base, duty, entry));
      if (s.isDirectory()) return true;
    }
    return false;
  } catch {
    return false;
  }
}
