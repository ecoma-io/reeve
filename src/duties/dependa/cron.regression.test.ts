/**
 * Regression: importing a dependa helper must not run the dependa duty.
 *
 * Every duty entry point calls `run()` at import — that is the pattern, and it
 * is why `vitest.config.ts` excludes every duty entry point from coverage. What
 * that pattern makes dangerous is a test that value-imports a helper OUT of an
 * entry point: loading the module to reach the helper starts a real run inside
 * the test worker.
 *
 * That is what happened here. `cron.test.ts` imported `cronFieldMatches` and
 * `cronMatches` from `./main.js`, so every `pnpm test` ran the dependa duty:
 * it built a GitHub client, read settings, and called `core.setFailed`, which
 * writes `::error::Input required and not supplied: github-token` to stdout
 * and sets `process.exitCode` on the worker. The suite reported green
 * throughout, which is the whole problem — an action executing inside the test
 * run is invisible if nothing looks for it.
 *
 * The fix was to move the helpers into `cron.ts`. This test is what stops them
 * moving back: it imports the module in a child process and asserts the
 * process stayed silent and exited clean. A `run()` reached on import cannot
 * do either.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Imports one module in a clean child process and reports what it emitted. */
async function importInChildProcess(
  specifier: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(specifier)});`,
      ],
      {
        cwd: ROOT,
        // Deliberately empty of the `INPUT_*` an action reads: a module that
        // does not run a duty does not care, and one that does will say so.
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("importing the cron module", () => {
  it("does_not_execute_the_dependa_duty", async () => {
    const run = await importInChildProcess("./src/duties/dependa/cron.ts");

    // `core.setFailed` and `core.error` both write a `::error::` workflow
    // command to stdout. A silent import is the evidence that no run started.
    expect(run.stdout).not.toContain("::error::");
    expect(run.stdout).not.toContain("::warning::");
    expect(run.code).toBe(0);
  }, 30_000);

  it("does_not_import_the_duty_entry_point_at_any_depth", async () => {
    // The behavioural check above catches a run that emits something. This
    // catches the module edge itself, which is what would let one back in.
    const run = await importInChildProcess("./src/duties/dependa/cron.ts");

    expect(run.stderr).not.toContain("main.ts");
    expect(run.code).toBe(0);
  }, 30_000);
});
