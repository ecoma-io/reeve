/**
 * The SARIF 2.1.0 rendering of one run's standing findings — the half of the
 * review that GitHub code scanning can carry.
 *
 * This is an emission, not a write: the duty renders a file and names its
 * path in an output, and whether that file ever reaches code scanning is a
 * step the consumer's own workflow adds (`github/codeql-action/upload-sarif`,
 * under a `security-events: write` the consumer grants there). The warrant's
 * `comment` capability stays the only forge write this duty has, which is why
 * `main.ts` emits the file only on the paths where the comment itself was
 * admitted — the confidence floor, the silent-no-verdict guard and the
 * ignore-swept guard withhold both or neither, and a dry run still renders
 * the file because rendering is the whole point of a rehearsal.
 *
 * Two properties the lifecycle depends on:
 *
 * - **The fingerprint is the finding's intention** — `ruleId` + `path`, the
 *   same key `reconcile` uses to read line movement as `changed` rather than
 *   a newborn claim, and the same key a disposition rides. Line movement
 *   keeps the alert open exactly as it keeps the thread, and the moved line
 *   still shows in the result's location.
 * - **A resolved finding is absent, deliberately.** Code scanning closes an
 *   alert missing from the newest upload — absence here is exactly the
 *   `resolved` rung of the lifecycle, with no second state machine to drift.
 *
 * Deterministic by construction: rules and results are byte-sorted by id, so
 * two runs over the same reconciliation produce identical text.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitize } from "../../core/sanitize.js";
import type { Reconciled } from "./findings.js";

/** SARIF caps one message at what a reader (and the upload API) tolerates. */
const MAX_MESSAGE_CHARS = 1000;

const LEVELS: Readonly<Record<"info" | "warning" | "critical", string>> = {
  info: "note",
  warning: "warning",
  critical: "error",
};

/**
 * Renders the standing findings — every status but `resolved` — as a SARIF
 * 2.1.0 document. The model's prose passes the same `sanitize` the comment
 * pipeline uses before it lands in `message.text`: code scanning renders the
 * text in its own UI, which makes it one more surface an injected diff would
 * love to reach unescorted.
 */
export function buildSarif(reconciled: readonly Reconciled[], headSha: string): string {
  const standing = reconciled
    .filter((entry) => entry.status !== "resolved")
    .slice()
    .sort((a, b) => (a.finding.id < b.finding.id ? -1 : a.finding.id > b.finding.id ? 1 : 0)); // byte order, so no collation can flip the run

  const ruleIds = [...new Set(standing.map((entry) => entry.finding.ruleId))].sort(); // byte order
  const rules = ruleIds.map((id) => {
    const carrier = standing.find((entry) => entry.finding.ruleId === id);
    const name = carrier?.finding.ruleName ?? id;
    return {
      id,
      name,
      shortDescription: { text: sanitize(name.length > 0 ? name : id) },
    };
  });

  const results = standing.map((entry) => {
    const { finding } = entry;
    // Every rung of the fallback chain passes `sanitize`, not just the first.
    // `ruleName` is the model's own claimed rule id whenever that id names no
    // rule the repository declared (`toFinding` in `main.ts` falls back to it),
    // so the rung that catches a model which returned no body is a rung
    // carrying model prose — and it lands in the same rendered surface the
    // body would have. Trimming each rung is what makes the chain descend on
    // whitespace instead of emitting it.
    const prose = sanitize(finding.body).trim();
    const named = sanitize(finding.ruleName).trim();
    const text = (
      prose.length > 0 ? prose : named.length > 0 ? named : sanitize(finding.ruleId)
    ).slice(0, MAX_MESSAGE_CHARS);
    return {
      ruleId: finding.ruleId,
      ruleIndex: ruleIds.indexOf(finding.ruleId),
      level: LEVELS[finding.severity],
      message: { text },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: finding.path, uriBaseId: "%SRCROOT%" },
            ...(finding.line === null ? {} : { region: { startLine: finding.line } }),
          },
        },
      ],
      // The intention key, not `finding.id`: the id carries the line, and a
      // fingerprint that moved with the line would close and reopen the alert
      // on every drift the lifecycle deliberately reads as `changed`.
      partialFingerprints: { "reeveFinding/v1": `${finding.ruleId}|${finding.path}` },
    };
  });

  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "reeve-review",
              informationUri: "https://github.com/ecoma-io/reeve",
              rules,
            },
          },
          results,
          properties: { headSha },
        },
      ],
    },
    null,
    2,
  );
}

/**
 * Renders and writes this run's SARIF file, and answers where it landed.
 *
 * The one filesystem write this duty makes, deliberately quarantined in this
 * module: the target is the runner's own temp directory — `RUNNER_TEMP` —
 * never the checkout, so the capability contract's workspace-write guard can
 * exempt exactly this file while a companion test pins that the module never
 * so much as names the workspace. See `capabilities.contract.test.ts`.
 */
export async function emitSarif(
  reconciled: readonly Reconciled[],
  headSha: string,
): Promise<string> {
  const path = join(process.env.RUNNER_TEMP ?? tmpdir(), "reeve-review.sarif");
  await writeFile(path, buildSarif(reconciled, headSha), "utf8");
  return path;
}
