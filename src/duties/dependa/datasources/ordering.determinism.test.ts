/**
 * DETERMIN — the newest-first release order every dependa datasource promises.
 *
 * `highestSatisfying` and `latestAvailable` do not compute a maximum. They walk
 * the release list and take the first entry that fits, and their doc comment
 * says so outright: "Releases are assumed to be in newest-first order from the
 * datasource." So the version dependa proposes to a consumer's repository is
 * decided by one line in each datasource, and there are six copies of it:
 *
 *   npm.ts:161, crates.ts:150, go-proxy.ts:149, github-tags.ts:191,
 *   docker-registry.ts:238 and :269
 *
 * all spelling `b.version.localeCompare(a.version, undefined, { numeric: true })`.
 *
 * The claim being pinned here is the one that makes that safe: **the same set
 * of versions produces the same newest-first order, whatever order the registry
 * listed them in and whatever machine the run happens to be on.** A registry is
 * free to reorder its own response — Docker Hub is queried with
 * `ordering=last_updated` and paginated, npm's `versions` is a JSON object, and
 * GitHub's tags endpoint is explicitly "usually newest-first" — so a pipeline
 * whose answer moved with that order would open a different pull request on
 * Tuesday than it did on Monday for a package nobody touched.
 *
 * Two halves, and both are here:
 *
 *  - the half that holds — permuting the registry's listing, and reordering the
 *    keys of npm's `versions` object, never moves the order out;
 *  - the half that does not — two entries the collator cannot tell apart, and
 *    the ambient locale, both reach the answer. Those are pinned as found under
 *    `ADJUDICATE`, not fixed: which comparator these datasources should use is
 *    a decision about what dependa proposes, not a test's to make.
 *
 * Nothing here reaches a network. `fetch` is stubbed exactly the way
 * `npm.test.ts` and `docker-registry.test.ts` already stub it, and every
 * `fc.assert` carries a fixed seed so a red run reproduces.
 */
import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolutionResult } from "../model.js";
import { candidateVersions, latestAvailable } from "../semver.js";

import { createDockerRegistryDatasource } from "./docker-registry.js";
import { createGithubTagsDatasource } from "./github-tags.js";
import { createNpmDatasource } from "./npm.js";

const originalFetch = globalThis.fetch;
const originalLocaleCompare = String.prototype.localeCompare;

afterEach(() => {
  globalThis.fetch = originalFetch;
  String.prototype.localeCompare = originalLocaleCompare;
  vi.restoreAllMocks();
});

/** Narrows to the available case, failing the test rather than the type checker. */
function available(result: ResolutionResult): Extract<ResolutionResult, { status: "available" }> {
  if (result.status !== "available") {
    throw new Error(`expected available, got ${result.status}`);
  }
  return result;
}

/** Replaces `fetch` with one that answers every request from a lookup on the URL. */
function answering(byUrl: (url: string) => Response): void {
  globalThis.fetch = vi.fn<typeof fetch>((url) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    return Promise.resolve(byUrl(href));
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

// ── The three datasources, each driven from a bare list of version strings ──

/**
 * The npm registry document, with `versions` keys written in exactly the order
 * given. JSON preserves key order for non-index keys, and `parseRegistryResponse`
 * reads the map with `Object.entries` — so this is how a registry's key order
 * reaches the code.
 */
async function npmOrder(versions: readonly string[]): Promise<readonly string[]> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const version of versions) map[version] = {};
  answering(() => json({ name: "left-pad", versions: map, time: {} }));
  return available(await createNpmDatasource().resolve("left-pad")).releases.map((r) => r.version);
}

/** A Docker Registry v2 `/tags/list` response, tags in exactly the order given. */
async function dockerOrder(tags: readonly string[]): Promise<readonly string[]> {
  answering(() => json({ name: "acme/widget", tags: [...tags] }));
  return available(
    await createDockerRegistryDatasource().resolve("registry.example.com/acme/widget"),
  ).releases.map((r) => r.version);
}

/** The GitHub tags endpoint, tags in exactly the order given; releases empty. */
async function githubOrder(tags: readonly string[]): Promise<readonly string[]> {
  answering((url) => (url.includes("/releases") ? json([]) : json(tags.map((name) => ({ name })))));
  return available(await createGithubTagsDatasource("t").resolve("acme/widget")).releases.map(
    (r) => r.version,
  );
}

const SOURCES = [
  { name: "npm", order: npmOrder },
  { name: "docker-registry (v2)", order: dockerOrder },
  { name: "github-tags", order: githubOrder },
] as const;

/**
 * A release set with no two entries the collator calls equal — an ordinary
 * package's history, plus the prereleases and the build metadata that make the
 * comparison non-trivial.
 */
const DISTINCT = [
  "1.0.0",
  "1.2.0",
  "1.10.0",
  "2.0.0",
  "2.0.1",
  "10.0.0",
  "2.1.0-beta.1",
  "2.1.0-rc.2",
] as const;

// ── The half that holds ──────────────────────────────────────────────────

describe("the newest-first order is a function of the version set, not of the listing", () => {
  for (const source of SOURCES) {
    it(`${source.name}: any permutation of the registry's listing sorts to the same order`, async () => {
      const reference = await source.order(DISTINCT);
      // The set survives as well as the order: a sort that dropped or
      // duplicated an entry would still pass an order-only assertion.
      expect([...reference].sort()).toEqual([...DISTINCT].sort());

      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray([...DISTINCT], {
            minLength: DISTINCT.length,
            maxLength: DISTINCT.length,
          }),
          async (listed) => {
            expect(await source.order(listed)).toEqual(reference);
          },
        ),
        { numRuns: 60, seed: 20_260_821 },
      );
    });
  }

  it("npm: the `versions` object's key order never reaches the answer", async () => {
    // Same document, keys written in two orders a registry could legitimately
    // serialise. `Object.entries` hands them over in write order, so this is
    // the one place object key ordering can leak into a proposal.
    const ascending = await npmOrder(["1.0.0", "1.2.0", "2.0.0"]);
    const descending = await npmOrder(["2.0.0", "1.2.0", "1.0.0"]);
    const arbitrary = await npmOrder(["1.2.0", "2.0.0", "1.0.0"]);

    expect(ascending).toEqual(["2.0.0", "1.2.0", "1.0.0"]);
    expect(descending).toEqual(ascending);
    expect(arbitrary).toEqual(ascending);
  });

  it("the head the whole proposal hangs off is the same for every permutation", async () => {
    // The order is only interesting because of what reads it. `latestAvailable`
    // takes the first non-prerelease entry and `candidateVersions` builds the
    // proposal from it, so this asserts the decision rather than the array.
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([...DISTINCT], {
          minLength: DISTINCT.length,
          maxLength: DISTINCT.length,
        }),
        async (listed) => {
          const versions = await npmOrder(listed);
          expect(latestAvailable(versions)).toBe("10.0.0");
          expect(candidateVersions(versions, "^2.0.0")).toEqual(["2.0.1", "10.0.0"]);
        },
      ),
      { numRuns: 60, seed: 20_260_821 },
    );
  });
});

// ── The half that does not ───────────────────────────────────────────────

describe("ADJUDICATE: what the newest-first order still reads besides the versions", () => {
  it("two versions the collator calls equal leave the head to the registry's listing order", async () => {
    // `"1.0"` and `"01.0"` compare 0 under `{ numeric: true }` — the numeric
    // collation reads both as the number 1 and the leading zero is not a
    // tie-break. `Array.prototype.sort` is stable, so a tie keeps the input
    // order, and the input order is the registry's.
    expect("1.0".localeCompare("01.0", undefined, { numeric: true })).toBe(0);

    const listedPlain = await dockerOrder(["1.0", "01.0", "0.9"]);
    const listedPadded = await dockerOrder(["01.0", "1.0", "0.9"]);

    expect(listedPlain[0]).toBe("1.0");
    expect(listedPadded[0]).toBe("01.0");

    // And it is a different proposal, not a different array. Both tags parse to
    // the same `Semver`, so a repository pinned at `1.0` is told to move to
    // `01.0` — `main.ts` skips a candidate only on `targetVersion ===
    // dep.currentVersion`, which is a string comparison this passes.
    expect(latestAvailable(listedPlain)).toBe("1.0");
    expect(latestAvailable(listedPadded)).toBe("01.0");

    // Docker tag names allow a leading zero (`[a-zA-Z0-9_][a-zA-Z0-9._-]*`) and
    // so do git tag names, so this is reachable rather than theoretical.
    // Question for adjudication: should the datasources sort with the module's
    // own `compare` from `semver.ts`, which is a total order on what it parses,
    // and fall back to byte order — never a collator — on what it does not?
  });

  it("the order is the ambient locale's, so the same registry answer sorts differently per runner", async () => {
    // `localeCompare(a, undefined, …)` reads the default locale, which Node
    // derives from `LC_ALL`/`LANG` at start-up. A GitHub Action inherits the
    // workflow's `env:`, so a consumer with `LANG: cs_CZ.UTF-8` on the job runs
    // dependa under Czech collation, where `ch` is one letter sorting between
    // `h` and `i`. Nothing in this repository pins it.
    //
    // Simulated by forcing the default rather than by reading the process
    // locale, so the test asserts the same thing on every runner. The
    // precondition is that this Node build carries ICU data for `cs` — every
    // official build since 13 does, and `.node-version` pins 24.
    expect(Intl.Collator.supportedLocalesOf(["cs"])).toEqual(["cs"]);

    // Two container tags that differ only in the digraph. Under the root
    // collation `cs` sorts above `ch`; under Czech collation it is the other
    // way round.
    const tags = ["21-chiselled", "21-cs", "21-alpine"] as const;

    const root = await withDefaultLocale("en-US", () => dockerOrder(tags));
    const czech = await withDefaultLocale("cs-CZ", () => dockerOrder(tags));

    expect(root[0]).toBe("21-cs");
    expect(czech[0]).toBe("21-chiselled");
    expect(czech).not.toEqual(root);

    // The version dependa would propose moves with the runner's locale, which
    // is the whole of the finding: same registry, same repository, same commit,
    // two answers.
    expect(candidateVersions(root, null)).not.toEqual(candidateVersions(czech, null));
  });

  it("every datasource reads the ambient locale, so this is one decision in six places", async () => {
    const tags = ["21-chiselled", "21-cs", "21-alpine"] as const;

    for (const source of SOURCES) {
      const root = await withDefaultLocale("en-US", () => source.order(tags));
      const czech = await withDefaultLocale("cs-CZ", () => source.order(tags));
      expect({ source: source.name, first: czech[0] }).toEqual({
        source: source.name,
        first: "21-chiselled",
      });
      expect({ source: source.name, first: root[0] }).toEqual({
        source: source.name,
        first: "21-cs",
      });
    }
  });
});

/**
 * Runs `body` with `String.prototype.localeCompare`'s *default* locale forced
 * to `locale` — a call that passes an explicit locale is left alone, so only
 * the `undefined` the datasources pass is affected.
 *
 * There is no supported way to change a running process's default locale, and
 * spawning a child per locale would put a Node start-up in the suite for every
 * case. Patching the one method the datasources call reaches the same seam and
 * restores in a `finally`, so nothing leaks into another test in this file.
 */
async function withDefaultLocale<T>(locale: string, body: () => Promise<T>): Promise<T> {
  function forced(
    this: string,
    that: string,
    locales?: Intl.LocalesArgument,
    options?: Intl.CollatorOptions,
  ): number {
    return originalLocaleCompare.call(this, that, locales ?? locale, options);
  }
  String.prototype.localeCompare = forced;
  try {
    return await body();
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
}
