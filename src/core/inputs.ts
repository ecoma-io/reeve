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

import { parseList } from "./list.js";
import { parseModels, type Names } from "./provider.js";

/**
 * The provider-and-repository half of the shared inputs: everything a duty
 * needs whether or not it has an opinion about sweeping.
 *
 * Split out from {@link Shared} because `respond` answers one thread, the one
 * that triggered it — `sweep`, `since` and `limit` are inputs it does not
 * declare at all — and building the rest of this by hand is how a duty drifts
 * from every other duty's spelling of `api-key` or `endpoints`.
 */
export interface Core {
  readonly token: string;
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
  /**
   * Extra endpoints beyond the default `base-url`/`api-key` pair, named so a
   * model id can route to one with `model@alias`. Empty for every duty that
   * has not configured one, which is the common case and behaves exactly as
   * it always has: one endpoint, no alias grammar in play.
   */
  readonly endpoints: readonly EndpointSpec[];
  /**
   * The key for each endpoint named in `endpoints`. A separate input, not a
   * `key=` suffix on `endpoints`, because `endpoints` is loggable end to end
   * — alias, url, timeout — and a roster's authentication never should be.
   */
  readonly apiKeys: readonly ApiKeySpec[];
  /**
   * How long this run waits for one completion before giving up on it, as
   * weather rather than as a hang. Every endpoint uses this unless its own
   * `endpoints` line names a shorter or longer one with `timeout=`.
   */
  readonly requestTimeoutMs: number;
  /**
   * Passed to every completion request when set, omitted from the request
   * body entirely otherwise — some providers reject the field outright, so
   * "not configured" and "configured as the provider's own default" are not
   * the same thing and cannot share a spelling.
   */
  readonly temperature: number | undefined;
}

/** Options for {@link readShared}. */
export interface ReadSharedOptions {
  /**
   * Whether the duty works threads (the default) or document groups.
   *
   * A group duty — `harmonise` — has no event thread to work: it scans the
   * file tree, so a `push` run needs no issue or pull request. Its `number`
   * input is an optional group base path, not a thread, and is read as given
   * rather than resolved from the event.
   */
  readonly needsThread?: boolean;
}

/** What every sweeping duty gets, whatever else its own `action.yml` declares. */
export interface Shared extends Core {
  /**
   * The thread to work on, or null in `sweep` — a sweep does not name one
   * thread, it works the backlog. A group duty's own `number` semantics are
   * its business; the shared read only ever produces a thread number.
   */
  readonly number: number | null;
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
   * nothing and does not count against it. Null is no ceiling at all.
   */
  readonly limit: number | null;
}

/** One line of `endpoints`: `alias = url`, optionally followed by `timeout=`. */
export interface EndpointSpec {
  readonly alias: string;
  readonly baseUrl: string;
  /** This endpoint's own override, or null to fall back to `request-timeout`. */
  readonly timeoutMs: number | null;
}

/** One line of `api-keys`: `alias = key`. */
export interface ApiKeySpec {
  readonly alias: string;
  readonly key: string;
}

/**
 * The inputs every duty declares, sweeping or not.
 *
 * `respond` reads exactly this and adds its own on top; every other duty gets
 * it through {@link readShared}, which adds the three sweep inputs. Neither
 * one assembles a provider by hand.
 */
export function readCore(options?: { modelsOptional?: boolean }): Core {
  const apiKey = core.getInput("api-key");
  // Registered before anything can log it. A `reason` from a provider quotes
  // the response body, and a gateway that echoes the request would otherwise
  // put the key in a public workflow log.
  if (apiKey.length > 0) core.setSecret(apiKey);

  const modelsRequired = options?.modelsOptional !== true;
  const roster = parseModels(core.getInput("models", { required: modelsRequired }));
  if (modelsRequired && roster.models.length === 0) {
    throw new Error("models: no entries. Expected at least one model id.");
  }

  const endpoints = parseEndpoints(core.getInput("endpoints"));
  const apiKeys = parseApiKeys(core.getInput("api-keys"));
  checkApiKeysDeclared(endpoints, apiKeys);

  return {
    token: core.getInput("github-token", { required: true }),
    models: roster.models,
    modelNames: roster.names,
    baseUrl: core.getInput("base-url", { required: true }),
    apiKey,
    dryRun: core.getBooleanInput("dry-run"),
    endpoints,
    apiKeys,
    requestTimeoutMs: parseTimeout("request-timeout", core.getInput("request-timeout")),
    temperature: parseTemperature(core.getInput("temperature")),
  };
}

/**
 * {@link readCore}, plus the three inputs only a sweeping duty declares.
 *
 * The `sweep`/`number` conflict is checked first, ahead of any parsing: it is
 * a workflow that asked for two different runs at once, and no amount of
 * reading the rest tells anyone which one was meant.
 */
/**
 * Reads `sweep` and `number` together, refusing their combination up front.
 *
 * The `sweep`/`number` conflict is checked before any other parsing: it is a
 * workflow that asked for two different runs at once, and no amount of reading
 * the rest tells anyone which one was meant. Extracted from {@link readShared}
 * so a duty that reads these two without the model/provider inputs — lifecycle
 * — answers the conflict with the same message and the same thread-number
 * semantics.
 */
export function readSweepNumber(options: { needsThread?: boolean } = {}): {
  sweep: boolean;
  number: number | null;
} {
  const sweep = core.getBooleanInput("sweep");
  const configuredNumber = core.getInput("number");
  if (sweep && configuredNumber.length > 0) {
    throw new Error(
      "sweep: cannot be combined with `number` — a sweep works the whole backlog and " +
        "`number` names one thread. Set one or the other.",
    );
  }

  return {
    sweep,
    number: options.needsThread === false ? null : sweep ? null : threadNumber(),
  };
}

/**
 * {@link readCore}, plus the three inputs only a sweeping duty declares.
 *
 * The `sweep`/`number` conflict is {@link readSweepNumber}'s checking; this
 * reads the rest and spreads the pair in.
 */
export function readShared(options: ReadSharedOptions = {}): Shared {
  const { sweep, number } = readSweepNumber(options);

  return {
    ...readCore(),
    number,
    sweep,
    since: parseSince(core.getInput("since")),
    limit: bounded("limit", core.getInput("limit")),
  };
}

/**
 * The `show-attribution` axis, parsed in one place.
 *
 * Once duplicated verbatim in `translate/main.ts` and `duplicate/main.ts`;
 * the parsing is pure and the two duties were identical, so it lives here as
 * a shared pure parser. Each duty passes its own `core.getInput(...)` result
 * into it — the getInput call stays in the duty's `main.ts` so the
 * action-contract audit still sees it where it expects every input read to
 * happen. A misspelling is a workflow that would otherwise publish a hundred
 * bodies with the wrong amount of detail and say nothing, so the raw value is
 * refused rather than guessed at.
 */
export type Attribution = "none" | "model" | "detail";

/**
 * Validates a raw `show-attribution` value against the three spellings.
 *
 * @throws Error naming the offending spelling, so a workflow typo fails on the
 * first thread instead of publishing a hundred bodies with the wrong amount of
 * detail.
 */
export function parseAttribution(raw: string): Attribution {
  const value = raw.trim().toLowerCase();
  if (value === "none" || value === "model" || value === "detail") return value;
  throw new Error(
    `show-attribution: expected \`none\`, \`model\` or \`detail\`, got \`${value}\`.`,
  );
}

/**
 * `endpoints`: one `alias = url` per line, with an optional `timeout=` after
 * the url. Both halves are safe to quote back in an error — a maintainer
 * reads endpoint aliases and urls in this run's log the same way they read
 * `base-url` today.
 *
 * Written the same list grammar as `models` and `languages` for the same
 * reason those three share it: one convention, not a fourth one to learn.
 */
export function parseEndpoints(raw: string): readonly EndpointSpec[] {
  const seen = new Set<string>();
  return parseList(raw).map((entry) => {
    const at = entry.indexOf("=");
    if (at === -1) {
      throw new Error(`endpoints: expected \`alias = url\`, got \`${entry}\`.`);
    }
    const alias = entry.slice(0, at).trim();
    const rest = entry.slice(at + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(alias)) {
      throw new Error(
        `endpoints: \`${alias || entry}\` is not a valid alias — letters, digits, \`-\` and \`_\` only.`,
      );
    }
    // Reserved: it is the name every log line and summary already uses for
    // the built-in `base-url` endpoint, and an alias spelled the same way
    // would make two different endpoints unreadable as one.
    if (alias === "default") {
      throw new Error(
        "endpoints: `default` is reserved — it names the built-in `base-url` endpoint. Pick another alias.",
      );
    }
    if (seen.has(alias)) throw new Error(`endpoints: \`${alias}\` is declared more than once.`);
    seen.add(alias);

    const [url, ...rest2] = rest.split(/\s+/).filter((part) => part.length > 0);
    if (url === undefined) throw new Error(`endpoints: \`${alias}\` names no url.`);

    let timeoutMs: number | null = null;
    for (const token of rest2) {
      const match = /^timeout=(.+)$/.exec(token);
      if (!match) {
        throw new Error(
          `endpoints: \`${alias}\`: unrecognised \`${token}\` — expected \`timeout=<duration>\`.`,
        );
      }
      const [, duration = ""] = match;
      // Refused rather than last-wins: two timeouts on one line is a typo,
      // and silently honouring the second would change how long requests
      // wait without a single input error saying so.
      if (timeoutMs !== null) {
        throw new Error(`endpoints: \`${alias}\` names \`timeout=\` more than once.`);
      }
      timeoutMs = parseTimeout(`endpoints: ${alias}: timeout`, duration);
    }

    return { alias, baseUrl: url, timeoutMs };
  });
}

/**
 * `api-keys`: one `alias = key` per line. Every value is registered with
 * `core.setSecret` before any of them are parsed, so a malformed line further
 * down the input cannot land a key that has not been masked yet into a
 * thrown error and from there into this run's log.
 */
export function parseApiKeys(raw: string): readonly ApiKeySpec[] {
  const entries = parseList(raw);
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const value = (at === -1 ? entry : entry.slice(at + 1)).trim();
    if (value.length > 0) core.setSecret(value);
  }

  const seen = new Set<string>();
  return entries.map((entry) => {
    const at = entry.indexOf("=");
    if (at === -1) throw new Error("api-keys: expected `alias = key`, got an entry with no `=`.");
    const alias = entry.slice(0, at).trim();
    const key = entry.slice(at + 1).trim();
    if (alias.length === 0) throw new Error("api-keys: an entry named no alias.");
    if (seen.has(alias)) throw new Error(`api-keys: \`${alias}\` is declared more than once.`);
    seen.add(alias);
    return { alias, key };
  });
}

/**
 * Every `api-keys` alias has to name an endpoint `endpoints` actually
 * declared — a key with nowhere to route is a typo, and the honest place to
 * catch it is before either list reaches `resolveEndpoints`.
 */
function checkApiKeysDeclared(
  endpoints: readonly EndpointSpec[],
  apiKeys: readonly ApiKeySpec[],
): void {
  for (const { alias } of apiKeys) {
    if (!endpoints.some((endpoint) => endpoint.alias === alias)) {
      throw new Error(`api-keys: \`${alias}\` is not declared in \`endpoints\`.`);
    }
  }
}

/**
 * `request-timeout`, and an `endpoints` line's own `timeout=`: a whole number
 * of seconds or minutes, refused otherwise. A bare number is refused rather
 * than assumed to be seconds, because a silent unit is exactly the kind of
 * thing that is only ever noticed once a request has already hung for the
 * wrong amount of time.
 */
export function parseTimeout(name: string, raw: string): number {
  const trimmed = raw.trim();
  const match = /^(\d+)(s|m)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `${name}: expected a whole number of seconds or minutes, like \`120s\` or \`2m\` — a bare ` +
        `number names no unit, got \`${raw}\`.`,
    );
  }
  const [, digits, unit] = match;
  const value = Number(digits);
  if (value < 1) throw new Error(`${name}: expected a positive duration, got \`${raw}\`.`);
  const ms = unit === "m" ? value * 60_000 : value * 1000;
  // Node's timers, `AbortSignal.timeout` among them, overflow past 2^31-1 ms
  // and fire almost immediately instead — which would quietly turn every
  // request on the endpoint into instant weather. An input error is the
  // honest version of that.
  if (ms > 2_147_483_647) {
    throw new Error(
      `${name}: \`${raw}\` is longer than any run could ever wait — use a shorter duration.`,
    );
  }
  return ms;
}

/**
 * `temperature`: empty omits the field from every request body outright,
 * because some providers reject a field they were never asked to accept.
 * Configured, it is refused outside the range every OpenAI-compatible
 * provider documents for it.
 */
export function parseTemperature(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error(`temperature: expected a number between 0 and 2, got \`${raw}\`.`);
  }
  return value;
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

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateMatch) {
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    // Two ways a date-shaped string is not a date, and `Date` only reports one
    // of them. Month 13 and day 0 come back `Invalid Date`; 30 February comes
    // back as 2 March, because the constructor rolls an overflowing field into
    // the next unit rather than refusing it. Rolling is the worse failure of
    // the two — the run gets a bound nobody wrote and no error to read — so the
    // parsed date is compared back against the fields it was written with, and
    // a date that moved is refused exactly as one that never parsed.
    const [, year = "", month = "", day = ""] = dateMatch;
    const rolled =
      parsed.getUTCFullYear() !== Number(year) ||
      parsed.getUTCMonth() + 1 !== Number(month) ||
      parsed.getUTCDate() !== Number(day);
    if (Number.isNaN(parsed.getTime()) || rolled) {
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
 * A ceiling that may also be no ceiling at all: a whole number of 1 or more,
 * or the literal `none`, returned as `null`.
 *
 * Not `counted` with an extra case bolted on, because `0` means something
 * different on a ceiling than it does on a floor. `min-body-chars: 0` turns a
 * rule off at the scale's own vanishing point — there is nothing smaller than
 * no minimum, so `0` is an honest spelling of it. A ceiling has no such point:
 * `corpus-limit: 0` cannot mean "unbounded" without also being reachable by a
 * typo for `10`, and it cannot mean "process nothing" without duplicating what
 * leaving the duty unnamed in the warrant already means. So `0` is refused
 * here, on either input, and `none` is the only spelling of "no bound" — a
 * word a stray keystroke does not produce.
 *
 * Not `whole` with a sentinel bolted on either: `whole` has no way to say
 * "there is no ceiling" — every number it accepts is one, and the sentinel
 * has to come from outside the range it measures. `none`, refused nowhere
 * near the numbers, is that sentinel: a `max-body-chars: 0` is a maintainer
 * who meant `none` and typed the wrong kind of zero.
 */
export function bounded(name: string, raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "none") return null;

  const value = Number(trimmed);
  if (trimmed.length === 0 || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name}: expected a whole number of 1 or more, or \`none\` for no bound, got \`${raw}\`.`,
    );
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
