/**
 * The root action's entry point.
 *
 * It has one job and it is a refusal: `uses: ecoma-io/reeve@v0.1` is not how
 * Reeve is used, and a run that cannot do a job must say so rather than exit
 * green having done nothing. The message it fails with is built in
 * `refusal.ts`, which is where the reasoning lives.
 *
 * Every duty gets its own entry point beside this one as it lands —
 * `src/duties/<name>/main.ts`, bundled to `<name>/dist/index.js`. This file is
 * not their runner and never becomes one.
 */
import * as core from "@actions/core";

import { refusal } from "./refusal.js";

export function run(): void {
  core.setFailed(refusal(core.getInput("duty")));
}

run();
