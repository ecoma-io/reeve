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
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
