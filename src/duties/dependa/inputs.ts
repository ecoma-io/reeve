/**
 * Input parsing for the `dependa` duty.
 *
 * Follows the same pattern as every other duty's inputs module:
 * read from `@actions/core`, validate strictly, refuse rather than guess.
 */
import * as core from "@actions/core";

import {
  bounded,
  counted,
  readCore,
  type ApiKeySpec,
  type EndpointSpec,
} from "../../core/inputs.js";
import type { Capability } from "../../core/warrant.js";
import type { Names } from "../../core/provider.js";
import { parseApply } from "../../core/enforce.js";
import type { Ecosystem } from "./model.js";
import { ECOSYSTEMS } from "./model.js";

export interface Settings {
  readonly token: string;
  readonly models: readonly string[];
  readonly modelNames: Names;
  readonly warrant: string;
  readonly apply: readonly Capability[];
  readonly ecosystems: readonly Ecosystem[];
  readonly drafts: number;
  readonly dryRun: boolean;
  readonly maxRequests: number | null;
  readonly paths: readonly string[];
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly endpoints: readonly EndpointSpec[];
  readonly apiKeys: readonly ApiKeySpec[];
  readonly requestTimeoutMs: number;
  readonly temperature: number | undefined;
  /** Capabilities permitted by the warrant, narrowed with `apply`. Set after authority step. */
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
    apply: parseApply(core.getInput("apply", { required: true })),
    ecosystems: parseEcosystems(core.getInput("ecosystems")),
    drafts: counted("drafts", core.getInput("drafts")),
    dryRun: core.getBooleanInput("dry-run"),
    maxRequests: bounded("max-requests", core.getInput("max-requests")),
    paths: parsePaths(core.getInput("paths")),
  };
}

/**
 * Parse the `ecosystems` input — comma or newline separated.
 * Empty means all known ecosystems. Unknown names are refused.
 */
function parseEcosystems(raw: string): readonly Ecosystem[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  const entries = trimmed
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) return [];

  const ecosystems: Ecosystem[] = [];
  for (const entry of entries) {
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
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  return trimmed
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
