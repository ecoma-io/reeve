/**
 * The correction store against lines nobody's run wrote.
 *
 * A correction is evidence shown to a model as a worked example of what this
 * project already decided. That makes the store the one place where a line
 * read wrongly does not fail a run — it teaches one. So the interesting cases
 * are not corrupt-looking lines (`memory.test.ts` has those) but lines that
 * parse into something *plausible and wrong*: a reversal read as an
 * endorsement, a target read as a thread that does not exist, a key that
 * reaches past the record it sits in.
 *
 * The rule the file pins throughout: a field that cannot be read as what it
 * claims to be either defaults to nothing or takes the whole line down. It is
 * never guessed at.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCorrection, readStore } from "./memory.js";

const DECISION = '"thread":7,"decided":["bug"]';

describe("`outcome` is the field that refuses the line rather than defaulting", () => {
  it.each([
    ["a kind this build does not know yet", '"endorsed"'],
    ["the known kind in the wrong case", '"OVERRULED"'],
    ["the known kind with whitespace around it", '" overruled "'],
    ["a boolean", "true"],
    ["a number", "0"],
    ["an array holding it", '["overruled"]'],
    ["an object holding it", '{"kind":"overruled"}'],
  ])("refuses the whole correction when `outcome` is %s", (_case, outcome) => {
    // Read as `null` instead, this line would be served as an ordinary worked
    // example — a mistake a human already took back, shown to the model as
    // the thing to do again. That is the one misreading the store cannot
    // survive, so the enum is strict where every other field defaults.
    expect(parseCorrection(`{${DECISION},"outcome":${outcome}}`)).toBeNull();
  });

  it("reads the one known kind, and an absent one, as themselves", () => {
    expect(parseCorrection(`{${DECISION},"outcome":"overruled"}`)?.outcome).toBe("overruled");
    expect(parseCorrection(`{${DECISION},"outcome":null}`)?.outcome).toBeNull();
    expect(parseCorrection(`{${DECISION}}`)?.outcome).toBeNull();
  });
});

describe("a target a run would state as fact is read as digits or not at all", () => {
  it.each([
    ["zero, which is not an issue number", "0"],
    ["a negative", "-7"],
    ["a fraction", "7.5"],
    ["digits as a string", '"7"'],
    ["an overflow JSON is happy to encode", "1e999"],
    ["a null", "null"],
  ])("reads `duplicateOf` of %s as no target rather than a claim", (_case, value) => {
    // `renderRecall` states this number as a fact — "automation closed this
    // thread as a duplicate of #N". A value that is not an issue number must
    // not become that sentence.
    expect(parseCorrection(`{${DECISION},"duplicateOf":${value}}`)?.duplicateOf).toBeNull();
  });

  it.each([
    ["an infinity", "1e999"],
    ["a fraction", "7.5"],
    ["a string", '"7"'],
  ])("refuses the whole line when the thread number is %s", (_case, value) => {
    expect(parseCorrection(`{"thread":${value},"decided":["bug"]}`)).toBeNull();
  });
});

describe("a store line cannot reach past the record it sits in", () => {
  it("does not let a `__proto__` key in a line reach Object.prototype", () => {
    const parsed = parseCorrection(`{${DECISION},"__proto__":{"duty":"admin"}}`);

    expect(parsed?.duty).toBe("triage");
    expect(({} as Record<string, unknown>).duty).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("duty");
  });

  it("does not let a `constructor` key in a line decide a defaulted field", () => {
    // `record.duty` is read with a typeof check rather than a truthiness one,
    // so an inherited function is not a string and the default stands.
    const parsed = parseCorrection(`{${DECISION},"constructor":"admin","toString":"admin"}`);

    expect(parsed?.duty).toBe("triage");
    expect(parsed?.repo).toBe("");
  });

  it("keeps a `decided` list that is not all strings out of the store entirely", () => {
    // Half a label list is a decision with the decision missing.
    expect(parseCorrection(`{"thread":7,"decided":["bug",{"name":"security"}]}`)).toBeNull();
    expect(parseCorrection(`{"thread":7,"decided":["bug",null]}`)).toBeNull();
  });
});

describe("a shard directory written to be read as more than it is", () => {
  async function store(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "reeve-memory-adversarial-"));
    const path = join(root, "corrections");
    await mkdir(path);
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(path, name), contents);
    }
    return path;
  }

  it("names every line it could not read rather than reading a shorter store quietly", async () => {
    // A shard of unreadable lines must not come back as "this project has
    // corrected nothing" — that reads exactly like a healthy cold start.
    const path = await store({
      "2026-01.ndjson": [
        `{${DECISION},"outcome":"endorsed"}`,
        "{ not json",
        `{${DECISION}}`,
        '{"thread":7}',
      ].join("\n"),
    });

    const { corrections, unreadable } = await readStore(path);

    expect(corrections).toHaveLength(1);
    expect(unreadable).toHaveLength(3);
    expect(unreadable.every((line) => /2026-01\.ndjson:\d+ is not a correction/.test(line))).toBe(
      true,
    );
  });

  it("reads only the shards the directory itself holds, not a nested one", async () => {
    // A directory named like a shard is not a shard, and a shard inside it is
    // not part of this store: the walk is one level deep on purpose.
    const path = await store({ "2026-01.ndjson": `{${DECISION}}\n` });
    await mkdir(join(path, "nested.ndjson"));
    await writeFile(join(path, "nested.ndjson", "2026-02.ndjson"), `{"thread":9,"decided":[]}\n`);

    const { corrections, unreadable } = await readStore(path);

    expect(corrections.map((entry) => entry.thread)).toEqual([7]);
    // And the directory it could not read is reported, never silently dropped.
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain("nested.ndjson");
  });
});
