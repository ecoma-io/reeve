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
import { parseApiKeys, parseEndpoints, parseTimeout } from "../core/inputs.js";

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
 * clean, provider-free report. `base-url` unset with `models` unset means no
 * provider exists to probe; `models` unset with a `base-url` set is a
 * half-configured provider and is reported by `providerProbe` as "no model
 * was configured to probe".
 */
function providerConfig(): ProviderProbe | undefined {
  const baseUrl = core.getInput("base-url");
  const apiKey = core.getInput("api-key");
  const roster = parseModels(core.getInput("models"));

  if (baseUrl.length === 0 || roster.models.length === 0) {
    return undefined;
  }

  const timeoutRaw = core.getInput("request-timeout");
  return {
    baseUrl,
    apiKey,
    requestTimeoutMs: parseTimeout(
      "request-timeout",
      timeoutRaw.length > 0 ? timeoutRaw : DEFAULT_REQUEST_TIMEOUT,
    ),
    models: roster.models,
    modelNames: roster.names,
    endpoints: parseEndpoints(core.getInput("endpoints")),
    apiKeys: parseApiKeys(core.getInput("api-keys")),
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
