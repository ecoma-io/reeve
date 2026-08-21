/**
 * Input parsing for the `dependa` duty.
 *
 * Follows the same pattern as every other duty's inputs module:
 * read from `@actions/core`, validate strictly, refuse rather than guess.
 */
import * as core from "@actions/core";

import { bounded, readCore, type ApiKeySpec, type EndpointSpec } from "../../core/inputs.js";
import { parseList } from "../../core/list.js";
import type { Capability } from "../../core/warrant.js";
import type { Names } from "../../core/provider.js";
import type { Ecosystem } from "./model.js";
import { ECOSYSTEMS } from "./model.js";

export interface Settings {
  readonly token: string;
  readonly models: readonly string[];
  readonly modelNames: Names;
  readonly warrant: string;
  readonly ecosystems: readonly Ecosystem[];
  /**
   * Whether a model reads the evidence and writes an advisory risk summary.
   * A flag rather than a count: the interpretation is one request per
   * proposal, taken or not taken — there is no draft-and-score pass behind
   * it, and a number here would promise one.
   */
  readonly riskInterpretation: boolean;
  readonly dryRun: boolean;
  readonly maxRequests: number | null;
  readonly paths: readonly string[];
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly endpoints: readonly EndpointSpec[];
  readonly apiKeys: readonly ApiKeySpec[];
  readonly requestTimeoutMs: number;
  readonly temperature: number | undefined;
  /** What the file grants — the sole authority, so the run's only `permitted` list. */
  readonly permitted: readonly Capability[];
}

export function readSettings(): Omit<Settings, "permitted"> {
  // Models are optional for dependa — used only for advisory risk
  // interpretation, not for classification. The deterministic pipeline
  // runs regardless of whether a model is configured.
  const coreInputs = readCore({ modelsOptional: true });

  return {
    ...coreInputs,
    warrant: core.getInput("warrant", { required: true }),
    ecosystems: parseEcosystems(core.getInput("ecosystems")),
    riskInterpretation: core.getBooleanInput("risk-interpretation"),
    maxRequests: bounded("max-requests", core.getInput("max-requests")),
    paths: parsePaths(core.getInput("paths")),
  };
}

/**
 * Parse the `ecosystems` input — comma or newline separated.
 * Empty means all known ecosystems. Unknown names are refused.
 */
function parseEcosystems(raw: string): readonly Ecosystem[] {
  const ecosystems: Ecosystem[] = [];
  for (const entry of parseList(raw)) {
    const eco = ECOSYSTEMS.find((e) => e === entry);
    if (eco === undefined) {
      throw new Error(
        `ecosystems: \`${entry}\` is not a known ecosystem. Expected any of ${ECOSYSTEMS.join(", ")}, or empty for all.`,
      );
    }
    if (!ecosystems.includes(eco)) ecosystems.push(eco);
  }

  return ecosystems;
}

/**
 * Parse the `paths` input — comma or newline separated.
 * Empty means scan the whole repository.
 */
function parsePaths(raw: string): readonly string[] {
  return parseList(raw);
}
