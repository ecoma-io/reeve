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
  /**
   * The thread to work on, or null in `sweep` — a sweep does not name one
   * thread, it works the backlog.
   */
  readonly number: number | null;
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
  /** Whether this run works the backlog instead of the one thread the event named. */
  readonly sweep: boolean;
  /**
   * The oldest thread a sweep will consider, by creation date — never null once
   * `sweep` narrowed it down, `null` means "no bound".
   *
   * Bounds by creation and not by update deliberately: the tracker's own
   * `since` filter bounds by `updated_at`, which creeps forward the moment this
   * duty starts labelling or translating a thread, so a filter built on it
   * would silently exclude what the previous sweep just touched. Creation date
   * does not move, and it is what "no archaeology on threads before Reeve
   * adoption" actually means.
   */
  readonly since: Date | null;
  /**
   * The most threads a sweep will actually process in one run. A skip costs
   * nothing and does not count against it.
   */
  readonly limit: number;
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

  const sweep = core.getBooleanInput("sweep");
  const configuredNumber = core.getInput("number");
  if (sweep && configuredNumber.length > 0) {
    throw new Error(
      "sweep: cannot be combined with `number` — a sweep works the whole backlog and " +
        "`number` names one thread. Set one or the other.",
    );
  }

  return {
    token: core.getInput("github-token", { required: true }),
    number: sweep ? null : threadNumber(),
    models: roster.models,
    modelNames: roster.names,
    baseUrl: core.getInput("base-url", { required: true }),
    apiKey,
    dryRun: core.getBooleanInput("dry-run"),
    sweep,
    since: parseSince(core.getInput("since")),
    limit: whole("limit", core.getInput("limit")),
  };
}

/**
 * `since`, as a sweep's `action.yml` documents it: empty, a calendar date, or a
 * duration.
 *
 * A calendar date is the unambiguous choice for a maintainer who knows exactly
 * when this project started using Reeve. A duration (`90d`) is the one for
 * everybody else, who would otherwise have to compute a date and keep updating
 * it every week this workflow runs. Both mean the same thing to `listOpenThreads`
 * — a lower bound on `created_at` — so both collapse to one `Date` here.
 */
export function parseSince(raw: string): Date | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const dateMatch = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed);
  if (dateMatch) {
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`since: \`${raw}\` is not a real date.`);
    }
    return parsed;
  }

  const durationMatch = /^(\d+)d$/.exec(trimmed);
  if (durationMatch) {
    const days = Number(durationMatch[1]);
    if (days <= 0) throw new Error(`since: \`${raw}\` names no days at all.`);
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  throw new Error(
    `since: expected empty, \`YYYY-MM-DD\`, or a duration like \`90d\`, got \`${raw}\`.`,
  );
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

/**
 * The same, where zero is a setting rather than a mistake.
 *
 * Separate from `whole` rather than a flag on it, because the two are different
 * contracts and one of them has a trap in it: for a limit like `drafts`, zero
 * means "do nothing" and is always a typo; for a threshold like a minimum
 * length, zero means "do not apply this rule" and is a documented way to turn a
 * screen off. A shared function taking a floor would let a call site pass the
 * wrong one silently.
 */
export function counted(name: string, raw: string): number {
  const value = Number(raw);
  // The empty check has to be explicit here in a way it does not in `whole`:
  // `Number("")` is 0, and 0 is a value this function accepts — so an input
  // nobody filled in would otherwise arrive as a deliberate setting.
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name}: expected a whole number of 0 or more, got \`${raw}\`.`);
  }
  return value;
}

/**
 * A threshold between 0 and 1, refused rather than clamped.
 *
 * Clamping would make `75` mean `1` — every verdict below certainty rejected,
 * on a workflow whose author plainly meant 0.75 and would see a duty that
 * silently stopped labelling anything. Both ends are inclusive: `0` is "apply
 * whatever the model said", which is a legitimate thing to measure with, and
 * `1` is "apply nothing short of certainty".
 */
export function fraction(name: string, raw: string): number {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name}: expected a number between 0 and 1, got \`${raw}\`.`);
  }
  return value;
}
