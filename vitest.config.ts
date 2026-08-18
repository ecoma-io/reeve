import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: nothing here ever touches a DOM.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Every entry point calls `run()` at import time, so importing one to
      // measure it would execute the action. They are covered by driving the
      // built bundles instead, which is what a runner does.
      //
      // `src/doctor/run.ts` does not call itself at import — see its own doc
      // comment — but it belongs on this list for the same underlying reason:
      // it calls `core.setOutput`/`core.setFailed` for real, which mutates
      // this worker's own `process.exitCode` and writes workflow commands to
      // stdout rather than returning a value a unit test can assert on. Every
      // duty's own settings-reading code has the identical shape and is left
      // to its bundle's integration test for the same reason — see
      // `core/inputs.test.ts`'s doc comment for the one exception this
      // repository makes (`readShared`, driven through real environment
      // variables) and why `setFailed`/`setOutput` are not it.
      exclude: ["src/main.ts", "src/duties/*/main.ts", "src/doctor/run.ts"],
      reporter: ["text", "lcov"],
      // A floor, not a target. It exists so a pull request that adds a module
      // and no tests for it goes red rather than diluting the number quietly.
      //
      // 90 across all four is a mandated floor, not a number that drifted up
      // behind the suite. It was raised from 80/80/80/80 in the Round 1
      // hardening pass, against a measured baseline at `0fa21e6` of
      // statements 88.73 / branches 81.42 / functions 94.05 / lines 89.84 —
      // so at the moment it was written, three of the four were *below* it and
      // branches was 596 branches short. That is the point: the number names
      // where this repository has decided to be, and the tests were written to
      // meet it rather than the number lowered to meet the tests.
      //
      // Two rules travel with it, and both matter more than the digits.
      // First, it never goes down: a red threshold is a missing test, and the
      // fix is the test. Second, `exclude` below never grows to hide uncovered
      // code — an exclusion removes a file from the denominator, which raises
      // the percentage while covering nothing, and is the one edit that can
      // make this gate lie.
      //
      // Line coverage is also not the whole claim. A line can be executed by a
      // test that asserts nothing, so this floor is paired with the mutation
      // table in `tools/mutation.mjs`, which asks the stricter question: does
      // the suite *fail* when the behaviour changes. See
      // `docs/internal/ci-gates.md` for which of the two is the release gate
      // and which is the advisory metric.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
