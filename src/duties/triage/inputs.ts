/**
 * `triage`'s own input contract — the shape `readSettings` (in `main.ts`)
 * fills in, and the pure transforms that shape needs.
 *
 * Pure, deliberately: nothing here calls `core.getInput` or `core.setOutput`
 * or touches the tracker, and every function is a straight transform from a
 * string (or the warrant) to a typed value or a thrown `Error`. `readSettings`
 * itself stays in `main.ts` rather than moving here — see its own doc comment
 * for why — but everything it and the rest of the duty need to turn a raw
 * input into a validated one lives in this module instead. That is also the
 * rule this module answers to: `main.ts` value-imports this one, but nothing
 * here may value-import anything from `main.ts` back. `main.ts` calls `await
 * run()` at its own top level (see `vitest.config.ts`'s coverage exclusion),
 * and a value import running the other way would close that into an import
 * cycle — a type-only import back, where one is ever needed, is erased
 * before that would matter.
 */
import type { ApiKeySpec, EndpointSpec } from "../../core/inputs.js";
import type { Language } from "../../core/languages.js";
import type { Names } from "../../core/provider.js";
import type { Capability, Label, Warrant } from "../../core/warrant.js";

export interface Settings {
  readonly token: string;
  /** The thread to work on, or null in `sweep`. */
  readonly number: number | null;
  readonly models: readonly string[];
  readonly modelNames: Names;
  /** The cheap roster. Empty turns the model-backed screen off, which is the default. */
  readonly screenModels: readonly string[];
  readonly screenNames: Names;
  readonly languages: readonly Language[];
  readonly warrant: string;
  /**
   * The subset of `warrant.labels` this run may propose — `labels`'s own
   * answer, in the warrant's order. The whole taxonomy when `labels` named
   * nothing. See `resolveTaxonomy`.
   */
  readonly taxonomy: readonly Label[];
  readonly apply: readonly Capability[];
  readonly confidence: number;
  readonly correctionsDir: string;
  readonly about: string;
  readonly minBodyChars: number;
  /** `null` is no bound at all — see `bounded`'s doc comment for the sentinel rule. */
  readonly maxBodyChars: number | null;
  readonly dryRun: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly sweep: boolean;
  readonly since: Date | null;
  /** `null` is no ceiling at all — see `bounded`'s doc comment for the sentinel rule. */
  readonly limit: number | null;
  readonly endpoints: readonly EndpointSpec[];
  readonly apiKeys: readonly ApiKeySpec[];
  readonly requestTimeoutMs: number;
  readonly temperature: number | undefined;
  /**
   * Which resource state a sweep considers — a filter on what it fetches, not
   * a different mode of the duty. See `parseSweepState`.
   */
  readonly sweepState: SweepState;
  /**
   * A branch to write corrections to instead of the default branch. When set,
   * correction files are committed to this branch and a draft pull request is
   * opened for maintainer review. `record` and `open-pr` must both be granted.
   * Empty writes directly to the default branch.
   */
  readonly stateBranch: string;
}

/** `sweep-state`'s three spellings, as `parseSweepState` reads them. */
export type SweepState = "open" | "closed" | "all";
export const SWEEP_STATES: readonly SweepState[] = ["open", "closed", "all"];

/**
 * Which resource state a sweep considers.
 *
 * A resource filter, not a mode: it changes what `listOpenThreads` fetches,
 * nothing about how a fetched thread is decided. `open` is the default and
 * the ordinary case — a sweep keeping a fresh backlog triaged. `closed` and
 * `all` exist for the case this duty's `record` capability makes possible
 * when it composes with `sweep`: a one-time bulk migration that imports a
 * project's already-decided history — including threads a maintainer closed
 * long before this action existed — into the corrections store in one run,
 * rather than one label event at a time from here on.
 */
export function parseSweepState(raw: string): SweepState {
  const value = raw.trim().toLowerCase();
  const match = SWEEP_STATES.find((state) => state === value);
  if (match === undefined) {
    throw new Error(`sweep-state: expected one of ${SWEEP_STATES.join(", ")}, got \`${raw}\`.`);
  }
  return match;
}

/**
 * `labels`, narrowed against the warrant's own taxonomy — in the warrant's
 * order, because that order is what breaks a tie between two proposals, not
 * the input's.
 *
 * Empty is the whole taxonomy, unchanged: a monorepo with one area per
 * directory and one shared `.github/reeve.yml` points every area's workflow
 * at the same file and uses this to keep each one proposing only the labels
 * its own area owns, without maintaining a taxonomy file per area. A name
 * this asks for that the file does not have is refused rather than quietly
 * dropped — a typo here would otherwise triage forever with one label
 * missing from the roster and nothing saying so.
 */
export function resolveTaxonomy(warrant: Warrant, raw: string): readonly Label[] {
  const requested = raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (requested.length === 0) return warrant.labels;

  for (const name of requested) {
    if (warrant.labelNamed(name) === undefined) {
      throw new Error(
        `labels: \`${name}\` is not in \`${warrant.path}\`'s taxonomy. ` +
          "Add it there, or correct the name.",
      );
    }
  }
  const wanted = new Set(requested);
  return warrant.labels.filter((label) => wanted.has(label.name));
}

/** `settings.taxonomy`'s own names, for the places that check membership rather than shape. */
export function taxonomyNames(settings: Settings): ReadonlySet<string> {
  return new Set(settings.taxonomy.map((label) => label.name));
}
