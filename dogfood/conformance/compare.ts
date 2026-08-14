/**
 * Re-exports from the canonical comparison engine in src/.
 *
 * The dogfood CLI tools import from this module for convenience, but the
 * authoritative code lives in src/duties/dependa/conformance/compare.ts
 * so it is part of the project's build pipeline and covered by tests.
 */

export {
  compare,
  computeMetrics,
  generateReport,
  renderReportMarkdown,
  toJSONL,
  fromJSONL,
} from "../../src/duties/dependa/conformance/compare.js";
