/**
 * DETERMIN — the newest-first release order every dependa datasource promises.
 *
 * `highestSatisfying` and `latestAvailable` do not compute a maximum. They walk
 * the release list and take the first entry that fits, and their doc comment
 * says so outright: "Releases are assumed to be in newest-first order from the
 * datasource." So the version dependa proposes to a consumer's repository is
 * decided by the comparator each datasource sorts with. There used to be six
 * copies of that line — npm, crates, go-proxy, github-tags and docker-registry
 * twice — all spelling
 * `b.version.localeCompare(a.version, undefined, { numeric: true })`. They now
 * share `byVersionDescending` from `types.ts`, which is where the two findings
 * below were fixed and where the reasoning lives.
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
 * Three things are pinned here:
 *
 *  - permuting the registry's listing, and reordering the keys of npm's
 *    `versions` object, never moves the order out;
 *  - two entries the collator cannot tell apart no longer leave the head to
 *    whichever the registry listed first;
 *  - the ambient locale does not reach the answer.
 *
 * The last two were findings of this round rather than properties that already
 * held. Both were reachable: `1.0` and `01.0` compare equal under `numeric`,
 * and `undefined` as a locale means whatever `LC_ALL`/`LANG` says on the runner
 * — which, for an action running inside somebody else's workflow, is theirs to
 * set. The cases below are written from the failing side, so each states what
 * went wrong before it states that it no longer does.
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

// ── What the newest-first order must not read besides the versions ───────

describe("what the newest-first order does not read", () => {
  it("does not leave the head to the listing when the collator calls two versions equal", async () => {
    // `"1.0"` and `"01.0"` compare 0 under `{ numeric: true }` — the numeric
    // collation reads both as the number 1 and the leading zero is not a
    // tie-break. `Array.prototype.sort` is stable, so a tie keeps the input
    // order, and the input order is the registry's.
    expect("1.0".localeCompare("01.0", undefined, { numeric: true })).toBe(0);

    // The tie is still there — this is a property of the collator, not
    // something a datasource can talk it out of — so the comparator breaks it
    // in byte order, which no listing and no locale can move.
    const listedPlain = await dockerOrder(["1.0", "01.0", "0.9"]);
    const listedPadded = await dockerOrder(["01.0", "1.0", "0.9"]);

    expect(listedPlain).toEqual(listedPadded);
    expect(listedPlain[0]).toBe("1.0");

    // The direction the tie breaks in is the whole of it. Descending byte
    // order would put `1.0` above `01.0` — fixing the leading-zero spelling —
    // and `1.00` above `1.0`, guaranteeing the trailing-zero one. Both
    // paddings are ordinary in Docker tags and git tags, so the tie breaks
    // toward the shortest spelling, which is the canonical one.
    const trailing = await dockerOrder(["1.00", "1.0", "0.9"]);
    const trailingReversed = await dockerOrder(["1.0", "1.00", "0.9"]);
    expect(trailing).toEqual(trailingReversed);
    expect(trailing[0]).toBe("1.0");
    expect(latestAvailable(trailing)).toBe("1.0");

    // Several paddings at once, so the rule is a total order rather than a
    // pairwise accident.
    const many = await dockerOrder(["1.000", "01.0", "1.0", "1.00"]);
    expect(many[0]).toBe("1.0");

    // It was a different *proposal*, not just a different array, which is why
    // it mattered. Both tags parse to the same `Semver`, and `main.ts` skips a
    // candidate only on `targetVersion === dep.currentVersion` — a string
    // comparison — so a repository pinned at `1.0` used to be sent a pull
    // request moving it to `01.0` whenever the registry happened to list the
    // padded spelling first. Docker tag names allow a leading zero
    // (`[a-zA-Z0-9_][a-zA-Z0-9._-]*`) and so do git tag names, so it was
    // reachable rather than theoretical.
    expect(latestAvailable(listedPlain)).toBe("1.0");
    expect(latestAvailable(listedPadded)).toBe("1.0");
  });

  it("does not read the ambient locale, so every runner sorts the same registry answer alike", async () => {
    // `localeCompare(a, undefined, …)` reads the default locale, which Node
    // derives from `LC_ALL`/`LANG` at start-up. A GitHub Action inherits the
    // workflow's `env:`, so a consumer with `LANG: cs_CZ.UTF-8` on the job ran
    // dependa under Czech collation, where `ch` is one letter sorting between
    // `h` and `i` — and the version it proposed moved with that setting. Same
    // registry, same repository, same commit, two answers.
    //
    // Simulated by forcing the *default* rather than by reading the process
    // locale, so the test asserts the same thing on every runner — and note
    // what that makes this case: the helper below only substitutes a locale
    // where the caller passed `undefined`, so it reaches the comparator only
    // if the comparator has stopped naming one. It is the mutation and the
    // assertion at once.
    //
    // The precondition is that this Node build carries ICU data for `cs` —
    // every official build since 13 does, and `.node-version` pins 24 — so a
    // build without it would make this vacuous rather than red.
    expect(Intl.Collator.supportedLocalesOf(["cs"])).toEqual(["cs"]);

    // Two container tags that differ only in the digraph. Under the root
    // collation `cs` sorts above `ch`; under Czech collation it is the other
    // way round.
    const tags = ["21-chiselled", "21-cs", "21-alpine"] as const;

    const root = await withDefaultLocale("en-US", () => dockerOrder(tags));
    const czech = await withDefaultLocale("cs-CZ", () => dockerOrder(tags));

    expect(czech).toEqual(root);
    expect(root[0]).toBe("21-cs");
    expect(candidateVersions(root, null)).toEqual(candidateVersions(czech, null));
  });

  it("holds for every datasource, because they sort through one comparator", async () => {
    const tags = ["21-chiselled", "21-cs", "21-alpine"] as const;

    for (const source of SOURCES) {
      const root = await withDefaultLocale("en-US", () => source.order(tags));
      const czech = await withDefaultLocale("cs-CZ", () => source.order(tags));
      expect({ source: source.name, order: czech }).toEqual({
        source: source.name,
        order: root,
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
