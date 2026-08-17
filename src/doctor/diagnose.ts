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
 * `duties:` block that simply does not name it is not one of these: a
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
import { readdir } from "node:fs/promises";

import type { Location, TrackerApi } from "../core/forge.js";
import { isCapacityError, listRepositoryLabels } from "../core/forge.js";
import {
  AuthenticationFailure,
  createRoutedProvider,
  resolveEndpoints,
  rotateModels,
  shown,
  type Message,
  type Rotation,
} from "../core/provider.js";
import {
  checkLabelsExist,
  checkLifecycleLabelsExist,
  readWarrant,
  resolveAuthority,
  resolveLanguages,
  type Authority,
  type Capability,
  type Warrant,
} from "../core/warrant.js";
import {
  DEFAULT_CAPABILITIES as DEPENDA_DEFAULTS,
  DEPENDA_CAPABILITIES,
} from "../duties/dependa/capabilities.js";
import {
  DEFAULT_CAPABILITIES as DUPLICATE_DEFAULTS,
  DUPLICATE_CAPABILITIES,
} from "../duties/duplicate/capabilities.js";
import {
  DEFAULT_CAPABILITIES as HARMONISE_DEFAULTS,
  HARMONISE_CAPABILITIES,
} from "../duties/harmonise/capabilities.js";
import {
  DEFAULT_CAPABILITIES as LIFECYCLE_DEFAULTS,
  LIFECYCLE_CAPABILITIES,
} from "../duties/lifecycle/capabilities.js";
import {
  DEFAULT_CAPABILITIES as RESPOND_DEFAULTS,
  RESPOND_CAPABILITIES,
} from "../duties/respond/capabilities.js";
import {
  DEFAULT_CAPABILITIES as REVIEW_DEFAULTS,
  REVIEW_CAPABILITIES,
} from "../duties/review/capabilities.js";
import {
  REMEDIATION_DEFAULTS,
  REMEDIATION_CAPABILITIES,
} from "../duties/remediation/capabilities.js";
import {
  DEFAULT_CAPABILITIES as TRANSLATE_DEFAULTS,
  TRANSLATE_CAPABILITIES,
} from "../duties/translate/capabilities.js";
import {
  DEFAULT_CAPABILITIES as TRIAGE_DEFAULTS,
  TRIAGE_CAPABILITIES,
} from "../duties/triage/capabilities.js";
import { PROFILE_CODES } from "./profile.js";
import { DUTIES } from "../refusal.js";

/** The endpoint named in every finding the labels check produces. */
const LABELS_ENDPOINT = "GET /repos/{owner}/{repo}/labels";

/**
 * The one-token question the provider probe asks, asked only ever as weather.
 *
 * Deliberately not a verdict Reeve would ever build authority on, and not a
 * request whose answer could reach a thread: a single cheap completion,
 * reported green whatever it says. "Capacity is weather" (D12) is why every
 * answer lands in the green register even when a real run would fail red on
 * it — the probe exists so `doctor` can say whether the configured endpoint
 * answers at all, never to grant or deny anything.
 */
const PROBE_TURN: readonly Message[] = [{ role: "user", content: "ping" }];

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
  ["review", REVIEW_DEFAULTS],
  ["remediation", REMEDIATION_DEFAULTS],
]);

/**
 * Every duty's own ladder of capabilities it actually has a use for, wired
 * to its name. Each value is the duty's own `*_CAPABILITIES` export, the
 * same constant a real run's `permitted.includes()` reads, so `doctor`'s
 * narrowing is never a second guess. Every entry is non-`null`: a capability
 * the warrant grants a duty that the duty's ladder filters back out is inert,
 * and `doctor` reports it as such (see the `unused` finding). The values live
 * in each duty's `capabilities.ts` — never re-typed here — because `main.ts`
 * calls `run()` at import time and cannot be the module doctor mode imports
 * this from (see those files' doc comments).
 */
const LADDER_BY_DUTY: ReadonlyMap<string, readonly Capability[]> = new Map([
  ["translate", TRANSLATE_CAPABILITIES],
  ["triage", TRIAGE_CAPABILITIES],
  ["duplicate", DUPLICATE_CAPABILITIES],
  ["respond", RESPOND_CAPABILITIES],
  ["lifecycle", LIFECYCLE_CAPABILITIES],
  ["harmonise", HARMONISE_CAPABILITIES],
  ["dependa", DEPENDA_CAPABILITIES],
  ["review", REVIEW_CAPABILITIES],
  ["remediation", REMEDIATION_CAPABILITIES],
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
  /** True when a written `duties:` block exists and does not name this duty. */
  readonly denied: boolean;
  /** True when `granted` is exactly this duty's own built-in default (see `DEFAULTS_BY_DUTY`). */
  readonly isDefault: boolean;
  /**
   * Capabilities the warrant granted this duty that its own ladder filters
   * back out — granted, but never asked for, the same distinction a real
   * `lifecycle` run's `core.notice` warns about at runtime. Non-empty for a
   * duty spells an inert grant, which `diagnose` reports red.
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
  /**
   * Where this run's workspace lives, `process.cwd()` when absent — the one
   * place doctor can tell a genuine level-0 absence from a checkout that
   * never happened. Only consulted when the warrant is absent at the default
   * path, which is the only case where the distinction changes a finding.
   */
  readonly workspaceDir?: string;
  /**
   * The run's provider inputs, when the caller had any to hand. Present,
   * doctor probes the configured endpoint with a single tiny completion —
   * always weather, never authority — so a maintainer learns whether the
   * provider a duty would call is reachable at all. Absent, no probe happens
   * and the report never touches a provider. See `providerProbe` below.
   */
  readonly provider?: ProviderProbe;
}

/** The provider half of the probe: what `providerProbe` needs to reach an endpoint. */
export interface ProviderProbe {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly models: readonly string[];
  readonly modelNames: ReadonlyMap<string, string>;
  readonly endpoints: readonly {
    readonly alias: string;
    readonly baseUrl: string;
    readonly timeoutMs: number | null;
  }[];
  readonly apiKeys: readonly { readonly alias: string; readonly key: string }[];
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
    // An absent file at the default path is level 0 only when the absence is
    // a fact about the repository — the file was never written, or was
    // deleted to withdraw what it granted. A checkout that never happened
    // also leaves the file absent, and reporting the two the same way would
    // read "no warrant" off a runner that was never given the repository: a
    // lie about authority that makes a missing warrant look like the
    // narrowest authority. The one signal this run can read is the workspace
    // itself — `actions/checkout` populates it, and nothing else does — so a
    // workspace with no checkout in it turns the implicit report into a red
    // finding that names the actual problem.
    const checkout = await checkoutState(options.workspaceDir ?? process.cwd());
    if (checkout === "missing") {
      findings.push({
        severity: "red",
        text:
          `No checkout was found in this run's workspace, so the absence of ` +
          `\`${warrantPath}\` cannot be told from a deleted warrant. The configuration ` +
          "under check never reached this runner — run `actions/checkout` before `doctor`.",
      });
    } else {
      findings.push({
        severity: "green",
        text:
          `No \`${warrantPath}\` — this run would act at the narrowest authority: labels only, ` +
          "from this repository's own label descriptions.",
      });
    }
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

  // Inert grants: a capability the warrant granted a duty that the duty's own
  // ladder has no use for. The runtime ignores it, so a report that listed it
  // as effective authority would be a lie. RED, because it is the same
  // misspelled-capability failure the warrant reader names at parse time
  // ("Refused rather than dropped, everywhere") — only narrowable per duty in
  // doctor, where each duty's ladder lives. `duplicate: [close]` is the
  // canonical case. Scoped to the same duties the table reports, so a
  // `duty`-scoped run flags only the duty it was asked about.
  const inert = authorityRows.filter((row) => row.unused.length > 0);
  for (const row of inert) {
    const effective = row.granted.length === 0 ? "[none]" : `[${row.granted.join(", ")}]`;
    findings.push({
      severity: "red",
      text:
        `\`${row.duty}\` is granted ${row.unused.map((capability) => `\`${capability}\``).join(", ")}, ` +
        `which this duty has no use for — the warrant says more than a real run ` +
        `would apply (effective: \`${row.duty}: ${effective}\`). A capability nobody reads is a ` +
        "misspelled grant, so `doctor` flags it the way the reader refuses a misspelled " +
        "capability at parse time.",
    });
  }

  // Configured languages outside the bundled profile set: weather, never red —
  // the runtime deliberately treats an unsupported code as "not a failure"; it
  // just sends every ambiguous thread to the model instead of the free
  // byte-ngram step (see detectByProfile, and docs/guides/languages.md).
  // Resolved with the same `resolveLanguages` the duties use; when the warrant
  // is silent the run keeps each duty's documented default (`en, vi, zh`), all
  // inside the profile set — so only the warrant's own key can ever flag.
  if (authority.warrant.languages !== null) {
    const { languages: resolvedLanguages } = resolveLanguages(authority.warrant, []);
    const unsupported = resolvedLanguages.filter(
      (language) => !PROFILE_CODES.has(language.code.toLowerCase()),
    );
    if (unsupported.length > 0) {
      findings.push({
        severity: "green",
        text:
          `\`languages:\` names ${unsupported.map((language) => `\`${language.code}\``).join(", ")} — ` +
          "outside the bundled byte-ngram profile set, so the free `detectByProfile` step " +
          "declines for the whole run and every ambiguous thread is sent to the model instead. " +
          "Not a failure; spell the regional identity in the label and use the base " +
          "profiled code to keep the free step, or add the variant explicitly as a " +
          "candidate — the `code:Label:Script` long form keeps the code verbatim, so it " +
          "changes nothing here.",
      });
    }
  }

  // One aggregated note, not one per duty — named once so a reader sees the
  // whole set of duties running unmodified at their own built-in default in
  // a single place. `isDefault` alone is deliberately not the only test: a
  // duty `warrant.unnamed` denies is a different, separate fact, already
  // visible in its own row (`denied: true`), and never belongs in this note —
  // a written `duties:` block that leaves a duty out denies it, it does
  // not default it (see `unnamed`'s own doc comment in `core/warrant.ts`).
  // And a duty with an inert grant is excluded too: it carries its own red
  // finding just above, and "exactly its own built-in default right now"
  // next to a red flag would read as the report contradicting itself.
  // `unused` is what an inert grant took to the red finding, so filtering on
  // it keeps every duty the red loop already named out of this green note.
  const defaulted = authorityRows.filter(
    (row) => row.isDefault && !row.denied && row.unused.length === 0,
  );
  if (defaulted.length > 0) {
    findings.push({
      severity: "green",
      text:
        `${defaulted.map((row) => `\`${row.duty}\``).join(", ")} — each duty's effective grant ` +
        "above is exactly its own built-in default right now.",
    });
  }

  if (options.provider !== undefined) {
    findings.push(await providerProbe(options.provider));
  }

  return {
    ...base,
    implicit: authority.implicit,
    excludedLabels: authority.excludedLabels,
    authority: authorityRows,
    findings,
  };
}

/**
 * One tiny completion against every endpoint a run would use, reported green
 * whatever it answers.
 *
 * "Capacity is weather, authority is configuration" (D12) is the whole design
 * of this probe: a real duty fails red when its provider says 401, because
 * the run could not do its job; doctor is not that run, it is only saying
 * whether the configured endpoint would answer. So every outcome — a usable
 * answer, an auth refusal, a rate limit, a timeout, a body that would not
 * parse — is weather here, never a red finding. The one thing this probe is
 * not allowed to be is authority: nothing a provider says can grant a duty a
 * capability, and nothing in this report suggests otherwise.
 *
 * Switching off, deliberately: a keyless configuration (empty `api-key` over
 * HTTP) is supported, and no probe that can neither auth nor fail over the
 * wire is a probe worth spending a request on — the note says so instead.
 */
async function providerProbe(probe: ProviderProbe): Promise<Finding> {
  const endpoints = resolveEndpoints(probe);
  const keyed = endpoints.some((endpoint) => endpoint.apiKey.length > 0);
  if (!keyed) {
    return {
      severity: "green",
      text:
        "The configured provider is keyless — no probe was sent, and none could say anything " +
        "a keyed provider's could. Add `api-key` to probe the endpoint.",
    };
  }

  const provider = createRoutedProvider(endpoints);
  let rotation: Rotation;
  try {
    rotation = await rotateModels(probe.models, (model) => provider.complete(model, PROBE_TURN));
  } catch (error) {
    // `rotateModels` throws on the first `auth` failure — a real duty's D12
    // answer, since no rotation repairs a key that never worked. Doctor is
    // not that run, so the throw is caught here and reported as weather,
    // exactly as the `kind: "auth"` failure below is.
    const authFailure = error instanceof AuthenticationFailure ? error.failure : undefined;
    // The reason is always one of a fixed set — never a provider's own words.
    // A gateway can echo the request it refused (the key included) into its
    // error body, and a fetch failure can embed the endpoint URL, so a probe
    // that rendered either verbatim into the job summary would defeat the
    // masking the entry point does. The class of answer is enough: the probe
    // exists to say whether the endpoint answered, not to quote what it said.
    const reason =
      authFailure !== undefined
        ? "the configured endpoint refused this run's key (HTTP 401 or 403)"
        : error instanceof Error
          ? "the probe itself failed"
          : "the probe itself failed";
    return {
      severity: "green",
      text:
        `Provider probe — no configured model answered a tiny request: ${reason}. ` +
        "This is weather, not a configuration finding: the probe exists to say whether the " +
        "endpoint answers, and it says nothing about what any duty may do.",
    };
  }

  const answered = rotation.success;
  if (answered !== null) {
    const answeredName = shown(probe.modelNames, answered.model);
    const failedBefore = rotation.failures.length;
    const retried =
      failedBefore === 0
        ? ""
        : `${String(failedBefore)} model${failedBefore === 1 ? "" : "s"} rotated past before it, `;
    return {
      severity: "green",
      text:
        `Provider probe — the first configured model answered a tiny request: ${answeredName}` +
        `${retried.length === 0 ? "" : ` (${retried})`}. Weather, not authority: a probe that ` +
        "answered says nothing about what any duty may do.",
    };
  }

  // Nothing answered at all. Every failure is still weather — see the probe's
  // doc comment for why auth is not red here the way it is in a real run.
  const failures = rotation.failures;
  const auth = failures.find((failure) => failure.kind === "auth");
  const capacity = failures.find((failure) => failure.kind === "capacity");
  const protocol = failures.find((failure) => failure.kind === "protocol");
  // The same fixed-set discipline as the thrown-auth branch above: none of
  // these carries a provider's own words, because a provider-sourced reason
  // can echo the request (key included) back into the summary and undo the
  // entry point's masking. The class of failure is what matters.
  const reason =
    auth !== undefined
      ? "the configured endpoint refused this run's key (HTTP 401 or 403)"
      : capacity !== undefined
        ? capacity.transport === true
          ? "the endpoint could not be reached"
          : "the endpoint answered with a rate limit or server error"
        : protocol !== undefined
          ? "the endpoint answered outside the chat-completions protocol"
          : "the probe did not reach any provider";
  return {
    severity: "green",
    text:
      `Provider probe — no configured model answered a tiny request: ${reason}. ` +
      "This is weather, not a configuration finding: the probe exists to say whether the " +
      "endpoint answers, and it says nothing about what any duty may do.",
  };
}

/**
 * Whether the workspace holds any checkout at all: `"present"` when it holds
 * anything (including a `.git/` directory, which is its own honest marker),
 * `"missing"` when the directory does not exist or is empty.
 *
 * The distinction is only ever consulted when the warrant is absent — the one
 * case where "the workspace is empty" means "a real run would be acting at
 * level 0" and "the warrant never reached the runner" look identical from the
 * report's side. An empty workspace cannot be distinguished from "nothing was
 * ever checked out here", which is the whole point.
 */
async function checkoutState(workspaceDir: string): Promise<"present" | "missing"> {
  try {
    return (await readdir(workspaceDir)).length > 0 ? "present" : "missing";
  } catch {
    return "missing";
  }
}

/** One duty's effective grant, and why. */
function authorityRow(warrant: Warrant, duty: string): AuthorityRow {
  const fallback = DEFAULTS_BY_DUTY.get(duty) ?? [];
  if (warrant.unnamed(duty)) {
    return { duty, granted: [], denied: true, isDefault: false, unused: [] };
  }
  const grantedRaw = warrant.granted(duty, fallback);
  // Every duty `DUTIES` names has a ladder; the empty fallback covers a name
  // this build never heard of (left refusing everything) so the row is still
  // well-formed instead of crashing the report.
  const ladder = LADDER_BY_DUTY.get(duty) ?? [];
  const granted = grantedRaw.filter((c) => ladder.includes(c));
  const unused = grantedRaw.filter((c) => !ladder.includes(c));
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
