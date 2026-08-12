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
import { normalise } from "../refusal.js";

import { diagnose, problems } from "./diagnose.js";
import { summarize } from "./summary.js";

/** Mirrors every duty's own copy of this constant — see `readWarrant`'s doc comment for why it is not shared. */
const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

export async function runDoctor(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const warrantPath = core.getInput("warrant", { required: true });
    const duty = normalise(core.getInput("duty"));

    const api = getOctokit(token);
    const report = await diagnose({
      api,
      at: context.repo,
      warrantPath,
      defaultWarrantPath: DEFAULT_WARRANT_PATH,
      duty: duty.length === 0 ? null : duty,
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
