/**
 * One chat completion against an OpenAI-compatible endpoint, and the rotation
 * over a list of models.
 *
 * Two rules shape everything here.
 *
 * **No request failure throws.** Every way a request can go wrong comes back as
 * `{ ok: false, reason }`, because the caller's response to a failure is always
 * the same — try the next model — and an exception would make that the caller's
 * control flow instead of its decision. A `reason` is written to be read in a
 * workflow log by someone who cannot reproduce the run.
 *
 * **The status code is never the verdict.** Gateways and free tiers routinely
 * answer `200` with `{"error": {...}}` in the body, and just as routinely answer
 * a non-2xx with an HTML page. So the body is parsed first and the status is
 * only ever context inside the reason. A run that treated `200` as success
 * would post the string `{"error":"rate limited"}` as somebody's translation.
 *
 * Nothing in this module logs. The api key is masked by the entry point, but a
 * module that returns its failures lets the caller decide what is worth a
 * warning and what is ordinary rotation.
 */
import { parseList } from "./list.js";

/** A chat message, in the only two roles Reeve sends. */
export interface Message {
  readonly role: "system" | "user";
  readonly content: string;
}

/**
 * What one request cost, as the provider reported it.
 *
 * Reported and never inferred. A token count Reeve computed itself would be an
 * estimate wearing a number's clothes, and the one thing a bill has to be is
 * checkable against the provider's own.
 */
export interface Usage {
  readonly prompt: number;
  readonly completion: number;
}

export interface Success {
  readonly ok: true;
  readonly model: string;
  /**
   * What it cost, when a provider said. Absent or null is the ordinary case —
   * gateways drop the field, and a null rendered as zero would put a free line
   * in a bill that was not free. Only the provider fills this in; a failure a
   * caller derives from an answer it did not like leaves it alone, because the
   * request underneath was already counted where it was made.
   */
  readonly usage?: Usage | null;
  readonly content: string;
  /**
   * The provider's `finish_reason`, verbatim, or null when it sent none.
   *
   * Reported rather than acted on: `length` means the answer was cut off, which
   * ruins a translation and is harmless for a one-token choice. The caller
   * knows which it asked for.
   */
  readonly finishReason: string | null;
}

export interface Failure {
  readonly ok: false;
  readonly model: string;
  readonly reason: string;
  /**
   * What it cost anyway. A request that answered `HTTP 200` with nothing usable
   * in it is a failure to Reeve and a billable completion to the provider, and
   * a ledger that only counted the answers it liked would understate the run.
   */
  readonly usage?: Usage | null;
}

export type Completion = Success | Failure;

export interface CompletionOptions {
  /**
   * Sent only when set. Omitted by default because some models reject the
   * field outright, and a default that breaks a provider is worse than no
   * default at all.
   */
  readonly temperature?: number;
}

export interface Provider {
  complete(
    model: string,
    messages: readonly Message[],
    options?: CompletionOptions,
  ): Promise<Completion>;
}

export interface ProviderConfig {
  /** Chat-completions endpoint without the trailing `/chat/completions`. */
  readonly baseUrl: string;
  /** Empty for a keyless provider, which is a supported configuration. */
  readonly apiKey: string;
  /** Per-request ceiling. */
  readonly timeoutMs?: number;
}

/**
 * Long enough that a slow model on a busy free tier finishes, short enough that
 * a hung connection cannot hold a job open until the runner's own limit. A
 * request that has not answered by now is not about to.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** How much of an unparseable body reaches the log. Enough to recognise, not enough to bury. */
const EXCERPT_CHARS = 200;

/**
 * The name to show for a model id, for every id anybody named.
 *
 * A model id is a provider's identifier and routinely a maintainer's secret —
 * which provider an organisation happens to have access to is nobody else's
 * business, and a workflow that masks its ids in the log has already decided
 * that. Attribution then has to choose between naming the id in a public thread
 * and saying nothing at all, and both are bad answers. A name is the third one:
 * `Careful` is what a reader needs and `qwen/qwen3-32b-preview` is not.
 *
 * Absent means nobody named it, and the id is what gets shown. That is the
 * default and stays a perfectly good setting.
 */
export type Names = ReadonlyMap<string, string>;

/** What to show for a model: the name it was given, or the id nobody named. */
export function shown(names: Names, id: string): string {
  return names.get(id) ?? id;
}

/** A `models` input read: the ids to try in order, and what to call them. */
export interface Roster {
  /** Model ids in preference order. */
  readonly models: readonly string[];
  readonly names: Names;
}

/** A `judge-models` input read: the seats to fill, and what to call them. */
export interface Panel {
  /** One entry per seat, each the chain that seat may be filled from. */
  readonly seats: readonly (readonly string[])[];
  readonly names: Names;
}

/**
 * Splits a `models` input into ids to try in order — one chain, not a set of
 * groups — and the names it gave them.
 *
 * Exact repeats are dropped. Rotation only ever reaches a model because the one
 * before it failed, so trying the same id twice cannot succeed where it just
 * did not — it spends a request on a foregone conclusion, which on the free
 * tier Reeve is built for is the request that mattered.
 *
 * An empty result is returned rather than refused, because only the caller
 * knows whether an empty list is a problem: `readShared` refuses one for
 * `models`, and `parseSeats` returns one for a `judge-models` nobody set.
 *
 * `|` is refused rather than tolerated. It is the seat separator, and a
 * `models` written with it is somebody expecting groups here — which is a
 * misunderstanding worth stopping on the first run rather than one whose only
 * symptom is that the ids all ran together into one that no provider has.
 */
export function parseModels(raw: string): Roster {
  const models: string[] = [];
  const names = new Map<string, string>();

  for (const entry of parseList(raw)) {
    const { ids, name } = split(entry);
    if (ids.includes("|")) {
      throw new Error(
        "models: `|` groups fallbacks into one judge seat and means nothing here — " +
          "`models` is already a single rotation chain, so separate its ids with `,`. " +
          `Got \`${ids.trim()}\`.`,
      );
    }

    const id = ids.trim();
    // The repeat keeps its first position and its first name. A later entry
    // renaming it would be two answers to "what is this model called", and the
    // rotation it is trying to change is already fixed by then.
    if (id.length === 0 || models.includes(id)) continue;

    models.push(id);
    if (name !== null) names.set(id, name);
  }

  return { models, names };
}

/**
 * Splits a `judge-models` input into seats, each its own chain to rotate
 * through.
 *
 * `,` and a newline separate seats; `|` separates the models inside one. So
 * `a | b, c` is two votes, and the second model of the first seat is only ever
 * asked because the first one could not deliver a vote.
 *
 * The two levels exist because a panel and a rotation want opposite things from
 * a list, and both are legitimate. A seat is a voter, so more seats mean more
 * votes; a chain is availability, so more links mean the same one vote survives
 * a model being out of quota. Writing them on one axis makes you choose, and a
 * maintainer configuring free models needs both.
 *
 * An input with no `|` in it parses to one seat per id, which is what it always
 * meant — this widens the syntax rather than changing it.
 *
 * **A name belongs to the seat, not to the model that happens to fill it.**
 * `a | b = Careful` is one voter called `Careful` whichever of the two answers,
 * which is the honest reading: a reader of the thread is being told which
 * opinion this was, and "the seat's fallback was in today" is not a distinction
 * they can do anything with. So the name is recorded against every model in the
 * seat, and the first seat to claim a model is the one that names it.
 */
export function parseSeats(raw: string): Panel {
  const seats: string[][] = [];
  const names = new Map<string, string>();

  for (const entry of parseList(raw)) {
    const { ids, name } = split(entry);
    const chain = [
      ...new Set(
        ids
          .split("|")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    ];
    if (chain.length === 0) continue;

    seats.push(chain);
    if (name === null) continue;
    for (const id of chain) if (!names.has(id)) names.set(id, name);
  }

  return { seats, names };
}

/**
 * One configured entry cut at its name.
 *
 * The **first** `=`, because a model id is a path and a version and never an
 * assignment, while a name is prose somebody wrote and may well contain one.
 * `a = up to 8k = fine` is the model `a` called `up to 8k = fine`, which is the
 * only reading that does not make the punctuation in a display name a parse
 * error.
 *
 * A name that is empty is no name rather than a blank one. `models: a =` is a
 * line somebody stopped writing, and showing an empty `<code></code>` in a
 * hundred threads is a worse answer than showing the id.
 */
function split(entry: string): { ids: string; name: string | null } {
  const at = entry.indexOf("=");
  if (at === -1) return { ids: entry, name: null };

  const name = entry.slice(at + 1).trim();
  return { ids: entry.slice(0, at), name: name.length > 0 ? name : null };
}

export function createProvider(config: ProviderConfig): Provider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey.length > 0) headers.authorization = `Bearer ${config.apiKey}`;

  return {
    async complete(model, messages, options) {
      const body = JSON.stringify({
        model,
        messages,
        stream: false,
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
      });

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { ok: false, model, usage: null, reason: describeRequestError(error, timeoutMs) };
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return {
          ok: false,
          model,
          usage: null,
          reason: `HTTP ${String(response.status)}: response body could not be read (${describeRequestError(error, timeoutMs)})`,
        };
      }

      return readCompletion(model, response.status, text);
    },
  };
}

/**
 * Turns a response body into a verdict. Separate from the request so the order
 * of the checks — body before status — is testable on its own.
 */
function readCompletion(model: string, status: number, text: string): Completion {
  const at = `HTTP ${String(status)}`;

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, model, usage: null, reason: `${at}: body was not JSON — ${excerpt(text)}` };
  }

  // Read before any verdict, because a response Reeve refuses was still paid
  // for. The one exception is a body that would not parse, which carries no
  // number anybody could read.
  const usage = readUsage(payload);

  const reported = readErrorMessage(payload);
  if (reported !== null) return { ok: false, model, usage, reason: `${at}: ${reported}` };

  if (status < 200 || status >= 300) {
    return { ok: false, model, usage, reason: `${at}: ${excerpt(text)}` };
  }

  const choice = asRecord(asArray(asRecord(payload)?.choices)?.[0]);
  if (choice === null) {
    return {
      ok: false,
      model,
      usage,
      reason: `${at}: no choices in the response — ${excerpt(text)}`,
    };
  }

  const content = asRecord(choice.message)?.content;
  if (typeof content !== "string") {
    // A provider whose `content` is an array of parts, or a reasoning model
    // that put everything in `reasoning_content` and left this empty. Both are
    // outside the protocol Reeve speaks; rotation is the answer.
    return { ok: false, model, usage, reason: `${at}: message content was not a string` };
  }
  if (content.trim().length === 0) {
    return { ok: false, model, usage, reason: `${at}: answered with empty content` };
  }

  const finishReason = choice.finish_reason;
  return {
    ok: true,
    model,
    usage,
    content,
    finishReason: typeof finishReason === "string" ? finishReason : null,
  };
}

/**
 * The `usage` object, or null for the many providers that send none.
 *
 * Either field being absent is not fatal to the other: a gateway that reports
 * `prompt_tokens` and nothing else has still told the run something true, and
 * the missing half counts as zero rather than discarding the half that arrived.
 * A `usage` with neither field is nothing at all, and null says so — the
 * summary can then report how many requests went uncounted instead of adding
 * zeroes to a total nobody could check.
 */
function readUsage(payload: unknown): Usage | null {
  const usage = asRecord(asRecord(payload)?.usage);
  if (usage === null) return null;

  const prompt = asCount(usage.prompt_tokens);
  const completion = asCount(usage.completion_tokens);
  if (prompt === null && completion === null) return null;

  return { prompt: prompt ?? 0, completion: completion ?? 0 };
}

/** A token count as a provider sends it, or null for anything that is not one. */
function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/** The outcome of trying a list of models in order. */
export interface Rotation {
  /** The first usable answer, or null when every model was rotated past. */
  readonly success: Success | null;
  /** Each model that failed before it, in the order tried. */
  readonly failures: readonly Failure[];
}

/**
 * Tries each model in order and stops at the first usable answer.
 *
 * A failed model is passed, never retried: the failures this hits are quota,
 * a decommissioned id, or a provider outage, and none of them clears inside one
 * run. Retrying would spend the budget of the model that would have worked.
 *
 * Failures are returned rather than logged so a caller that recovers can stay
 * quiet, and one that ends up with nothing can report every attempt at once.
 */
export async function rotateModels(
  models: readonly string[],
  attempt: (model: string) => Promise<Completion>,
): Promise<Rotation> {
  const failures: Failure[] = [];
  for (const model of models) {
    const completion = await attempt(model);
    if (completion.ok) return { success: completion, failures };
    failures.push(completion);
  }
  return { success: null, failures };
}

function describeRequestError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `request timed out after ${String(timeoutMs)}ms`;
  }
  return `request failed — ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Reads the protocol's `error`, in both the shapes providers send it.
 *
 * An `error` that is present but carries nothing — `null`, `""`, `{}` — is not
 * a report of anything, and several gateways send one alongside a perfectly
 * good answer. Only a field with something in it condemns the response;
 * otherwise a model that worked would be rotated past for punctuation.
 */
function readErrorMessage(payload: unknown): string | null {
  const error = asRecord(payload)?.error;

  if (typeof error === "string") return error.trim().length > 0 ? error : null;

  const reported = asRecord(error);
  if (reported === null || Object.keys(reported).length === 0) return null;

  const message = reported.message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : `provider reported an error — ${excerpt(JSON.stringify(reported))}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "the body was empty";
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
}
