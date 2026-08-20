# Providers and the runtime

_Configure the model endpoint a duty talks to, and the runtime inputs around it. Prerequisites: [Installation](../getting-started/installation.md)._

Reeve talks to one thing: an endpoint speaking the OpenAI chat-completions
protocol. That is the entire vendor contract. OpenAI, a gateway, a model host, a
`llama.cpp` on your own hardware, a keyless free tier — each is a different value
for `base-url`, and none of them is a migration.

The request Reeve sends is deliberately the smallest one that protocol defines:
`model`, `messages`, `stream: false`, and a `temperature` only where a step wants
one. No `max_tokens`, no `response_format` — every answer a duty asks for is
prose or one short token, so nothing is gained by a field the cheapest providers
are the likeliest to reject.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## A single provider

```yaml
with:
  base-url: https://api.openai.com/v1 # the default
  api-key: ${{ secrets.OPENAI_API_KEY }}
  models: gpt-5-mini
```

**Leave `api-key` empty for a keyless provider.** That is a supported
configuration, not a degraded one — [Cost](cost.md) covers how to make it work
well.

**`models` takes a list, in order of preference.** One per line or comma
separated. A model that fails or answers unusably is rotated past, never retried:
a provider limit does not clear inside one run, so the next attempt starts from a
shorter list rather than the same wall.

```yaml
models: |
  gpt-5-mini
  gpt-5
  some-fallback
```

Order is preference, not last-resort. Put the model you actually want first.

**`request-timeout` bounds how long one request may run** before it counts as
weather rather than a failure — `120s` by default, a whole number of seconds
or minutes (`30s`, `2m`). A bare number with no unit is refused rather than
guessed at: the runner's own job timeout and this provider's request timeout
are not the same number, and treating them as interchangeable hides which one
actually fired.

**`temperature` sets the sampling temperature Reeve asks for**, between `0`
and `2`. Left empty — the default — the field is left out of the request
entirely, because some providers reject it outright rather than fall back to
a default of their own when one is sent. A value outside `0`–`2` is refused
rather than clamped to the nearest end.

## More than one endpoint

A single `base-url`/`api-key` pair is the ordinary case, and everything above
still describes it unchanged. `endpoints` adds more without replacing it —
a free provider to rotate to when the paid one is out of quota, a second
gateway that carries models the first does not, a self-hosted `llama.cpp`
sitting beside a hosted one:

```yaml
with:
  base-url: https://api.openai.com/v1
  api-key: ${{ secrets.OPENAI_API_KEY }}
  endpoints: |
    free = https://api.example.com/v1 timeout=30s
  api-keys: |
    free = ${{ secrets.FREE_API_KEY }}
  models: |
    gpt-5-mini
    llama-3-70b@free
```

Each `endpoints` line is `alias = url`, with an optional trailing
`timeout=<duration>` overriding `request-timeout` for that one endpoint.
One alias is reserved: `default` names the built-in `base-url` endpoint in
every log line and summary, so it cannot be declared as an alias of its own.
`api-keys` is `alias = key`, one line per alias that needs one — every value
in it is registered as a secret before anything else is even parsed, so a
malformed later line's error message can never expose an earlier key. An
alias named in `api-keys` that `endpoints` never declared is refused; a key
is optional, and an alias with none simply sends no `Authorization` header,
the same as a keyless `base-url`.

**`model@alias` routes that one model to that one endpoint.** The alias is
split off the model id at its _last_ `@`, and only when that alias was
actually declared in `endpoints` — a model id that happens to contain its own
`@` and names no declared alias is left whole and sent to the default
`base-url`, exactly as it always was, so an id is never misread as a routing
suffix by accident. A model with no `@alias` always means the default
endpoint, whatever else is configured.

**Weather is tracked per model _and_ per endpoint.** A 429, a 5xx or a
timeout from `llama-3-70b@free` demotes that pair alone — the same model
reached through a different endpoint, or a different model reached through
`free`, is still tried. A transport-level failure — the connection itself,
never an answer from the provider — demotes the whole endpoint instead, on
the reasoning that a broken connection says nothing about the model that was
asked over it.

**An auth failure behaves differently once there is more than one endpoint.**
A single-endpoint run still fails red immediately on the first 401 or 403,
exactly as
[D12](../doctrine/north-star.md#d12--capacity-is-weather-authority-is-configuration)
has always described. Once `endpoints` names more than one, a 401 or 403 is
recorded instead of thrown, and the run keeps going — one endpoint's wrong
key says nothing about another endpoint's — failing red only at the end, and
only once **every** endpoint this run's model ids actually route to has
ended up auth-failed. An endpoint no model routes to does not keep a doomed
run green: the question is whether anything that could have been asked still
authenticated. See the doctrine's own amendment at that same link for the
full reasoning.

Once more than one endpoint has carried any spend, every duty's job summary
gains an Endpoint column, naming which one answered each row.

## Hiding model ids

A model id is a provider's identifier and routinely a maintainer's secret —
which provider an organisation happens to have access to is nobody else's
business, and a router's ids (`gh/deepseek-v4-flash-free`) say even more than
a vendor's. Two mechanisms, layered:

**`id = Name` controls what readers see.** Every `models`, `screen-models`
and `judge-models` input accepts it, and everything a person reads — the job
summary, every warning, every posted attribution — shows the name instead of
the id:

```yaml
models: gh/deepseek-v4-flash-free = deepseek-v4-flash
```

**An Actions variable controls what the repository shows.** In a public
repository the workflow file is public too, so an id written inline is
already published whatever the comments show. Keep the whole roster — ids
and names together — in a repository or organisation variable, and every
duty's workflow reads one source:

```yaml
models: ${{ vars.REEVE_MODELS }}
```

One variable also gives you the thing a shared default would: change the
roster once, and every duty in every workflow follows.

**The honest limits.** Naming is presentation, not a security boundary: the
id still travels to the endpoint you configured (which already knows it), and
nothing can stop a model's own prose from announcing what it is — a draft
that opens "As DeepSeek, ..." was written that way by the model, not leaked
by the runtime. Treat `id = Name` as hygiene for logs, summaries and posted
threads; treat the variable as the place ids live; and treat neither as
making a public endpoint private.

## Who the runtime belongs to

The provider inputs are runtime, not authority. They live on the duty's leaf
action — `base-url`, `api-key`, `models`, `request-timeout`, `endpoints`,
`api-keys`, `temperature`, and the same `github-token` every duty takes. Nothing
a workflow passes in can grant a capability; that is exactly what
[the warrant](warrant.md) is for. One `models` input can be required (the
duties that draft), optional (the duties that read or sweep), or unused
(`lifecycle` calls no model; `doctor`'s only call is a single weather probe,
never authority) — each duty's [reference page](../reference/duties/)
declares its own table, and that table is the contract.

---

**Related:** [Installation](../getting-started/installation.md) · [The warrant](warrant.md) · [Cost](cost.md) · [Dry run](dry-run.md)
**Next:** [The warrant](warrant.md) — write down what a duty may do, on top of how it runs
