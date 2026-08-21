/**
 * `doctor: true`'s own entry point, called from `src/main.ts` — separated
 * from it so this can be unit-tested directly.
 *
 * `src/main.ts` calls `run()` at import time (see `vitest.config.ts`'s
 * coverage exclusion), which is what makes every duty's own `main.ts`
 * untestable except by driving a spawned bundle. This module does not call
 * itself at import — `runDoctor` is only ever invoked, never self-invoking —
 * so it stays covered the ordinary way, and the root action's own
 * integration test is left to prove only the wiring: that `doctor: true`
 * reaches this at all, and that `doctor: false` still does not.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { writeSummary } from "../core/summary.js";
import { DEFAULT_WARRANT_PATH } from "../core/warrant.js";
import { normalise } from "../refusal.js";
import { parseModels } from "../core/provider.js";
import {
  checkApiKeysDeclared,
  parseApiKeys,
  parseEndpoints,
  parseTimeout,
} from "../core/inputs.js";

/** The one default `parseTimeout` must not assume but doctor can: nothing declared is 120s, the duty default. */
const DEFAULT_REQUEST_TIMEOUT = "120s";

import { diagnose, problems, type ProviderProbe } from "./diagnose.js";
import { summarize } from "./summary.js";

/**
 * The provider inputs this run actually received, or `undefined` when nobody
 * configured one.
 *
 * The root action's `action.yml` declares no provider inputs — its contract
 * is the refusal and the doctor report, and the probe is an addition, not a
 * promise. Anything a workflow does pass under the duty names comes through
 * the runner's `INPUT_*` mechanism whether or not the manifest declared it,
 * so a consumer who configures `base-url`/`api-key`/`models` alongside
 * `doctor: true` gets the probe for free, and one who does not still gets a
 * clean, provider-free report. A probe needs both an endpoint and at least
 * one model; either missing means there is nothing to probe, and this
 * returns `undefined` — the report then never touches a provider.
 */
export function providerConfig(): ProviderProbe | undefined {
  // Masked before anything else can run, the same standard every duty's own
  // inputs reader keeps: a provider's `reason` quotes the response body, and
  // a gateway that echoes a request it just refused would otherwise put the
  // key in a public workflow log. The `api-keys` lines' values are masked
  // inside `parseApiKeys`; this is the default endpoint's key, which nothing
  // else in this path would ever mask.
  const apiKey = core.getInput("api-key");
  if (apiKey.length > 0) core.setSecret(apiKey);

  const baseUrl = core.getInput("base-url");
  const roster = parseModels(core.getInput("models"));

  if (baseUrl.length === 0 || roster.models.length === 0) {
    return undefined;
  }

  const timeoutRaw = core.getInput("request-timeout");
  const endpoints = parseEndpoints(core.getInput("endpoints"));
  const apiKeys = parseApiKeys(core.getInput("api-keys"));
  // The same check every duty's `readCore` runs. Without it doctor would call a
  // roster clean that every duty refuses on its first request — which is the
  // one class of thing doctor exists to catch.
  checkApiKeysDeclared(endpoints, apiKeys);

  return {
    baseUrl,
    apiKey,
    requestTimeoutMs: parseTimeout(
      "request-timeout",
      timeoutRaw.length > 0 ? timeoutRaw : DEFAULT_REQUEST_TIMEOUT,
    ),
    models: roster.models,
    modelNames: roster.names,
    endpoints,
    apiKeys,
  };
}

export async function runDoctor(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const warrantPath = core.getInput("warrant", { required: true });
    const duty = normalise(core.getInput("duty"));

    const api = getOctokit(token);
    const provider = providerConfig();
    const report = await diagnose({
      api,
      at: context.repo,
      warrantPath,
      defaultWarrantPath: DEFAULT_WARRANT_PATH,
      duty: duty.length === 0 ? null : duty,
      ...(provider === undefined ? {} : { provider }),
    });

    const count = problems(report);
    core.setOutput("problems", String(count));
    await writeSummary(summarize(report));

    if (count > 0) {
      core.setFailed(
        `doctor: ${String(count)} finding${count === 1 ? "" : "s"} would refuse a duty at runtime — see the job summary.`,
      );
    }
  } catch (error) {
    // A safety net, not the ordinary path — `diagnose` itself is built to
    // turn every failure it can name into a finding rather than throw. What
    // reaches here is the input reading above it, or something this build
    // did not anticipate, and D5 says the same thing about both: loud, not
    // plausible.
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
