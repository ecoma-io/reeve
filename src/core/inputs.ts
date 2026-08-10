/**
 * The inputs every duty shares, read in one place so they cannot drift.
 *
 * `github-token`, `base-url`, `api-key`, `models` and `dry-run` mean the same
 * thing in every duty's `action.yml`, and a consumer configuring their second
 * duty should not have to relearn any of them. Declaring them per duty and
 * parsing them per duty would make that a matter of everyone remembering; this
 * makes it a matter of one function.
 *
 * Every problem raised here is a typo in a workflow file, and it is raised
 * before a single request. A run that continued past one would work on a thread
 * nobody named or spend a provider's budget on a number that was never a
 * number.
 */
import * as core from "@actions/core";
import { context } from "@actions/github";

import { parseModels, type Names } from "./provider.js";

/** What every duty gets, whatever else its own `action.yml` declares. */
export interface Shared {
  readonly token: string;
  /** The thread to work on. */
  readonly number: number;
  /** Model ids in preference order. Never empty. */
  readonly models: readonly string[];
  /**
   * What to call each of them where a person will read it. Kept beside the ids
   * rather than folded into them, because everything between here and
   * publication works on the id a provider answers to and only the last step
   * has any business showing a name.
   */
  readonly modelNames: Names;
  readonly baseUrl: string;
  /** Empty for a keyless provider, which is a supported configuration. */
  readonly apiKey: string;
  readonly dryRun: boolean;
}

export function readShared(): Shared {
  const apiKey = core.getInput("api-key");
  // Registered before anything can log it. A `reason` from a provider quotes
  // the response body, and a gateway that echoes the request would otherwise
  // put the key in a public workflow log.
  if (apiKey.length > 0) core.setSecret(apiKey);

  const roster = parseModels(core.getInput("models", { required: true }));
  if (roster.models.length === 0) {
    throw new Error("models: no entries. Expected at least one model id.");
  }

  return {
    token: core.getInput("github-token", { required: true }),
    number: threadNumber(),
    models: roster.models,
    modelNames: roster.names,
    baseUrl: core.getInput("base-url", { required: true }),
    apiKey,
    dryRun: core.getBooleanInput("dry-run"),
  };
}

/**
 * Which thread to work on: the input when a backfill named one, otherwise the
 * thread that triggered the workflow.
 *
 * `context.issue.number` is `undefined` for an event that carries no thread — a
 * `schedule`, a `push`, a `workflow_dispatch` with nothing filled in. Saying so
 * is the difference between a run that explains itself and one that asks GitHub
 * for issue `NaN`.
 */
export function threadNumber(): number {
  const configured = core.getInput("number");
  if (configured.length > 0) return whole("number", configured);

  const triggered: number | undefined = context.issue.number;
  if (typeof triggered !== "number" || !Number.isInteger(triggered)) {
    throw new Error(
      // Read from the environment rather than from `context.eventName`, which
      // is typed as always present and is not: it is this variable.
      `number: this event (${process.env.GITHUB_EVENT_NAME ?? "unknown"}) names no issue or pull request, ` +
        "and no `number` input was given.",
    );
  }
  return triggered;
}

/** A count input, refused rather than coerced. `Number("")` is 0 and `Number("2x")` is NaN. */
export function whole(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name}: expected a whole number of 1 or more, got \`${raw}\`.`);
  }
  return value;
}
