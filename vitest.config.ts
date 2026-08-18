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
      // comment — and it is no longer untestable either: `doctor/run.test.ts`
      // mocks `setOutput`/`setFailed` and drives `runDoctor`/`providerConfig`
      // directly. The exclusion is inherited from before that test existed,
      // and it stays only because taking it off is a measurement rather than a
      // tidy-up: an exclusion is a denominator, and moving one at the close of
      // a hardening round means re-verifying every figure that round reported.
      // The direction was measured rather than reasoned, because reasoning got
      // it wrong: the file's own row reads 83.33% branches (15 of 18), which
      // looks like it would drag the suite number down, and it does not —
      // folding it back in moves the suite to 96.54 / 91.07 / 98.48 / 97.60
      // from 96.50 / 91.05 / 98.48 / 97.60, so three numbers rise and the
      // fourth is unchanged to two places. The exclusion is currently costing
      // about 0.03 points of honest bookkeeping, not hiding anything. Removing
      // it is a change of its own, on its own evidence.
      //
      // Every duty's own settings reader — the `readSettings` that calls
      // `core.getInput` — lives in its `main.ts`, so it is already on this
      // list by the rule above and is left to its bundle's integration test —
      // see `core/inputs.test.ts`'s doc comment for the one exception this
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
      // the suite *fail* when the behaviour changes. Of the two, the mutation
      // table is the release gate — it is the only one here that measures
      // protection rather than execution. This floor is necessary and not
      // sufficient: it catches a module that arrives with no tests, and a
      // directory can go from 60% to 95% on tests that only call things.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
