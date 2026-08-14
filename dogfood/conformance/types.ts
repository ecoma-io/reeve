/**
 * Re-exports from the canonical conformance types in src/.
 *
 * The dogfood CLI tools import from this module for convenience, but the
 * authoritative definitions live in src/duties/dependa/conformance/types.ts
 * so they are part of the project's build pipeline and covered by tests.
 */

export type {
  DiscrepancyClassification,
  ComparisonLevel,
  DependencyComparison,
  ConformanceDataset,
  ConformanceMetrics,
  ConformanceReport,
  RenovateFinding,
  DependaFinding,
} from "../../src/duties/dependa/conformance/types.js";

export {
  DISCREPANCY_CLASSIFICATIONS,
  COMPARISON_LEVELS,
} from "../../src/duties/dependa/conformance/types.js";
