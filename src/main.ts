/**
 * The root action's entry point.
 *
 * Its ordinary job is a refusal: `uses: ecoma-io/reeve@v0.1` is not how Reeve
 * is used, and a run that cannot do a job must say so rather than exit green
 * having done nothing. The message it fails with is built in `refusal.ts`,
 * which is where the reasoning lives.
 *
 * `doctor: true` is the one exception, and a narrow one: it still runs no
 * duty, but it can read one's configuration and say whether it would work —
 * see `doctor/run.ts` for what that means. `doctor: false`, the default,
 * leaves this exactly the refusal it has always been.
 *
 * Every duty gets its own entry point beside this one as it lands —
 * `src/duties/<name>/main.ts`, bundled to `<name>/dist/index.js`. This file is
 * not their runner and never becomes one.
 */
import * as core from "@actions/core";

import { runDoctor } from "./doctor/run.js";
import { refusal } from "./refusal.js";

export async function run(): Promise<void> {
  if (core.getBooleanInput("doctor")) {
    await runDoctor();
    return;
  }

  core.setFailed(refusal(core.getInput("duty")));
}

await run();
