/**
 * Tests for the mutation harness's own failure detection.
 *
 * The repository ranks `pnpm test:mutation` first among its gates — it is the
 * only one that measures whether the suite would *fail* on a regression rather
 * than merely that the code ran — and until this file existed that gate had no
 * tests at all. That gap was not theoretical: an adversarial review emptied
 * `MUTATIONS` and the harness printed `KILLED 0 · SURVIVED 0 · STALE 0` and
 * exited 0.
 *
 * **Every branch tested below runs only when something has already gone
 * wrong** — an emptied table, a `from` string that stopped matching, a `from`
 * that matches two places. None of them executes during a passing run, which
 * makes them exactly the code that can rot for a year without anyone noticing.
 * Verifying them by hand once, as was done when they were written, does not
 * re-verify them after the next edit. That is the whole argument for this file.
 *
 * It deliberately does NOT test that mutation testing works — that would be a
 * harness testing itself, and the evidence for it is the board the harness
 * prints. What it tests is narrower and ordinary: given these inputs, does this
 * script refuse. The judgement is separated from the filesystem in
 * `mutation.mjs` for the same reason `scripts/check-docs-links.mjs` separates
 * `evaluate` from `readFacts`, so nothing below needs a filesystem or a mock.
 *
 * `node --test`, not vitest: `tools/` is outside the root vitest config's
 * `include` glob, and the repository already runs `scripts/**` this way.
 */
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { MUTATIONS, checkTable, classifyRow, commentOnlyAnchor, verdict } from "./mutation.mjs";

/** A structurally valid row. Only the fields under test carry meaning. */
function row(over = {}) {
  return {
    name: "a named regression",
    file: "src/core/provider.ts",
    from: "needle",
    to: "haystack",
    targets: ["src/core/provider.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "One sentence naming the regression.",
    ...over,
  };
}

describe("checkTable — a gate cannot be disarmed by deleting its contents", () => {
  it("refuses an empty table rather than reporting a pass", () => {
    const why = checkTable([], 1);
    notStrictEqual(why, null);
    match(why, /empty/);
    match(why, /failure and not a pass/);
  });

  it("refuses a table that has shrunk below the recorded floor", () => {
    const why = checkTable([row(), row({ name: "another" })], 3);
    notStrictEqual(why, null);
    match(why, /2 rows/);
    match(why, /floor is 3/);
  });

  it("says how to retire a row properly, so the refusal is actionable", () => {
    // A refusal that does not name the correct fix invites the incorrect one,
    // which here is lowering the floor to whatever makes the run green.
    match(checkTable([row()], 2), /re-pointing it at the seam the code moved to/);
  });

  it("allows a table at the floor, and above it", () => {
    strictEqual(checkTable([row(), row({ name: "b" })], 2), null);
    strictEqual(checkTable([row(), row({ name: "b" }), row({ name: "c" })], 2), null);
  });

  it("holds the shipped table to its own recorded floor", () => {
    // The end-to-end form of the two cases above: whatever `TABLE_FLOOR` says,
    // the table that ships must satisfy it. This is the assertion that goes red
    // when rows are deleted and the constant is not.
    strictEqual(checkTable(MUTATIONS), null);
  });
});

describe("classifyRow — a `from` that stopped applying is a gate that stopped existing", () => {
  it("reports a `from` that matches nothing", () => {
    const why = classifyRow(row({ from: "gone" }), "the file no longer says that");
    notStrictEqual(why, null);
    match(why, /no match for/);
  });

  it("reports a `from` that matches more than one place", () => {
    // `String.replace` with a string pattern rewrites only the FIRST match, so
    // an ambiguous `from` silently mutates a seam nobody chose and reports
    // whatever the targets said about it as the verdict.
    const why = classifyRow(row({ from: "if (dryRun) {" }), "if (dryRun) {\nif (dryRun) {\n");
    notStrictEqual(why, null);
    match(why, /matches 2 places/);
    match(why, /ambiguous/);
  });

  it("passes a `from` that matches exactly once", () => {
    strictEqual(classifyRow(row({ from: "if (dryRun) {" }), "before\nif (dryRun) {\nafter"), null);
  });

  it("reports a `from` disambiguated only by its comment line", () => {
    // Two copies of the seam, distinguished only by a comment. The code lines
    // alone match twice, so `String.replace` mutates whichever copy comes
    // first while the copy whose invariant the row claims to gate goes
    // ungated — STALE, exactly as if the `from` matched nothing.
    const text =
      "  // copy A\n  if (dryRun) {\n  return null;\n  }\n  // copy B\n  if (dryRun) {\n  return null;\n  }";
    const why = classifyRow(row({ from: "  // copy B\n  if (dryRun) {" }), text);
    notStrictEqual(why, null);
    match(why, /comment/);
    match(why, /Re-anchor/);
  });

  it("passes a comment-carrying `from` whose code is the unique seam", () => {
    // The comment is incidental: strip it and the code still matches exactly
    // once, so the row gates real code and no comment disambiguation is going on.
    strictEqual(
      classifyRow(
        row({ from: "  // the seam\n  if (dryRun) {" }),
        "  // the seam\n  if (dryRun) {\n  return null;\n  }\n",
      ),
      null,
    );
  });

  it("counts overlapping occurrences rather than stepping past them", () => {
    // `aa` occurs twice in `aaa`, overlapping. A counter that advanced by the
    // needle's length would call that one and pass an ambiguous row.
    match(classifyRow(row({ from: "aa" }), "aaa"), /matches 2 places/);
  });

  it("abbreviates a long multi-line `from` in the message rather than dumping it", () => {
    const why = classifyRow(row({ from: `${"x".repeat(200)}\n${"y".repeat(200)}` }), "nothing");
    ok(why.length < 120, `message should be abbreviated, got ${String(why.length)} chars`);
    match(why, /…/);
  });
});

describe("verdict — a red run proves the mutation only if the pristine run is green", () => {
  it("reports a failure that the pristine run passes as KILLED", () => {
    deepStrictEqual(verdict(1, 0), { killed: true });
  });

  it("reports a pass under mutation as SURVIVED, whatever the pristine did", () => {
    deepStrictEqual(verdict(0, 1), { killed: false });
    deepStrictEqual(verdict(0, 0), { killed: false });
  });

  it("refuses to credit a mutation for a failure the pristine run already has", () => {
    // The defect TESTGATE-01 exists to stop: several rows share `targets`, so
    // without this a pre-existing failure in a shared file would report a
    // seam KILLED that the mutation never touched, handing the gate green
    // over an ungated invariant.
    deepStrictEqual(verdict(1, 1), { killed: false, cause: "pristine failure" });
  });
});

describe("commentOnlyAnchor — a seam is code, not the words beside it", () => {
  it("returns null for a `from` with no comment line", () => {
    strictEqual(commentOnlyAnchor(row({ from: "if (dryRun) {" }), "if (dryRun) {"), null);
  });

  it("returns null when the code lines alone still name one seam", () => {
    strictEqual(
      commentOnlyAnchor(
        row({ from: "  // the seam\n  if (dryRun) {" }),
        "  // the seam\n  if (dryRun) {\n  return null;\n  }\n",
      ),
      null,
    );
  });

  it("reports a `from` whose code exists identically elsewhere", () => {
    const text =
      "  // copy A\n  if (dryRun) {\n  return null;\n  }\n  // copy B\n  if (dryRun) {\n  return null;\n  }";
    const why = commentOnlyAnchor(row({ from: "  // copy B\n  if (dryRun) {" }), text);
    notStrictEqual(why, null);
    match(why, /code exists identically elsewhere/);
  });

  it("does not choke on a `from` that is only a comment", () => {
    strictEqual(
      commentOnlyAnchor(row({ from: "  // comment" }), "  // comment\n  // comment"),
      null,
    );
  });
});

describe("the shipped table is structurally sound", () => {
  it("gives every row the fields the runner and the report both read", () => {
    for (const mutation of MUTATIONS) {
      const missing = ["name", "file", "from", "to", "targets", "stage", "owner", "note"].filter(
        (key) => mutation[key] === undefined,
      );
      deepStrictEqual(missing, [], `${String(mutation.name)} is missing ${missing.join(", ")}`);
      ok(mutation.targets.length > 0, `${mutation.name} names no targets`);
      ok(["fast", "full"].includes(mutation.stage), `${mutation.name} has stage ${mutation.stage}`);
      ok(/^TL\d$/.test(mutation.owner), `${mutation.name} has owner ${mutation.owner}`);
      notStrictEqual(mutation.from, mutation.to, `${mutation.name} is a no-op edit`);
    }
  });

  it("gives every entry-point row a `rebuilds` bundle to put back", () => {
    // An entry-point row's target suite rebuilds the duty's committed bundle
    // from the mutated source. Without `rebuilds`, the harness restores the
    // source and leaves the MUTATED BUNDLE in the working tree, where it reads
    // as ordinary build drift and can be committed. Forgetting the field is
    // silent, and this is the only thing that would say so.
    for (const mutation of MUTATIONS) {
      if (!/\/main\.ts$/.test(mutation.file)) continue;
      ok(
        typeof mutation.rebuilds === "string" && mutation.rebuilds.length > 0,
        `${mutation.name} mutates an entry point but names no \`rebuilds\` bundle`,
      );
      ok(
        mutation.file.includes(`/${mutation.rebuilds}/`),
        `${mutation.name} rebuilds \`${String(mutation.rebuilds)}\`, which is not its own duty`,
      );
    }
  });

  it("only claims a rebuild where one actually happens", () => {
    // The mirror: a `rebuilds` on a row that mutates a unit seam would stash
    // and restore a bundle nothing rebuilt — harmless, but it would mean the
    // field had stopped describing anything, which is how a field drifts into
    // decoration.
    for (const mutation of MUTATIONS) {
      if (mutation.rebuilds === undefined) continue;
      ok(
        /\/main\.ts$/.test(mutation.file),
        `${mutation.name} names \`rebuilds\` but does not mutate an entry point`,
      );
    }
  });

  it("never repeats a name", () => {
    // Names are the addressing scheme twice over: `--only` matches a substring
    // of one, and the scratch file each row stashes its original under is
    // derived from one. Two rows sharing a name make the board ambiguous and
    // the scratch path collide.
    const names = MUTATIONS.map((mutation) => mutation.name);
    deepStrictEqual(
      names.filter((n, i) => names.indexOf(n) !== i),
      [],
    );
  });

  it("no row's `from` is disambiguated only by a comment line", () => {
    // The regression this guard exists to catch: two copies of a seam differ
    // only by a comment, and a `from` that leaned on the comment would mutate
    // whichever copy came first while the invariant the row claims to gate
    // went ungated. The re-anchored state-branch and threads rows were the
    // live examples; this keeps the whole table honest against the check.
    for (const mutation of MUTATIONS) {
      const text = readFileSync(mutation.file, "utf8");
      strictEqual(
        commentOnlyAnchor(mutation, text),
        null,
        `${mutation.name} is anchored only on a comment line; re-anchor its \`from\` on a seam-unique non-comment token`,
      );
    }
  });
});
