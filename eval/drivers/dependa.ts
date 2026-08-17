/**
 * The dependa driver: what one fixture means, and what a run over it must
 * show.
 *
 * Dependa's publish path needs a real registry (the datasource URLs —
 * `registry.npmjs.org`, `crates.io`, `proxy.golang.org`,
 * `registry.hub.docker.com`, `api.github.com` — are hardcoded in the duty's
 * source, not read from `GITHUB_API_URL`), so every fixture stops before the
 * datasource loop and reports the clean empty run. The three stops, in the
 * order the pipeline reaches them:
 *
 * - `denied` — the warrant's `duties:` block never names dependa; the run is
 *   refused before a single API call.
 * - `no-manifest` — the repository tree has no recognised dependency
 *   manifest; discovery reads `repos.get` + `git.getTree` and stops.
 * - `refused-rule` — the policy's own `ecosystems:` narrows the repo's npm
 *   dependencies away before any datasource is asked; discovery reads the
 *   manifest through the Contents API and stops with nothing to resolve.
 *
 * A fixture that would force a real registry call is deliberately not here —
 * it cannot be stubbed without touching dependa's datasource code.
 *
 * The fixture's `.expected.json` reads:
 *
 * - `warrant`   — the warrant text to run under.
 * - `files`     — the repository tree the stub serves, as `path → content`.
 * - `expected`  — the outputs the run must report. Every dependa run writes
 *   `proposed`, `refused`, `security`, `pull-requests` (JSON), `starved` and
 *   `budget-exhausted` (booleans); a run that stops clean reports all of them
 *   empty.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Answer, ContentMap, Route } from "../harness.ts";
import { publishRoutes, repoRoutes, saying, shaOf } from "../harness.ts";

/** The fixture's `.expected.json`: configuration at the top. */
export interface DependaFixture {
  readonly description?: string;
  readonly warrant: string;
  /** The repository tree as `path → content`. */
  readonly files: Record<string, string>;
  readonly expected?: DependaAssertions;
}

/** The assertions one dependa fixture declares — compared against the run. */
export interface DependaAssertions {
  readonly proposed?: string;
  readonly refused?: string;
  readonly security?: string;
  readonly "pull-requests"?: string;
  readonly starved?: string;
  readonly "budget-exhausted"?: string;
}

export interface DependaScenario {
  readonly name: string;
  /** The warrant to run under. */
  readonly warrant: string;
  /** The repository tree the stub serves. */
  readonly contents: ContentMap;
  /** The assertions this fixture declares. */
  readonly expected: DependaAssertions;
}

/** The default assertions every dependa fixture declares, unless overridden. */
export const DEFAULT_DEPENDA_ASSERTIONS: DependaAssertions = {
  proposed: "[]",
  refused: "[]",
  security: "[]",
  "pull-requests": "[]",
  starved: "false",
  "budget-exhausted": "false",
};

/**
 * The completion answer: dependa only reaches a model when `drafts > 0`
 * (the advisory interpretation stage), and every fixture runs drafts at the
 * default `0`, so the completion is never called. Served anyway so a change
 * that starts asking never goes unanswered.
 */
export function scriptDependa(): (ask: {
  readonly model: string;
  readonly system: string;
}) => Answer {
  return () => saying("unused");
}

/** The routes one dependa run needs: the repo tree, the write side, completion. */
export function dependaRoutes(scenario: DependaScenario): readonly Route[] {
  return [...repoRoutes(scenario.contents), ...publishRoutes(scenario.contents)];
}

/** Reads the fixture's `.expected.json` into a runnable scenario. */
export async function scenarioOf(name: string, directory: string): Promise<DependaScenario> {
  const fixture = JSON.parse(
    await readFile(join(directory, ".expected.json"), "utf8"),
  ) as DependaFixture;
  const contents = new Map<string, { content: string; sha: string }>();
  for (const [path, content] of Object.entries(fixture.files)) {
    contents.set(path, { content, sha: shaOf(content) });
  }
  return {
    name,
    warrant: fixture.warrant,
    contents,
    expected: { ...DEFAULT_DEPENDA_ASSERTIONS, ...fixture.expected },
  };
}
