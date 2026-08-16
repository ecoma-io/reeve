/**
 * What `doctor: true` actually checks, as data — no `core.*` call anywhere in
 * this module, so it can be tested against a hand-built `TrackerApi` the same
 * way every duty's own decision logic is, rather than only through a spawned
 * bundle.
 *
 * **Read-only, and only ever the real reader.** This never writes a label, a
 * comment, or a file — it reads `warrant`, the labels a duty would check it
 * against, and each duty's own `DEFAULT_CAPABILITIES` (see `capabilities.ts`
 * under each duty), and reports what a run would find. It parses the warrant
 * through `readWarrant`/`resolveAuthority`, the exact functions every duty's
 * own `main.ts` calls — a second parser here would be a second chance for
 * this report and a real run to disagree about what the file says.
 *
 * **A finding is red only when it would refuse a duty at runtime.** A missing
 * label without `create: true`, a warrant that does not parse, a token
 * GitHub's own labels endpoint refuses — every one of those is a condition
 * that stops a real run the same way. A duty denied everything by a written
 * `capabilities:` block that simply does not name it is not one of these: a
 * duty finding out its file has no opinion of it is a real, designed answer
 * (see `unnamed`'s own doc comment in `core/warrant.ts`), not a failure, and
 * it is reported as such — in the authority table, not among the findings.
 *
 * **Capacity is weather here exactly as it is everywhere else in this
 * codebase** — see
 * [D12](../../docs/doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration).
 * `isCapacityError` is imported rather than re-decided: the question "is this
 * worth ending the check over" has one answer, shared with `triage`'s
 * `propose.ts` and `lifecycle`'s sweep.
 */
import type { Location, TrackerApi } from "../core/forge.js";
import { isCapacityError, listRepositoryLabels } from "../core/forge.js";
import {
  checkLabelsExist,
  checkLifecycleLabelsExist,
  readWarrant,
  resolveAuthority,
  type Authority,
  type Capability,
  type Warrant,
} from "../core/warrant.js";
import { DEFAULT_CAPABILITIES as DEPENDA_DEFAULTS } from "../duties/dependa/capabilities.js";
import { DEFAULT_CAPABILITIES as DUPLICATE_DEFAULTS } from "../duties/duplicate/capabilities.js";
import { DEFAULT_CAPABILITIES as HARMONISE_DEFAULTS } from "../duties/harmonise/capabilities.js";
import {
  DEFAULT_CAPABILITIES as LIFECYCLE_DEFAULTS,
  LIFECYCLE_CAPABILITIES,
} from "../duties/lifecycle/capabilities.js";
import { DEFAULT_CAPABILITIES as RESPOND_DEFAULTS } from "../duties/respond/capabilities.js";
import { DEFAULT_CAPABILITIES as TRANSLATE_DEFAULTS } from "../duties/translate/capabilities.js";
import { DEFAULT_CAPABILITIES as TRIAGE_DEFAULTS } from "../duties/triage/capabilities.js";
import { DUTIES } from "../refusal.js";

/** The endpoint named in every finding the labels check produces. */
const LABELS_ENDPOINT = "GET /repos/{owner}/{repo}/labels";

/**
 * Every built duty's own fallback, wired to its name.
 *
 * The values are never re-decided here — each is imported from the same
 * `capabilities.ts` a duty's own `main.ts` reads (see that file's doc
 * comment for why it exists as a separate module at all). This map is only
 * ever the wiring from a duty's name to the constant that already carries
 * its default; the default itself has exactly one source, per duty.
 */
const DEFAULTS_BY_DUTY: ReadonlyMap<string, readonly Capability[]> = new Map([
  ["translate", TRANSLATE_DEFAULTS],
  ["triage", TRIAGE_DEFAULTS],
  ["duplicate", DUPLICATE_DEFAULTS],
  ["respond", RESPOND_DEFAULTS],
  ["lifecycle", LIFECYCLE_DEFAULTS],
  ["harmonise", HARMONISE_DEFAULTS],
  ["dependa", DEPENDA_DEFAULTS],
]);

/**
 * Every duty's own ladder of capabilities it actually has a use for, wired
 * to its name — `null` when a duty has no narrower ladder than "whatever the
 * warrant grants it". Only `lifecycle` narrows today (see
 * `LIFECYCLE_CAPABILITIES`'s own doc comment); the map exists so a future
 * duty that grows the same kind of narrowing needs one entry here, not a
 * second filtering scheme.
 */
const LADDER_BY_DUTY: ReadonlyMap<string, readonly Capability[] | null> = new Map([
  ["translate", null],
  ["triage", null],
  ["duplicate", null],
  ["respond", null],
  ["lifecycle", LIFECYCLE_CAPABILITIES],
]);

/** Whether a finding stops a real run (`red`) or describes a healthy or weather condition (`green`). */
export type Severity = "red" | "green";

export interface Finding {
  readonly severity: Severity;
  /** One paragraph, already worded for the job summary. */
  readonly text: string;
}

/** One duty's row in the effective-authority table. */
export interface AuthorityRow {
  readonly duty: string;
  /**
   * What this duty would actually be granted right now — already narrowed by
   * its own ladder (see `LADDER_BY_DUTY`) the same way a real run narrows it,
   * so this is the duty's true effective authority, not just the warrant's
   * raw say-so. Empty when `denied`.
   */
  readonly granted: readonly Capability[];
  /** True when a written `capabilities:` block exists and does not name this duty. */
  readonly denied: boolean;
  /** True when `granted` is exactly this duty's own built-in default (see `DEFAULTS_BY_DUTY`). */
  readonly isDefault: boolean;
  /**
   * Capabilities the warrant granted this duty that its own ladder filters
   * back out — granted, but never asked for, the same distinction a real
   * `lifecycle` run's `core.notice` warns about at runtime. Empty for every
   * duty whose `LADDER_BY_DUTY` entry is `null`.
   */
  readonly unused: readonly Capability[];
}

export interface Report {
  readonly warrantPath: string;
  readonly owner: string;
  readonly repo: string;
  /** The one duty this report was scoped to by the `duty` input, or `null` for every duty. */
  readonly duty: string | null;
  /** True when there was no warrant file, and this report describes the narrowest authority instead. */
  readonly implicit: boolean;
  /** Repository labels the implicit warrant would leave out for carrying no description. */
  readonly excludedLabels: readonly string[];
  readonly authority: readonly AuthorityRow[];
  readonly findings: readonly Finding[];
}

/** How many findings would refuse a duty at runtime — the `problems` output, and doctor's own exit signal. */
export function problems(report: Report): number {
  return report.findings.filter((finding) => finding.severity === "red").length;
}

export interface DiagnoseOptions {
  readonly api: TrackerApi;
  readonly at: Pick<Location, "owner" | "repo">;
  readonly warrantPath: string;
  /** Handed to `readWarrant` so it can tell a consumer's silence from a consumer's choice — see its own doc comment. */
  readonly defaultWarrantPath: string;
  /** Already normalised (trimmed, lower-cased) by the caller, or `null` for every duty. */
  readonly duty: string | null;
}

/** The report `doctor: true` writes to the job summary and reduces to `problems`. */
export async function diagnose(options: DiagnoseOptions): Promise<Report> {
  const { api, at, warrantPath, defaultWarrantPath, duty } = options;
  const base: Report = {
    warrantPath,
    owner: at.owner,
    repo: at.repo,
    duty,
    implicit: false,
    excludedLabels: [],
    authority: [],
    findings: [],
  };

  if (duty !== null && !DUTIES.includes(duty)) {
    return {
      ...base,
      findings: [
        {
          severity: "red",
          text: `\`duty\`: \`${duty}\` is not a duty this build has. Available: ${DUTIES.join(", ")}.`,
        },
      ],
    };
  }

  let read: Warrant | null;
  try {
    read = await readWarrant(warrantPath, { defaultPath: defaultWarrantPath });
  } catch (error) {
    return { ...base, findings: [{ severity: "red", text: message(error) }] };
  }

  let authority: Authority;
  try {
    authority = await resolveAuthority(read, warrantPath, api, at);
  } catch (error) {
    // Only reached when `read` was `null` — `resolveAuthority` only ever
    // touches the network to build the implicit warrant.
    return { ...base, findings: [classify(error, LABELS_ENDPOINT)] };
  }

  const findings: Finding[] = [];

  if (authority.implicit) {
    findings.push({
      severity: "green",
      text:
        `No \`${warrantPath}\` — this run would act at the narrowest authority: labels only, ` +
        "from this repository's own label descriptions.",
    });
    if (authority.excludedLabels.length > 0) {
      findings.push({
        severity: "green",
        text:
          `${authority.excludedLabels.map((name) => `\`${name}\``).join(", ")} — these labels have ` +
          "no description on GitHub, so they would be left out of the taxonomy this run built.",
      });
    }
  } else {
    // Skipped when implicit, the same guard `triage`'s sweep uses: a
    // taxonomy built only from labels a listing call already confirmed to
    // exist cannot itself be missing one.
    let existing: readonly string[] | null = null;
    try {
      existing = (await listRepositoryLabels(api, at)).map((label) => label.name);
    } catch (error) {
      findings.push(classify(error, LABELS_ENDPOINT));
    }

    if (existing !== null) {
      try {
        const toCreate = checkLabelsExist(authority.warrant, existing);
        findings.push(
          toCreate.length > 0
            ? {
                severity: "green",
                text:
                  `${toCreate.map((label) => `\`${label.name}\``).join(", ")} — missing, but marked ` +
                  "`create: true`; a duty granted `label` creates them rather than failing.",
              }
            : {
                severity: "green",
                text: `Every label \`${warrantPath}\` names exists on this repository.`,
              },
        );
      } catch (error) {
        findings.push({ severity: "red", text: message(error) });
      }

      if (authority.warrant.lifecycle !== null) {
        try {
          checkLifecycleLabelsExist(authority.warrant, existing);
          findings.push({
            severity: "green",
            text: "Every label `lifecycle:` references exists on this repository.",
          });
        } catch (error) {
          findings.push({ severity: "red", text: message(error) });
        }
      }
    }
  }

  const scoped = duty === null ? DUTIES : [duty];
  const authorityRows = scoped.map((name) => authorityRow(authority.warrant, name));

  // One aggregated note, not one per duty — named once so a reader sees the
  // whole set of duties running unmodified at their own built-in default in
  // a single place. `isDefault` alone is deliberately the only test: a duty
  // `warrant.unnamed` denies is a different, separate fact, already visible
  // in its own row (`denied: true`), and never belongs in this note — a
  // written `capabilities:` block that leaves a duty out denies it, it does
  // not default it (see `unnamed`'s own doc comment in `core/warrant.ts`).
  const defaulted = authorityRows.filter((row) => row.isDefault && !row.denied);
  if (defaulted.length > 0) {
    findings.push({
      severity: "green",
      text:
        `${defaulted.map((row) => `\`${row.duty}\``).join(", ")} — each duty's effective grant ` +
        "above is exactly its own built-in default right now.",
    });
  }

  return {
    ...base,
    implicit: authority.implicit,
    excludedLabels: authority.excludedLabels,
    authority: authorityRows,
    findings,
  };
}

/** One duty's effective grant, and why. */
function authorityRow(warrant: Warrant, duty: string): AuthorityRow {
  const fallback = DEFAULTS_BY_DUTY.get(duty) ?? [];
  if (warrant.unnamed(duty)) {
    return { duty, granted: [], denied: true, isDefault: false, unused: [] };
  }
  const grantedRaw = warrant.granted(duty, fallback);
  const ladder = LADDER_BY_DUTY.get(duty) ?? null;
  const granted = ladder === null ? grantedRaw : grantedRaw.filter((c) => ladder.includes(c));
  const unused = ladder === null ? [] : grantedRaw.filter((c) => !ladder.includes(c));
  return { duty, granted, denied: false, isDefault: sameCapabilities(granted, fallback), unused };
}

/** Set equality, not array equality — a warrant may list a duty's default capabilities in a different order. */
function sameCapabilities(a: readonly Capability[], b: readonly Capability[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((capability) => set.has(capability));
}

/**
 * A GitHub API failure, turned into the finding it means — D12's classifier,
 * not a second one. A 429/5xx or a network-timeout-shaped error is capacity:
 * reported green, naming the endpoint and saying plainly that the check was
 * not performed. A 401/403 is the run's own token, refused: reported red,
 * the same as it would fail a real duty. Anything else is red too, since an
 * endpoint this run cannot read is a check that could not be performed.
 */
function classify(error: unknown, endpoint: string): Finding {
  if (isCapacityError(error)) {
    return {
      severity: "green",
      text: `${endpoint} — not performed, capacity: ${message(error)}. Not a broken configuration.`,
    };
  }
  const status = statusOf(error);
  if (status === 401 || status === 403) {
    return {
      severity: "red",
      text: `${endpoint} — refused this run's token (HTTP ${String(status)}): ${message(error)}.`,
    };
  }
  return { severity: "red", text: `${endpoint} — could not be read: ${message(error)}.` };
}

function statusOf(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
