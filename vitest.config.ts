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
      exclude: ["src/main.ts", "src/duties/*/main.ts"],
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
