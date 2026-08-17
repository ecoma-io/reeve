/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Remediation is proposal-only, and this file makes the boundary structural:
 * it reads the warrant, refuses an over-grant loudly, reads `review`'s owned
 * comment envelope, derives the proposals deterministically, and reports them
 * on the outputs and the job summary — and never touches a write route. No
 * model, no meter, no provider, no settleAuth: there is nothing this duty
 * spends, so there is no weather to report.
 *
 * The order:
 *
 *   1. Read the four inputs exactly as `action.yml` declares them — directly,
 *      not through `readCore`, which demands `base-url` and `models` this duty
 *      does not declare.
 *   2. Read the warrant, or build the implicit one, exactly as every other
 *      duty does. A `duties:` block that does not name `remediation` is
 *      checked here, once, before a single request — the summary says why, and
 *      the run is green.
 *   3. An over-grant fails red: if the warrant names `edit-file` or `open-pr`
 *      for this duty, the run throws. Those are the future fixing-PR stage's
 *      capabilities, and a silent inert grant must not read as authority.
 *   4. Read the review envelope from the pull request's own comment — the one
 *      read this duty makes. No envelope (or a corrupt one) is a clean stop.
 *   5. Derive one proposal per actionable finding (see `proposal.ts`).
 *   6. Report: the `proposed`/`proposals`/`note` outputs and the summary
 *      page — nothing else is ever written.
 *
 * This file is excluded from coverage because it calls `run()` at import; it
 * is exercised by driving the built bundle against a stub API — see
 * `main.integration.test.ts`.
 *
 * `createWeather()` is called with no arguments: there is no provider, so the
 * clean auth universe it builds renders no auth section, which is what a page
 * about a no-model run should show.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createWeather } from "../../core/provider.js";
import { writeRunSummary } from "../../core/summary.js";
import {
  openAuthority,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";
import { threadNumber } from "../../core/inputs.js";

import { REMEDIATION_DEFAULTS } from "./capabilities.js";
import { readEnvelope, type CommentApi } from "./envelope.js";
import { proposeAll, type RemediationProposal } from "./proposal.js";
import { page, report } from "./report.js";

/** Reads the inputs exactly as `action.yml` declares them — the contract test audits this file. */
function readSettings(): {
  readonly token: string;
  readonly number: number;
  readonly warrant: string;
  readonly dryRun: boolean;
} {
  return {
    token: core.getInput("github-token", { required: true }),
    number: threadNumber(),
    warrant: core.getInput("warrant"),
    dryRun: core.getBooleanInput("dry-run"),
  };
}

/**
 * The capabilities this boundary PR must never act on, even if a warrant
 * grants them. Failing red here is deliberate: `edit-file` and `open-pr` are
 * real, later capabilities for the fixing-PR stage, and a run that ignored an
 * over-grant would make the warrant read as more authority than this duty
 * actually holds.
 */
const FORBIDDEN: readonly Capability[] = ["edit-file", "open-pr"];

/** Whether the warrant granted a capability no proposal-only run may hold. */
function forRefusal(permitted: readonly Capability[]): Capability | null {
  return FORBIDDEN.find((capability) => permitted.includes(capability)) ?? null;
}

async function decide(
  api: CommentApi,
  at: { owner: string; repo: string; number: number },
  warrant: Warrant,
  dryRun: boolean,
): Promise<{ proposals: readonly RemediationProposal[]; note: string }> {
  const permitted = warrant.granted("remediation", REMEDIATION_DEFAULTS);

  const refused = forRefusal(permitted);
  if (refused !== null) {
    throw new Error(
      `remediation: the warrant grants \`${refused}\`, but the remediation boundary run is ` +
        `proposal-only. \`${refused}\` is not implemented yet; the fixing-PR duty ships in a ` +
        `later release, gated by the warrant exactly as everything else. Refusing loudly so a ` +
        `silent inert grant cannot read as authority.`,
    );
  }

  if (!permitted.includes("propose")) {
    return {
      proposals: [],
      note: `the warrant's \`duties:\` block does not name \`remediation\` — nothing was proposed.`,
    };
  }

  // The one read: review's owned comment on the pull request. No envelope (or
  // a corrupt one) is absent input, not a failure — the run stops clean.
  const envelope = await readEnvelope(api, at);
  if (envelope === null) {
    return {
      proposals: [],
      note: "no review envelope found on this pull request — nothing to propose.",
    };
  }
  if (envelope.findings.length === 0) {
    return {
      proposals: [],
      note: "the review envelope carries no actionable findings — nothing to propose.",
    };
  }

  const proposals = proposeAll(envelope);
  if (dryRun) {
    core.info(
      `Dry run — would have proposed ${String(proposals.length)} remediation record(s) to the summary.`,
    );
  }
  return { proposals, note: "" };
}

/** A real Octokit client satisfies the write-less `CommentApi` port directly. */
function wrapApi(api: ReturnType<typeof getOctokit>): CommentApi {
  return api;
}

export async function run(): Promise<void> {
  const weather = createWeather();
  let settings: ReturnType<typeof readSettings> | null = null;
  let authority: Authority | null = null;
  let outcome: { proposals: readonly RemediationProposal[]; note: string } | null = null;

  try {
    const read = readSettings();
    settings = read;
    const api = getOctokit(read.token);

    const opened = await openAuthority(read.warrant, api, context.repo, "remediation");
    authority = opened.authority;

    if (opened.denied) {
      outcome = {
        proposals: [],
        note: `the warrant's \`duties:\` block does not name \`remediation\` — nothing was proposed.`,
      };
    } else {
      outcome = await decide(
        wrapApi(api),
        { ...context.repo, number: read.number },
        authority.warrant,
        read.dryRun,
      );
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (settings !== null && authority !== null) {
      const chosen = outcome ?? {
        proposals: [],
        note: "the run stopped before proposing — see the log.",
      };
      report(chosen.proposals, chosen.note);
      await writeRunSummary(page(chosen.proposals, chosen.note, settings.dryRun), weather);
    }
  }
}

await run();
