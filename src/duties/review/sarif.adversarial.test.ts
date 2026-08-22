/**
 * The SARIF emission: where the file lands, and what a degenerate finding
 * does to the document a consumer's security tooling ingests.
 *
 * `sarif.test.ts` covers the rendering of well-formed findings. Two things it
 * does not touch are exactly the two a consumer feels:
 *
 * - **`emitSarif` itself** — the duty's one filesystem write. It is quarantined
 *   to the runner's temp directory so the capability contract can exempt it by
 *   module; `capabilities.contract.test.ts` pins that the source never *names*
 *   the workspace, and nothing pinned where the file actually lands. These
 *   cases run the write.
 * - **A finding with nothing in it.** `message.text` is required by the schema
 *   and an empty one is rejected by the upload API, so every fallback in the
 *   chain — body, then rule name, then rule id — has to end somewhere non-empty
 *   whatever a model returned.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSarif, emitSarif } from "./sarif.js";
import type { Finding, Reconciled, Status } from "./findings.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "dedup:src/a.ts",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "Flag code that is repeated.",
    path: "src/a.ts",
    line: 12,
    severity: "warning",
    body: "The same helper is defined twice.",
    marker: "",
    ...overrides,
  };
}

function entry(status: Status, overrides: Partial<Finding> = {}): Reconciled {
  return { finding: finding(overrides), status, disposition: null };
}

interface Document {
  runs: {
    tool: { driver: { rules: { id: string; name: string; shortDescription: { text: string } }[] } };
    results: { ruleId: string; message: { text: string } }[];
  }[];
}

const parse = (text: string): Document => JSON.parse(text) as Document;

describe("a finding the model left empty still renders a usable alert", () => {
  it("names the rule by its id when the model returned no rule name", () => {
    // `shortDescription` is what code scanning shows as the rule's title. A
    // model that answered with a rule id and no name must not produce a rule
    // whose title is the empty string.
    const doc = parse(buildSarif([entry("created", { ruleName: "" })], "sha"));

    expect(doc.runs[0]?.tool.driver.rules[0]?.shortDescription.text).toBe("dedup");
  });

  it("falls all the way back to the rule id when body and rule name are both empty", () => {
    // The last rung of the fallback chain. An empty `message.text` is rejected
    // by the upload API, so a whole run's alerts would be lost to one hollow
    // finding.
    const doc = parse(buildSarif([entry("created", { body: "   ", ruleName: "" })], "sha"));

    expect(doc.runs[0]?.results[0]?.message.text).toBe("dedup");
  });

  it("stays parseable JSON when the model's prose is full of quotes and newlines", () => {
    // The document is assembled by `JSON.stringify`, not by string
    // concatenation, and this is the case that proves it: a body that closes a
    // string and opens a key would otherwise write its own fields.
    const hostile = '", "level": "error", "injected": "\n\\ ' + "`</script>`";
    const doc = parse(buildSarif([entry("created", { body: hostile })], "sha"));

    expect(doc.runs[0]?.results).toHaveLength(1);
    expect(doc.runs[0]?.results[0]?.message.text).toContain("injected");
  });
});

describe("the model's prose is contained before code scanning renders it", () => {
  // `message.text` and the rule's `shortDescription` are rendered by GitHub's
  // own UI, which makes them one more surface an injected diff would like to
  // reach unescorted. Every reference in them is also a REPOST: an `@name` in
  // an alert notifies that person again, and a `#42` writes another
  // cross-reference into issue 42. The publish path defangs both; these cases
  // pin that this path does too.

  it("defangs the mentions and issue references the model wrote into a finding body", () => {
    const doc = parse(buildSarif([entry("created", { body: "cc @johnitvn about #42" })], "sha"));

    expect(doc.runs[0]?.results[0]?.message.text).toBe("cc @<!---->johnitvn about #<!---->42");
  });

  it("defangs them in the rule title as well as in the message", () => {
    const doc = parse(buildSarif([entry("created", { ruleName: "cc @johnitvn" })], "sha"));

    expect(doc.runs[0]?.tool.driver.rules[0]?.shortDescription.text).toBe("cc @<!---->johnitvn");
  });

  it("defangs the rule name the message falls back to when the model sent no body", () => {
    // The rung that used to be raw. `ruleName` is the model's own claimed rule
    // id whenever that id names no declared rule, so a model that answers with
    // a mention for a rule id and an empty body reaches `message.text` with it
    // — through the fallback, past the `sanitize` the body rung applies.
    const doc = parse(
      buildSarif([entry("created", { body: "  ", ruleName: "cc @johnitvn" })], "sha"),
    );

    expect(doc.runs[0]?.results[0]?.message.text).toBe("cc @<!---->johnitvn");
  });

  it("descends to the rule id when the rule name is nothing but whitespace", () => {
    // An empty `message.text` is rejected by the upload API, and whitespace is
    // how a fallback chain that tests truthiness rather than content emits one:
    // `"   "` is truthy, so the chain used to stop there and ship blanks.
    const doc = parse(buildSarif([entry("created", { body: "", ruleName: "   " })], "sha"));

    expect(doc.runs[0]?.results[0]?.message.text).toBe("dedup");
  });

  it("empties a hidden HTML comment the model buried in the body", () => {
    // An unclosed `<!--` swallows everything after it in GitHub's renderer,
    // and a closed one hides its payload from the reader entirely.
    const doc = parse(
      buildSarif([entry("created", { body: "visible <!-- hidden --> tail" })], "sha"),
    );

    expect(doc.runs[0]?.results[0]?.message.text).toBe("visible <!-- ------ --> tail");
  });
});

describe("emitSarif", () => {
  let runnerTemp: string;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.RUNNER_TEMP;
    runnerTemp = await mkdtemp(join(tmpdir(), "reeve-sarif-"));
    process.env.RUNNER_TEMP = runnerTemp;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
    await rm(runnerTemp, { recursive: true, force: true });
  });

  it("writes the rendering into the runner's temp directory and answers where", async () => {
    const reconciled = [entry("created")];

    const path = await emitSarif(reconciled, "abc123");

    expect(dirname(path)).toBe(runnerTemp);
    expect(await readFile(path, "utf8")).toBe(buildSarif(reconciled, "abc123"));
  });

  it("writes nowhere but that directory — the checkout is never a target", async () => {
    // The workspace-write ban in `capabilities.contract.test.ts` is a source
    // scan; this is the same claim at runtime. One file, in the directory the
    // runner throws away, named predictably enough for a consumer's upload
    // step to find it.
    await emitSarif([entry("created")], "abc123");

    expect(await readdir(runnerTemp)).toEqual(["reeve-review.sarif"]);
  });

  it("overwrites its own file on a rerun rather than leaving two uploads behind", async () => {
    // Code scanning closes an alert missing from the NEWEST upload, so a
    // second file beside the first would be a second run's worth of alerts
    // fighting over the same PR — and an appended one would not parse at all.
    await emitSarif([entry("created", { id: "a:x", ruleId: "a" })], "sha1");
    const second = await emitSarif([entry("created", { id: "b:x", ruleId: "b" })], "sha2");

    expect(await readdir(runnerTemp)).toEqual(["reeve-review.sarif"]);
    const doc = parse(await readFile(second, "utf8"));
    expect(doc.runs[0]?.results.map((result) => result.ruleId)).toEqual(["b"]);
  });

  it("emits the same bytes twice for the same reconciliation", async () => {
    // The rerun's file is byte-identical, which is what lets a consumer diff
    // two uploads and see only what the diff changed.
    const reconciled = [entry("persists"), entry("created", { id: "b:y", ruleId: "b" })];

    const first = await readFile(await emitSarif(reconciled, "abc123"), "utf8");
    const second = await readFile(await emitSarif(reconciled, "abc123"), "utf8");

    expect(first).toBe(second);
  });

  it("falls back to the OS temp directory when the runner set no RUNNER_TEMP", async () => {
    // A local `pnpm try` run has no `RUNNER_TEMP`. Rendering the file is the
    // whole point of a rehearsal, so it goes somewhere disposable rather than
    // failing or reaching for the checkout.
    delete process.env.RUNNER_TEMP;

    const path = await emitSarif([entry("created")], "abc123");

    expect(dirname(path)).toBe(tmpdir());
    await rm(path, { force: true });
  });
});
