/**
 * CLI for the dependa vs Renovate conformance comparison.
 *
 * Usage:
 *   npx tsx dogfood/conformance/cli.ts --repo-root .
 *
 * This extracts the Renovate baseline from the repository's configuration,
 * extracts dependa's shadow findings using the actual managers, compares
 * them, and prints a conformance report.
 */

import * as path from "node:path";
import * as fs from "node:fs";

import { extractRenovateBaseline } from "./renovate-extract.js";
import { extractDependaShadow } from "./dependa-extract.js";
import {
  compare,
  computeMetrics,
  generateReport,
  renderReportMarkdown,
  toJSONL,
} from "./compare.js";

// ─── Argument parsing ──────────────────────────────────────────────────────

function parseArgs(args: string[]): { repoRoot: string; ecosystems: string[] } {
  let repoRoot = ".";
  const ecosystems: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-root" && args[i + 1]) {
      repoRoot = args[i + 1]!;
      i++;
    } else if (arg === "--ecosystems" && args[i + 1]) {
      const raw = args[i + 1]!;
      ecosystems.push(
        ...raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
      i++;
    }
  }

  return { repoRoot, ecosystems };
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  const { repoRoot, ecosystems } = parseArgs(process.argv.slice(2));
  const absoluteRoot = path.resolve(repoRoot);

  if (!fs.existsSync(absoluteRoot)) {
    console.error(`Repository root not found: ${absoluteRoot}`);
    process.exit(1);
  }

  console.log(`Dependa vs Renovate conformance comparison`);
  console.log(`Repository: ${absoluteRoot}`);
  console.log(`Ecosystems: ${ecosystems.length > 0 ? ecosystems.join(", ") : "all"}`);
  console.log("");

  // 1. Extract Renovate baseline
  console.log("Extracting Renovate baseline...");
  const renovateFindings = extractRenovateBaseline({
    repoRoot: absoluteRoot,
  });
  console.log(`  Found ${renovateFindings.length} Renovate findings`);

  // 2. Extract dependa shadow findings
  console.log("Extracting dependa shadow findings...");
  const dependaFindings = extractDependaShadow({
    repoRoot: absoluteRoot,
    ecosystems: ecosystems.length > 0 ? ecosystems : undefined,
  });
  console.log(`  Found ${dependaFindings.length} dependa findings`);

  // 3. Compare
  console.log("Comparing...");
  const dataset = compare(renovateFindings, dependaFindings, {
    repository: path.basename(absoluteRoot),
    baseRef: "HEAD",
    dependaVersion: "0.6.0",
    renovateVersion: "app",
  });

  // 4. Compute metrics
  const metrics = computeMetrics(dataset);

  // 5. Generate report
  const report = generateReport(dataset);
  const markdown = renderReportMarkdown(report);

  // 6. Output
  console.log("");
  console.log(markdown);

  // Write dataset as JSONL
  const outputPath = path.join(absoluteRoot, "dogfood", "conformance-report.jsonl");
  fs.writeFileSync(outputPath, toJSONL(dataset), "utf-8");
  console.log(`\nDataset written to ${outputPath}`);
}

main();
