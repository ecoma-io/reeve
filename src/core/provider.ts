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
 *
 * **A third rule governs the rotation itself, not one request:** [D12](../../docs/doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)
 * splits every failure into `kind`, and the two kinds do not fail the same way.
 * A `capacity` failure — 429, 5xx, a timeout, a socket that never connected —
 * is weather: `rotateModels` returns it like any other, the caller carries on,
 * and `Weather` remembers it for the rest of the run so the next thread does
 * not pay for a request the first thread already learned would not answer. An
 * `auth` failure — 401, 403 — is not weather, and the rule above bends for it
 * on purpose: no amount of rotation repairs a key that was never going to
 * work, so `rotateModels` throws an `AuthenticationFailure` the moment it sees
 * one, past every remaining model on the list. This is the one place that
 * doctrine has to be enforced, because it is the one function every duty's
 * every stage calls to ask a provider anything — enforcing it here means no
 * stage has to remember to.
 */
import type { Core } from "./inputs.js";
import { parseList } from "./list.js";
import { metered, type Meter, type Purpose } from "./meter.js";

/** A chat message, in the only two roles Reeve sends. */
export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /**
   * Set on an assistant message that carried tool calls, replayed verbatim on
   * the next request so the conversation the provider sees stays valid. Absent
   * everywhere else — a plain message wires exactly as it always has.
   */
  readonly toolCalls?: readonly ToolCall[];
  /** Set on a `tool` message: which of the assistant's calls this result answers. */
  readonly toolCallId?: string;
}

/**
 * One tool a caller offers the model — the chat-completions function shape
 * minus its `{type: "function"}` wrapper, which `complete` adds at the wire.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object, sent verbatim. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * One call the model asked for. `arguments` stays the raw string the model
 * wrote: parsing it is the caller's job, done strictly, so a malformed
 * argument fails one tool result rather than the whole completion.
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
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
   * Which endpoint answered: the alias an `endpoints` line declared, or null
   * for the default `base-url`/`api-key` pair. Set only by
   * `createRoutedProvider` — a plain `createProvider` never populates it,
   * because a single-endpoint run has nothing to distinguish.
   */
  readonly endpoint?: string | null;
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
   * The calls the model asked for, present only when the request offered
   * tools and the answer carried a readable `tool_calls` array. `content` is
   * then whatever string came alongside, or "" when the provider sent none —
   * a tool-calling answer with no prose is the ordinary case, not a protocol
   * failure.
   */
  readonly toolCalls?: readonly ToolCall[];
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
  /** Same as `Success.endpoint` — which endpoint this attempt was routed to. */
  readonly endpoint?: string | null;
  /**
   * True for a `"capacity"` failure where the connection itself failed — a
   * DNS failure, a connection refused. Never for an HTTP-level 429 or 5xx,
   * and deliberately never for a timeout or a body that broke mid-read
   * either: a transport failure says something about the endpoint itself, so
   * `reckon` grounds every model routed to it rather than just the one that
   * happened to be asked first — while a timeout may simply be one slow
   * model, and a broken body arrived with a status line that proves the
   * endpoint reachable, so both demote only the pair that hit them.
   */
  readonly transport?: boolean;
  /**
   * What it cost anyway. A request that answered `HTTP 200` with nothing usable
   * in it is a failure to Reeve and a billable completion to the provider, and
   * a ledger that only counted the answers it liked would understate the run.
   */
  readonly usage?: Usage | null;
  /**
   * [D12](../../docs/doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)'s
   * distinction, decided once, here, so every caller reads the same answer
   * instead of re-deriving it from a reason string:
   *
   * - `"auth"` — 401 or 403. Configuration, not conditions. `rotateModels`
   *   never returns one of these; it throws instead, which is what makes this
   *   case narrower to handle everywhere else than the other two.
   * - `"capacity"` — 429, any 5xx, a timeout, or a network failure that never
   *   reached a status at all. Weather: this run's `Weather` remembers it, and
   *   nothing about it is this model's fault.
   * - `"protocol"` — everything else. A body that was not JSON, a 4xx that was
   *   not auth or the rate limit, an answer with no usable content. A model or
   *   a gateway behaving outside the contract, on a request that could
   *   otherwise have been served.
   */
  readonly kind: "auth" | "capacity" | "protocol";
}

export type Completion = Success | Failure;

export interface CompletionOptions {
  /**
   * Sent only when set. Omitted by default because some models reject the
   * field outright, and a default that breaks a provider is worse than no
   * default at all.
   */
  readonly temperature?: number;
  /**
   * Tools offered to the model, sent only when non-empty — a request without
   * them is byte-identical to what this provider has always sent, so a model
   * that rejects the `tools` field is only ever asked for it by a caller that
   * chose to. A model that ignores the field and answers with content anyway
   * is a valid answer, not a failure — the caller reads `toolCalls` absence
   * as "the model answered directly".
   */
  readonly tools?: readonly ToolDefinition[];
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
 * `|` is refused rather than tolerated. It is `judge-models`' seat separator —
 * another voter, another request — and a `models` written with it is somebody
 * expecting a panel here, which is a misunderstanding worth stopping on the
 * first run rather than one whose only symptom is that the ids all ran
 * together into one that no provider has.
 */
export function parseModels(raw: string): Roster {
  const models: string[] = [];
  const names = new Map<string, string>();

  for (const entry of parseList(raw)) {
    const { ids, name } = split(entry);
    if (ids.includes("|")) {
      throw new Error(
        "models: `|` separates judge seats — one more voter, one more request — and " +
          "means nothing here. `models` is a single fallback chain, so separate its " +
          `ids with \`,\`. Got \`${ids.trim()}\`.`,
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
 * `|` separates seats; `,` and a newline separate the models inside one. So
 * `a, b | c` is two votes, and the second model of the first seat is only ever
 * asked because the first one could not deliver a vote.
 *
 * The separators carry the same meaning they carry everywhere else, which is
 * the point of the assignment: a `,` in `models` is a fallback, so a `,` here
 * is a fallback too, and a list copied from one input into the other keeps the
 * spend it had. The failure mode of getting this wrong is asymmetric — a
 * `models` list pasted here reads as one seat and casts one vote, quieter and
 * cheaper than the three votes the old reading would have silently paid for.
 *
 * The two levels exist because a panel and a rotation want opposite things from
 * a list, and both are legitimate. A seat is a voter, so more seats mean more
 * votes; a chain is availability, so more links mean the same one vote survives
 * a model being out of quota. Writing them on one axis makes you choose, and a
 * maintainer configuring free models needs both.
 *
 * **A name belongs to the seat, not to the model that happens to fill it.**
 * `a, b = Careful | c` is one voter called `Careful` whichever of the two
 * answers, which is the honest reading: a reader of the thread is being told
 * which opinion this was, and "the seat's fallback was in today" is not a
 * distinction they can do anything with. A name written against any model in
 * the chain names the whole seat, the seat's first name wins, and the first
 * seat to claim a model is the one that names it.
 */
export function parseSeats(raw: string): Panel {
  const seats: string[][] = [];
  const names = new Map<string, string>();

  for (const seatRaw of raw.split("|")) {
    const chain: string[] = [];
    let seatName: string | null = null;

    for (const entry of parseList(seatRaw)) {
      const { ids, name } = split(entry);
      const id = ids.trim();
      if (id.length === 0) continue;
      if (!chain.includes(id)) chain.push(id);
      if (seatName === null && name !== null) seatName = name;
    }
    if (chain.length === 0) continue;

    seats.push(chain);
    if (seatName === null) continue;
    for (const id of chain) if (!names.has(id)) names.set(id, seatName);
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
      const tools = options?.tools ?? [];
      const body = JSON.stringify({
        model,
        messages: messages.map(wireMessage),
        stream: false,
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(tools.length === 0
          ? {}
          : {
              tools: tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }),
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
        // Never a status at all — a timeout, a DNS failure, a connection
        // refused. There is no 401 hiding in a request that never reached the
        // provider, so this is weather by construction, not a guess.
        //
        // `transport` — the flag that grounds the whole endpoint rather than
        // the one pair — is set only when the connection itself failed. A
        // timeout is deliberately not that: a large model can run past a
        // deadline a small one never touches on the same healthy endpoint,
        // so a timeout demotes the pair that hit it and nothing else.
        return {
          ok: false,
          model,
          usage: null,
          kind: "capacity",
          ...(isTimeout(error) ? {} : { transport: true }),
          reason: describeRequestError(error, timeoutMs),
        };
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        // Not `transport`: the endpoint answered — status line and headers
        // arrived — and a body that broke mid-read condemns this one response,
        // not every model the endpoint serves.
        return {
          ok: false,
          model,
          usage: null,
          kind: "capacity",
          reason: `HTTP ${String(response.status)}: response body could not be read (${describeRequestError(error, timeoutMs)})`,
        };
      }

      return readCompletion(model, response.status, text, tools.length > 0);
    },
  };
}

/**
 * Splits a model id at its **last** `@`, and only when what follows names a
 * declared endpoint.
 *
 * Last rather than first, because a model id is a provider's identifier and
 * routinely contains its own `@` — `user@org/model`, a revision tag, whatever
 * a provider's own catalogue uses — while an endpoint alias is one the
 * `endpoints` input just declared and is never the id's business to contain.
 * The alias grammar has to be the one that never collides with a real id, not
 * the other way around.
 *
 * Only when declared, so a bare id that happens to contain `@something` nobody
 * configured routes to the default endpoint exactly as it always did, rather
 * than failing to find an endpoint that was never meant to be one.
 */
export function splitEndpointAlias(
  model: string,
  aliases: ReadonlySet<string>,
): { readonly id: string; readonly alias: string | null } {
  const at = model.lastIndexOf("@");
  if (at === -1) return { id: model, alias: null };

  const alias = model.slice(at + 1);
  if (!aliases.has(alias)) return { id: model, alias: null };

  return { id: model.slice(0, at), alias };
}

/** One endpoint fully resolved: enough for `createRoutedProvider` to reach it. */
export interface RoutedEndpoint {
  /** null names the default `base-url`/`api-key` endpoint every duty has. */
  readonly alias: string | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

/**
 * The single-endpoint `Provider` every duty used to build directly, made to
 * route across a roster instead.
 *
 * A model id of `id@alias` is dispatched to the endpoint `alias` named — with
 * `@alias` stripped before the request is made, since no endpoint's catalogue
 * has ever heard of Reeve's own routing suffix — and everything else goes to
 * the default endpoint unchanged, which is exactly what happens when
 * `endpoints` was never configured at all: `aliases` is empty, every id is a
 * plain id, and this behaves like `createProvider` with one endpoint in it.
 *
 * The completion that comes back is stamped with `model` as the caller wrote
 * it — the composite id, not the one actually sent — because `Weather`, the
 * meter and every duty's own name lookup all key on the id `models` was
 * configured with, and only this function knows the two ever differed.
 */
export function createRoutedProvider(endpoints: readonly RoutedEndpoint[]): Provider {
  const aliases = new Set(
    endpoints.flatMap((endpoint) => (endpoint.alias === null ? [] : [endpoint.alias])),
  );
  const byAlias = new Map<string | null, Provider>(
    endpoints.map((endpoint) => [
      endpoint.alias,
      createProvider({
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        timeoutMs: endpoint.timeoutMs,
      }),
    ]),
  );

  return {
    async complete(model, messages, options) {
      const { id, alias } = splitEndpointAlias(model, aliases);
      const provider = byAlias.get(alias);
      if (provider === undefined) {
        return {
          ok: false,
          model,
          usage: null,
          kind: "protocol",
          endpoint: alias,
          // The failure's own `model` field carries the id, and the caller
          // decides how that is shown — a reason that repeated it verbatim
          // would put the raw id in a log the display name was masking.
          reason: `endpoints: no endpoint named \`${alias ?? ""}\` is configured for this model.`,
        };
      }

      const completion = await provider.complete(id, messages, options);
      return { ...completion, model, endpoint: alias };
    },
  };
}

/**
 * Every endpoint a run can route to, resolved from the shared inputs into what
 * `createRoutedProvider` actually needs: the default `base-url`/`api-key`
 * pair first, then every `endpoints` line with its key looked up out of
 * `api-keys` and its timeout defaulted to `request-timeout` when its own
 * line named none.
 *
 * Takes the five fields it needs rather than the whole of `Core`, so a test
 * can name a routing table without assembling a run's worth of inputs around
 * it.
 */
export function resolveEndpoints(
  shared: Pick<Core, "baseUrl" | "apiKey" | "requestTimeoutMs" | "endpoints" | "apiKeys">,
): readonly RoutedEndpoint[] {
  const keyed = new Map(shared.apiKeys.map((entry) => [entry.alias, entry.key]));

  return [
    {
      alias: null,
      baseUrl: shared.baseUrl,
      apiKey: shared.apiKey,
      timeoutMs: shared.requestTimeoutMs,
    },
    ...shared.endpoints.map((endpoint) => ({
      alias: endpoint.alias,
      baseUrl: endpoint.baseUrl,
      apiKey: keyed.get(endpoint.alias) ?? "",
      timeoutMs: endpoint.timeoutMs ?? shared.requestTimeoutMs,
    })),
  ];
}

/** Everything a duty needs to ask a model anything, assembled in one call. */
export interface Client<P extends Purpose> {
  /** This run's capacity memory, seeded with every alias and model configured. */
  readonly weather: Weather;
  /** The routed provider underneath every stage, unmetered and unattributed. */
  readonly provider: Provider;
  /** One metered provider per purpose asked for, each counting under its own name. */
  readonly stages: Readonly<Record<P, Provider>>;
}

/**
 * The four lines every duty's `run` opened with: seed the weather, route the
 * provider, and wrap one metered copy of it per stage.
 *
 * Five duties spelling this out five times is five chances for a roster to be
 * left out of the weather — which is the one of these that fails silently. A
 * model missing from `createWeather` is not refused, it simply never gets
 * counted as starved, and the run keeps asking an endpoint that has already
 * said no. So the rosters are a parameter: `models` is always in, and a duty
 * with a second or third one names it rather than remembering to.
 *
 * `temperature` is applied here, once, rather than threaded through every
 * stage helper down to the request: it is a property of the run, not of the
 * call, and the version where each helper carried it was seventeen chances to
 * drop it silently.
 */
export function assembleClient<P extends Purpose>(
  shared: Core,
  meter: Meter,
  purposes: readonly P[],
  extraRosters: readonly (readonly string[])[] = [],
): Client<P> {
  const weather = createWeather(new Set(shared.endpoints.map((endpoint) => endpoint.alias)), [
    ...shared.models,
    ...extraRosters.flat(),
  ]);
  const provider = createRoutedProvider(resolveEndpoints(shared));

  return {
    weather,
    provider,
    stages: Object.fromEntries(
      purposes.map((purpose) => [purpose, metered(provider, meter, purpose, shared.temperature)]),
    ) as Record<P, Provider>,
  };
}

/**
 * Turns a response body into a verdict. Separate from the request so the order
 * of the checks — body before status — is testable on its own.
 */
/**
 * One message as the wire wants it. A plain system/user message maps to the
 * exact `{role, content}` shape this provider has always sent; the assistant
 * and tool roles carry their chat-completions extras under the wire's own
 * snake_case names, which is why the mapping exists at all — serialising a
 * `Message` directly would leak this codebase's camelCase into the protocol.
 */
function wireMessage(message: Message): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    base.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.toolCallId !== undefined) base.tool_call_id = message.toolCallId;
  return base;
}

/**
 * The `tool_calls` array of a message, strictly read: every entry has to
 * carry a string id, a string function name and string arguments, or the
 * whole array is refused as unreadable — a half-parsed call list would have
 * the caller answering calls the model never made.
 */
function readToolCalls(raw: unknown): readonly ToolCall[] | null {
  const list = asArray(raw);
  if (list === null) return null;
  const out: ToolCall[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const fn = asRecord(record?.function);
    const id = record?.id;
    const name = fn?.name;
    const args = fn?.arguments;
    if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") {
      return null;
    }
    out.push({ id, name, arguments: args });
  }
  return out;
}

function readCompletion(
  model: string,
  status: number,
  text: string,
  toolsRequested = false,
): Completion {
  const at = `HTTP ${String(status)}`;
  const kind = classifyStatus(status);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return {
      ok: false,
      model,
      usage: null,
      kind,
      reason: `${at}: body was not JSON — ${excerpt(text)}`,
    };
  }

  // Read before any verdict, because a response Reeve refuses was still paid
  // for. The one exception is a body that would not parse, which carries no
  // number anybody could read.
  const usage = readUsage(payload);

  const reported = readErrorMessage(payload);
  if (reported !== null) return { ok: false, model, usage, kind, reason: `${at}: ${reported}` };

  if (status < 200 || status >= 300) {
    return { ok: false, model, usage, kind, reason: `${at}: ${excerpt(text)}` };
  }

  const choice = asRecord(asArray(asRecord(payload)?.choices)?.[0]);
  if (choice === null) {
    return {
      ok: false,
      model,
      usage,
      kind,
      reason: `${at}: no choices in the response — ${excerpt(text)}`,
    };
  }

  const content = asRecord(choice.message)?.content;

  // The tool-calling answer, admitted only on a request that offered tools:
  // `content` is routinely null then, and refusing it as "not a string" would
  // make every tool call a protocol failure. On a request that offered no
  // tools this branch never runs, so every existing path reads byte-identical.
  if (toolsRequested) {
    const rawCalls = asRecord(choice.message)?.tool_calls;
    if (rawCalls !== undefined && rawCalls !== null) {
      const calls = readToolCalls(rawCalls);
      if (calls === null) {
        return {
          ok: false,
          model,
          usage,
          kind,
          reason: `${at}: the tool_calls array was not readable`,
        };
      }
      if (calls.length > 0) {
        const finishReason = choice.finish_reason;
        return {
          ok: true,
          model,
          usage,
          content: typeof content === "string" ? content : "",
          toolCalls: calls,
          finishReason: typeof finishReason === "string" ? finishReason : null,
        };
      }
    }
  }

  if (typeof content !== "string") {
    // A provider whose `content` is an array of parts, or a reasoning model
    // that put everything in `reasoning_content` and left this empty. Both are
    // outside the protocol Reeve speaks; rotation is the answer.
    return { ok: false, model, usage, kind, reason: `${at}: message content was not a string` };
  }
  if (content.trim().length === 0) {
    return { ok: false, model, usage, kind, reason: `${at}: answered with empty content` };
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
 * D12's classification, read off the one signal it is defined in terms of.
 *
 * A 2xx never lands on `"auth"` or `"capacity"` — both are ranges below 200 or
 * at or above 400 — so a 2xx whose body turns out to carry a real error stays
 * `"protocol"` without this needing a special case for it: body before status
 * only ever *adds* a failure a 2xx status would otherwise have hidden, and
 * this function is asked only what the status means, never whether there was
 * a failure at all.
 */
function classifyStatus(status: number): Failure["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || (status >= 500 && status < 600)) return "capacity";
  return "protocol";
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
  /**
   * Each model that failed before it, in the order tried. Never carries an
   * `"auth"` failure — `rotateModels` throws one the moment it sees it, rather
   * than returning it for a caller to notice or not.
   */
  readonly failures: readonly Failure[];
}

/**
 * Thrown by `rotateModels` on the first `"auth"` failure, past every other
 * model still on the list.
 *
 * A thrown exception rather than a returned one, and deliberately the one
 * exception to "no request failure throws" at the top of this file: that rule
 * is about a single request, where the caller's next move is always the same
 * — try the next model — and returning keeps that decision the caller's. An
 * `"auth"` failure has no next move; every duty's answer to it is identical
 * (stop, and say which key), so making it an exception here means every
 * caller gets that answer for free, by doing nothing, rather than by
 * remembering to check for it at every one of the five places a duty asks a
 * provider something.
 */
export class AuthenticationFailure extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(`${failure.model}: ${failure.reason}`);
    this.name = "AuthenticationFailure";
    this.failure = failure;
  }
}

/**
 * What this run has already learned about capacity, one model id at a time.
 *
 * [D12](../../docs/doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)
 * says a model's capacity does not clear inside a run — not inside one call to
 * `rotateModels`, which was already true before this existed, but across every
 * call the run makes, including the ones a sweep makes for threads two, three
 * and forty. One `Weather` is created once, at the top of `run()`, and threaded
 * through every stage that can reach a provider, so a model that ran out of
 * room triaging the first thread is never asked to draft the second.
 *
 * Deliberately blind to `"protocol"` failures: a bad answer from one thread's
 * prompt says nothing about whether the same model would answer a different
 * prompt well, so only `"capacity"` — a fact about the model's account, not
 * about what was asked — earns a model a place here.
 */
export interface Weather {
  /**
   * True once `model` is no longer worth asking: either this exact
   * `model@alias` pair was grounded, or a transport failure grounded the
   * whole endpoint it routes to.
   */
  grounded(model: string): boolean;
  /** Records a capacity failure against one `model@alias` pair. */
  ground(model: string): void;
  /**
   * Records a transport failure against a whole endpoint — every model
   * routed to it is grounded from here on, not just the one that was asked.
   */
  groundEndpoint(alias: string | null): void;
  /** Every `model@alias` pair grounded so far, in the order it happened. */
  readonly starved: readonly string[];
  /**
   * True once more than one endpoint is in play. D12's ordinary rule — an
   * auth failure fails the run red the moment it happens — assumes the one
   * endpoint that just refused a key is the only endpoint there was to try.
   * That assumption is what a second endpoint removes.
   */
  readonly multiEndpoint: boolean;
  /**
   * Records an auth failure against one endpoint, deferred rather than
   * thrown — and grounds that endpoint at the same time: a key refused once
   * is refused for every model routed there, so asking again would spend a
   * sweep's whole thread count confirming the same misconfiguration against
   * a provider's rate limit. The one recorded failure is what `settleAuth`
   * and the summary judge from.
   */
  failAuth(alias: string | null, failure: Failure): void;
  /** True once every endpoint this run knows about has an auth failure recorded. */
  readonly authExhausted: boolean;
  /** Every deferred auth failure recorded, one per endpoint, in the order seen. */
  readonly authFailures: readonly Failure[];
}

/**
 * `aliases` is every endpoint `endpoints` declared — empty for the common
 * case, which is what makes `multiEndpoint` false and every method below
 * behave exactly as it always did for a run with one endpoint.
 *
 * `models` is every model id this run's rosters can ask, across every list
 * the duty takes — drafting, screening, judging. It exists to scope
 * `authExhausted` to the endpoints those ids actually route to: a run whose
 * every model says `@fast` never asks the default endpoint anything, and a
 * run like that must not stay green on the grounds that an endpoint nobody
 * could reach never got the chance to refuse a key. Left unset, the universe
 * falls back to every declared endpoint plus the default.
 */
export function createWeather(
  aliases: ReadonlySet<string> = new Set(),
  models?: readonly string[],
): Weather {
  const order: string[] = [];
  const dead = new Set<string>();
  const deadEndpoints = new Set<string | null>();
  // Every endpoint this run can actually route a request to — the universe
  // `authExhausted` checks for completeness against.
  const universe =
    models === undefined || models.length === 0
      ? new Set<string | null>([null, ...aliases])
      : new Set<string | null>(models.map((model) => splitEndpointAlias(model, aliases).alias));
  const authFailed = new Map<string | null, Failure>();

  return {
    grounded: (model) => {
      const { alias } = splitEndpointAlias(model, aliases);
      return dead.has(model) || deadEndpoints.has(alias);
    },
    ground: (model) => {
      if (dead.has(model)) return;
      dead.add(model);
      order.push(model);
    },
    groundEndpoint: (alias) => deadEndpoints.add(alias),
    get starved() {
      return order;
    },
    multiEndpoint: aliases.size > 0,
    failAuth: (alias, failure) => {
      deadEndpoints.add(alias);
      if (!authFailed.has(alias)) authFailed.set(alias, failure);
    },
    get authExhausted() {
      return [...universe].every((alias) => authFailed.has(alias));
    },
    get authFailures() {
      return [...authFailed.values()];
    },
  };
}

/**
 * True once every model on `models` has been grounded — the roster this list
 * names has nothing left to try for the rest of the run, and asking again
 * would not spend a request so much as narrate one that was already spent.
 *
 * Empty lists are not starved: `screen-models` left unset is turned off, not
 * exhausted, and reporting the two the same way would make "nobody configured
 * a cheap roster" and "the cheap roster ran dry" the same sentence when a
 * maintainer needs to tell them apart.
 */
export function starved(models: readonly string[], weather: Weather): boolean {
  return models.length > 0 && models.every((model) => weather.grounded(model));
}

/**
 * True when the roster came back with nothing usable and at least one model
 * failed for a reason that is not capacity — a model id that does not exist, a
 * body that would not parse, a field the provider rejected, a key the endpoint
 * refused. Those are configuration errors, not weather, and
 * [D5](../../docs/doctrine/north-star.md#d5-failure-is-loud-it-is-never-plausible)
 * says a run that cannot do its job fails red rather than completing green
 * with nothing in it.
 *
 * Called alongside `starved` at the point a duty knows its roster came back
 * empty. This reads `every(not capacity)` rather than the `every(protocol)` it
 * used to, which widens it by exactly one kind: an endpoint that refused the
 * key. `auth` and `protocol` are both configuration, and a roster where every
 * model failed on one or the other is a roster nobody has configured
 * correctly.
 *
 * That closes the multi-endpoint hole. With `endpoints` configured, `reckon`
 * defers an auth failure to `weather.failAuth`, and `authExhausted` stays
 * false while any other endpoint still authenticates — so `settleAuth` never
 * throws. A run that saw an HTTP 401 on one endpoint and a malformed body on
 * another delivered nothing and exited 0, because `every(protocol)` was false
 * for the `auth` failure. Now it is red.
 *
 * **What this deliberately does NOT cover, and why.** A roster where one model
 * was rate-limited and another returned HTML satisfies neither this predicate
 * nor `starved`, so a run that reached no usable answer at all still reports
 * neither. That hole is real and is written up as a finding — but the fix is
 * not to widen this to `some(not capacity)`. Every call site of
 * {@link failIfRosterExhausted} sits inside a per-item loop — per candidate in
 * `dependa`, per locale in `harmonise`, per chunk in `translate`, per thread in
 * `respond` — so `some` turns one degraded item into a red run for work that
 * otherwise fully succeeded. `dependa`'s call guards an opt-in narrative
 * flourish whose absence the surrounding code explicitly handles; reddening the
 * whole run over it is worse than the hole. Closing the mixture case honestly
 * means deciding it once at run level, against what the run actually
 * delivered, which is a change to five duties' failure accounting rather than
 * to this predicate.
 *
 * The `failures.length >= models.length` guard is what keeps this about an
 * exhausted roster rather than a rotation that failed once and then succeeded.
 * Every caller also reaches it only on the branch where nothing usable came
 * back, so the two agree.
 */
export function rosterExhausted(models: readonly string[], failures: readonly Failure[]): boolean {
  return (
    models.length > 0 &&
    failures.length >= models.length &&
    failures.every((f) => f.kind !== "capacity")
  );
}

/**
 * A grounded model, reported as the failure asking it again would produce.
 *
 * Exported for the one caller that keeps its own loop instead of going
 * through `rotateModels` — a judge's panel stops on a usable *vote*, not a
 * usable *completion*, which is a stricter stop `rotateModels` cannot express
 * — and needs the same sentence for the same reason.
 */
export function weatherFailure(model: string): Failure {
  return {
    ok: false,
    model,
    kind: "capacity",
    usage: null,
    reason:
      "already rotated past for capacity earlier in this run — a provider's limit does not " +
      "clear inside one job, so it was not asked again",
  };
}

/**
 * What every failure means for the rest of the run, applied once wherever a
 * provider is asked something: an `"auth"` failure is not this run's to carry
 * on past, so it throws — unless a second endpoint means it might still have
 * one left to try, in which case the failure is recorded and judgement waits
 * for `settleAuth`. A `"capacity"` failure is remembered in `weather`, against
 * the one `model@alias` pair for an HTTP-level failure or the whole endpoint
 * for a transport one, so the next model asked, on the next thread, does not
 * repeat it.
 *
 * The one piece of D12 every call site shares, factored out so `rotateModels`
 * and a panel's own loop enforce it identically rather than by two readings of
 * the same rule.
 */
export function reckon(failure: Failure, weather?: Weather): void {
  if (failure.kind === "auth") {
    if (weather?.multiEndpoint === true) {
      weather.failAuth(failure.endpoint ?? null, failure);
      return;
    }
    throw new AuthenticationFailure(failure);
  }
  if (failure.kind === "capacity") {
    if (failure.transport === true) weather?.groundEndpoint(failure.endpoint ?? null);
    else weather?.ground(failure.model);
  }
}

/**
 * The deferred half of the multi-endpoint amendment to
 * [D12](../../docs/doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration):
 * call once, after a run has tried everything it is going to try. A
 * single-endpoint run never needs this — `reckon` already threw the moment
 * its one endpoint answered unauthenticated. A multi-endpoint run defers
 * exactly that judgement until every endpoint has had its turn; this is
 * where the judgement lands, and only when every one of them turned out to
 * be misconfigured the same way.
 */
export function settleAuth(weather: Weather): void {
  if (!weather.multiEndpoint || !weather.authExhausted) return;
  const [first] = weather.authFailures;
  if (first !== undefined) throw new AuthenticationFailure(first);
}

/**
 * One completion, with a truncated answer read as the protocol failure it is.
 *
 * `finish_reason: "length"` means the provider stopped emitting before the
 * model was done. The body that arrives is well-formed and short, which is the
 * dangerous combination: it parses, and what it parses to is half of what was
 * asked for. So it is turned into a `protocol` failure here, and the caller
 * rotates to the next model exactly as it would for a body that never parsed.
 *
 * ── Why this is in the core ────────────────────────────────────────────────
 *
 * It was written out six times: `translate/draft.ts`, `duplicate/verdict.ts`,
 * `respond/draft.ts`, `harmonise/draft.ts`, `review/passes.ts` and
 * `core/pivot.ts`, five of them byte-identical. That is the provider
 * protocol's own semantics, not any duty's policy about its own work, and
 * `architecture.md` puts model rotation on the core's side of the boundary
 * precisely so a duty never has to remember a rule like this.
 *
 * Six copies is also how two call sites ended up without it. `triage/verdict.ts`
 * and `dependa/main.ts` call `provider.complete` directly, so a truncated
 * answer there is accepted as a rotation *success*, fails its parser, and
 * becomes a no-verdict — where every other duty would have rotated to the next
 * model. Those two are deliberately NOT changed here: giving them the guard
 * changes what a run does, which is a decision of its own and not a
 * deduplication. They are the argument for this function existing.
 *
 * `noun` names the thing that was cut off, for the reason string a maintainer
 * reads in a log. It is the only thing the six copies disagreed about.
 */
export async function askWhole(
  provider: Provider,
  model: string,
  messages: readonly Message[],
  noun = "answer",
): Promise<Completion> {
  const completion = await provider.complete(model, messages);
  if (completion.ok && completion.finishReason === "length") {
    return {
      ok: false,
      model,
      kind: "protocol",
      reason: `the ${noun} was cut off before it finished`,
    };
  }
  return completion;
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
 *
 * `weather`, when given, is consulted before every attempt and updated after
 * every `"capacity"` failure — this is what makes a model's exhaustion outlive
 * the single call that discovered it. Left unset, rotation still behaves
 * exactly as it always has: this parameter is additive, not a second mode.
 */
export async function rotateModels(
  models: readonly string[],
  attempt: (model: string) => Promise<Completion>,
  weather?: Weather,
): Promise<Rotation> {
  const failures: Failure[] = [];
  for (const model of models) {
    if (weather?.grounded(model) === true) {
      failures.push(weatherFailure(model));
      continue;
    }

    const completion = await attempt(model);
    if (completion.ok) return { success: completion, failures };
    reckon(completion, weather);
    failures.push(completion);
  }
  return { success: null, failures };
}

/** Whether a fetch rejection is `AbortSignal.timeout` firing, by its one name. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function describeRequestError(error: unknown, timeoutMs: number): string {
  if (isTimeout(error)) {
    return `request timed out after ${String(timeoutMs)}ms`;
  }
  return `request failed — ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Reads the protocol's `error`, in both the shapes providers send it.
 *
 * An `error` that is present but carries nothing — `null`, `""`, `{}`,
 * `{"message": ""}`, `{"code": null}` — is not a report of anything, and
 * several gateways send one alongside a perfectly good answer. Only a field
 * with something in it condemns the response; otherwise a model that worked
 * would be rotated past for punctuation.
 */
function readErrorMessage(payload: unknown): string | null {
  const error = asRecord(payload)?.error;

  if (typeof error === "string") return error.trim().length > 0 ? error : null;

  const reported = asRecord(error);
  if (reported === null) return null;

  const message = reported.message;
  if (typeof message === "string" && message.trim().length > 0) return message;

  // "Carries nothing" is about the contents, not about the key count. `{}` was
  // already tolerated here; `{"message": ""}`, `{"message": "   "}` and
  // `{"code": null}` were not, and each of them is the same absence wearing a
  // field name. A gateway that stamps one of those on every response — several
  // do — exhausted the whole roster and ended a run red on a
  // provider that was answering perfectly well, which is the failure this
  // paragraph of the doc comment above exists to prevent.
  const carries = Object.values(reported).some(
    (value) =>
      value !== null &&
      value !== undefined &&
      !(typeof value === "string" && value.trim().length === 0),
  );
  if (!carries) return null;

  return `provider reported an error — ${excerpt(JSON.stringify(reported))}`;
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
