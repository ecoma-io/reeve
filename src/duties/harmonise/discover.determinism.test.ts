/**
 * DETERMIN — what `harmonise` discovers, and in what order, given the same
 * repository listed differently.
 *
 * `discoverGroups` is handed `listRepositoryFiles`'s output, which is every
 * blob of one `git.getTree(recursive)` response in whatever order the endpoint
 * served it. Nothing between the API and this function sorts — neither
 * `harmonise/main.ts:898` nor `dependa/main.ts:828` touches the order — so this
 * function's argument carries the tracker's listing order verbatim.
 *
 * The half that must hold, and does: **the same set of paths discovers the same
 * document groups, with the same members, however the listing was ordered.**
 * A locale variant that appeared or vanished with a re-listing would mean a
 * translation silently stopped being synchronised.
 *
 * The half that does not, pinned as found: **the order groups come back in is
 * the listing's**, and two things read it —
 *
 *  - `main.ts` walks the groups in that order and breaks out at `settings.limit`
 *    ("sweep limit reached — remaining document groups were not attempted"), so
 *    which documents a capped run synchronises is decided by the listing;
 *  - each group's `files` map is in listing order too, and it reaches the model:
 *    `findOrCreate` seeds a fresh provenance record from it, `markStale` walks
 *    `doc.files` to build `doc.stale`, and `main.ts` shows the classifier
 *    `staleWithFile[0]`'s content as the context for the whole group.
 *
 * Neither is a live flake today — the git tree API is stable for a given commit
 * and the provenance file, once written, is committed — but neither is pinned
 * by anything, and the sort that would settle both is one line. Reported rather
 * than fixed: capping a walk in byte order rather than listing order changes
 * which documents a capped run touches, which is a decision about the duty.
 */
import { describe, expect, it } from "vitest";

import * as fc from "fast-check";

import { parseLanguages } from "../../core/languages.js";

import { discoverGroups, type DocumentGroup } from "./discover.js";

const SOURCE = parseLanguages("en")[0];
const TARGETS = parseLanguages("vi, zh");

if (SOURCE === undefined) throw new Error("`en` must parse as a language");

/** A small documentation tree with three groups and both target locales. */
const PATHS = [
  "README.md",
  "README.vi.md",
  "README.zh.md",
  "docs/getting-started.md",
  "docs/getting-started.vi.md",
  "docs/getting-started.zh.md",
  "docs/deploy/runbook.md",
  "docs/deploy/runbook.vi.md",
  "images/flow.png",
  "src/index.ts",
] as const;

/** A group rendered as plain data, so two discoveries compare by content rather than by Map identity. */
function contentOf(groups: readonly DocumentGroup[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const group of groups) out[group.id] = Object.fromEntries(group.files);
  return out;
}

const permutationOfPaths = fc.shuffledSubarray([...PATHS], {
  minLength: PATHS.length,
  maxLength: PATHS.length,
});

// ── The half that holds ──────────────────────────────────────────────────

describe("discoverGroups — the groups themselves do not move with the listing", () => {
  it("discovers the same groups, with the same members, for any permutation of the tree", () => {
    const reference = contentOf(discoverGroups(PATHS, SOURCE, TARGETS, []));
    expect(Object.keys(reference).sort()).toEqual([
      "README",
      "docs/deploy/runbook",
      "docs/getting-started",
    ]);

    fc.assert(
      fc.property(permutationOfPaths, (listing) => {
        expect(contentOf(discoverGroups(listing, SOURCE, TARGETS, []))).toEqual(reference);
        return true;
      }),
      { numRuns: 300, seed: 20_260_821 },
    );
  });

  it("scopes the same groups under a `paths` filter, whatever the listing order", () => {
    // The filter is the last gate and reads the whole member set, so a listing
    // that presented a group's variants before its source — or the other way
    // round — must reach the same answer.
    fc.assert(
      fc.property(
        permutationOfPaths,
        fc.constantFrom(["README.md"], ["docs/"], ["docs/deploy/"], ["nothing/"]),
        (listing, filter) => {
          expect(contentOf(discoverGroups(listing, SOURCE, TARGETS, filter))).toEqual(
            contentOf(discoverGroups(PATHS, SOURCE, TARGETS, filter)),
          );
          return true;
        },
      ),
      { numRuns: 200, seed: 20_260_821 },
    );
  });

  it("bootstraps the same derived paths for a missing locale, whatever the listing order", () => {
    // Bootstrap invents a member (`<base>.<locale>.md`) for a locale with no
    // file. The invented path is derived from the group id and the configured
    // language, so it must not move either — a bootstrap that named a different
    // file per run would create a second translation rather than fill the gap.
    const reference = contentOf(discoverGroups(PATHS, SOURCE, TARGETS, [], true));
    expect(reference["docs/deploy/runbook"]?.zh).toBe("docs/deploy/runbook.zh.md");

    fc.assert(
      fc.property(permutationOfPaths, (listing) => {
        expect(contentOf(discoverGroups(listing, SOURCE, TARGETS, [], true))).toEqual(reference);
        return true;
      }),
      { numRuns: 200, seed: 20_260_821 },
    );
  });
});

// ── The half that does not ───────────────────────────────────────────────

describe("ADJUDICATE: the order is the listing's, and two decisions read it", () => {
  it("returns the groups in the order the tree listed their first member", () => {
    const asListed = discoverGroups(PATHS, SOURCE, TARGETS, []).map((g) => g.id);
    const reversed = discoverGroups([...PATHS].reverse(), SOURCE, TARGETS, []).map((g) => g.id);

    expect(asListed).toEqual(["README", "docs/getting-started", "docs/deploy/runbook"]);
    expect(reversed).toEqual(["docs/deploy/runbook", "docs/getting-started", "README"]);
    expect(reversed).not.toEqual(asListed);

    // What that costs: `main.ts` breaks out of the walk at `settings.limit`, so
    // a run capped at one group synchronises `README` from one listing and
    // `docs/deploy/runbook` from the other — same commit, same warrant.
    expect(asListed.slice(0, 1)).not.toEqual(reversed.slice(0, 1));
  });

  it("orders each group's locales by the listing, which is what the classifier's context follows", () => {
    // `findOrCreate` seeds a fresh provenance record with `new Map(files)`,
    // `markStale` walks `doc.files` in that order to build `doc.stale`, and
    // `main.ts` reads `staleWithFile[0]` — so the first target locale here is
    // the translation whose current text is shown to the classifying model as
    // the context for the whole document group.
    const viFirst = discoverGroups(
      ["README.md", "README.vi.md", "README.zh.md"],
      SOURCE,
      TARGETS,
      [],
    );
    const zhFirst = discoverGroups(
      ["README.md", "README.zh.md", "README.vi.md"],
      SOURCE,
      TARGETS,
      [],
    );

    expect([...(viFirst[0]?.files.keys() ?? [])]).toEqual(["en", "vi", "zh"]);
    expect([...(zhFirst[0]?.files.keys() ?? [])]).toEqual(["en", "zh", "vi"]);
    // The membership is identical; only the walk order differs.
    expect(contentOf(zhFirst)).toEqual(contentOf(viFirst));

    // Question for adjudication: should `discoverGroups` return its groups in
    // byte order of `id`, and each group's `files` in the configured language
    // order (source first, then `languages` as written)? Both are orders the
    // repository controls; the listing is not.
  });

  it("bootstrap appends its derived locales after whatever the listing already had", () => {
    // A newly configured language enters `files` at the end, so it is last in
    // `doc.stale` too — meaning the locale most likely to be missing entirely
    // is the one least likely to be the classifier's context. Recorded here
    // because it is the same ordering rule seen from the other side, not a
    // second finding.
    const only = discoverGroups(["README.md", "README.zh.md"], SOURCE, TARGETS, [], true);
    expect([...(only[0]?.files.keys() ?? [])]).toEqual(["en", "zh", "vi"]);
    expect(only[0]?.files.get("vi")).toBe("README.vi.md");
  });
});
