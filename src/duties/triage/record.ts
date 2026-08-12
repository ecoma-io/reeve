/**
 * `record`'s own pipeline — recognizing the event that triggers it, and
 * writing what it decided.
 *
 * `record` never re-triages: a label event or a reversed close already
 * carries a maintainer's decision, and this module's job is turning that
 * event into a `Correction`, not asking a model to reproduce it. `main.ts`'s
 * `run()` is still the one place that decides whether `record` applies at
 * all — `recordGrantedByFile`/`recordGrantedByRun` are the two halves of
 * that gate, kept here so both wear a name rather than a repeated
 * `.includes("record")` and a paragraph explaining it at every call site.
 */
import * as core from "@actions/core";
import { context } from "@actions/github";

import { createLanguagePicker, detectLanguage } from "../../core/detect.js";
import {
  isBotAuthor,
  listLabelEvents,
  type ContentsApi,
  type Location,
  type Standing,
  type TrackerApi,
} from "../../core/forge.js";
import { EXCERPT, type Correction } from "../../core/memory.js";
import { translateToPivot } from "../../core/pivot.js";
import { shown, type Weather } from "../../core/provider.js";
import { resolvePivot, type Authority, type Capability, type Warrant } from "../../core/warrant.js";

import { taxonomyNames, type Settings } from "./inputs.js";
import { removedByAutomation } from "./outcome.js";
import { writeCorrection } from "./store.js";
import type { Stages } from "./main.js";

/**
 * Whether the event that triggered this run is one `record` fires on, and —
 * for the one case worth saying anything about — why not.
 *
 * Two kinds of event, and `kind` tells them apart because the two write
 * completely different shapes: `labeled`/`unlabeled` on `issues`, from a
 * human, is a standing-label correction (`recordCorrection`); `reopened` on
 * `issues`, from a human, is a candidate reversal of one of Reeve's own
 * closes (`checkReversal`, `recordReversal`) and needs the API evidence
 * `checkReversal` gathers before it is known whether there is anything to
 * record at all. Not `opened`, not `edited`, not a re-triage on either kind
 * — `record` never re-triages, it takes an event as a maintainer's word for
 * something and writes that down. And not a bot on either kind: a label
 * another automation applied, or a reopen a second bot performed, is not a
 * maintainer's word for anything.
 */
export interface RecordTrigger {
  readonly eligible: boolean;
  readonly kind: "label" | "reopen";
  /**
   * Why the sender disqualified an otherwise-eligible event — empty on every
   * other path, including the one that fires and the ones that were never
   * going to: the wrong event entirely, or an `issues` action besides the
   * three this fires on. Those are not worth a maintainer's attention — a
   * workflow granting `record` that also runs on `opened` or a `push` is not
   * misconfigured, that leg was simply never going to record — so only a
   * human-shaped event that turned out to come from a bot is the reason
   * anything gets logged over.
   */
  readonly reason: string;
}

export function recordTrigger(): RecordTrigger {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "issues") return { eligible: false, kind: "label", reason: "" };

  const payload = context.payload as {
    action?: string;
    sender?: { login?: string; type?: string };
  };

  if (payload.action === "reopened") {
    if (isBotAuthor(payload.sender)) {
      return { eligible: false, kind: "reopen", reason: "the reopen came from a bot" };
    }
    return { eligible: true, kind: "reopen", reason: "" };
  }

  if (payload.action !== "labeled" && payload.action !== "unlabeled") {
    return { eligible: false, kind: "label", reason: "" };
  }

  if (isBotAuthor(payload.sender)) {
    return { eligible: false, kind: "label", reason: "the label change came from a bot" };
  }

  return { eligible: true, kind: "label", reason: "" };
}

/** The human behind this run's triggering event — a handle, without the `@`. */
export function senderLogin(): string {
  const payload = context.payload as { sender?: { login?: string } };
  return payload.sender?.login ?? "";
}

/**
 * The taxonomy label a `labeled`/`unlabeled` event named, for the one call
 * site that turns it into `proposed`'s honest before/after delta —
 * `recordCorrection`. `null` for every event this is not, including a sweep,
 * which has no single event to read at all, and including a `reopened`
 * event, which names no label.
 */
export function labelChange(): {
  readonly label: string;
  readonly action: "labeled" | "unlabeled";
} | null {
  const payload = context.payload as { action?: string; label?: { name?: string } };
  if (payload.action !== "labeled" && payload.action !== "unlabeled") return null;
  const label = payload.label?.name;
  if (label === undefined || label.length === 0) return null;
  return { label, action: payload.action };
}

/**
 * Whether `.github/reeve.yml` (or the implicit warrant) grants `record` at
 * all — the file's own half of the gate `run()` checks before recording
 * anything. The other half is `recordGrantedByRun`: a run needs both, because
 * the file and the workflow's `apply` each withhold `record` independently,
 * and the two are worth telling apart — a file grant `apply` narrowed away is
 * a different maintainer mistake than a file that never granted it at all.
 *
 * That first mistake is the common one: `apply` defaults to `label` alone, so
 * a maintainer who grants `record` only in the file — and never adds it to
 * the workflow's own `apply` input — gets nothing recorded, silently, until
 * `recordGrantedByRun`'s half of the gate is understood too.
 */
export function recordGrantedByFile(grantedCapabilities: readonly Capability[]): boolean {
  return grantedCapabilities.includes("record");
}

/**
 * Whether this run's own `apply` — the file's grant narrowed by the input, as
 * `narrow` computes it — still includes `record`. See `recordGrantedByFile`
 * for the other half of the gate.
 */
export function recordGrantedByRun(permitted: readonly Capability[]): boolean {
  return permitted.includes("record");
}

/** What a `record` run concluded — a mirror of `Outcome`, sized for the much smaller pipeline it took. */
export interface RecordOutcome {
  readonly recorded: boolean;
  readonly language: string | null;
  readonly decided: readonly string[];
  readonly pivot: boolean;
  /** Why a pivot rendering was not produced, when one was attempted and it was not. */
  readonly pivotNote: string | null;
  /**
   * Set when a migration sweep found every taxonomy label on this thread
   * machine-applied — see `recordCorrection`'s guard. `recorded` is `false`
   * alongside it: nothing here was a maintainer's own decision, so nothing
   * was written. Never set outside a migration sweep.
   */
  readonly machineOnly: boolean;
  /**
   * Set when a migration sweep could not read this thread's whole label
   * history — `listLabelEvents` hit its page ceiling with the last page
   * still full. `recorded` is `false` alongside it, the same fail-closed
   * choice as `machineOnly`: a label with no event this run could see is not
   * proof a human applied it, only proof this run stopped reading before it
   * got there, and importing it as a maintainer's correction on that basis
   * would be exactly the self-training loop the guard exists to prevent.
   * Never set outside a migration sweep.
   */
  readonly unattributable: boolean;
}

/**
 * The pivot-language rendering for a correction about to be written, shared
 * by `recordCorrection` and `recordReversal` so a store's two record paths
 * stay identical about what "no pivot" means and why — see `Correction.pivot`'s
 * own doc comment for what a `null` here means to a reader downstream.
 */
async function computePivot(
  warrant: Warrant,
  standing: Standing,
  body: string,
  code: string | null,
  settings: Settings,
  stages: Stages,
  weather: Weather,
): Promise<{ readonly pivot: Correction["pivot"]; readonly pivotNote: string | null }> {
  const pivotLanguage =
    settings.languages.length > 0 ? resolvePivot(warrant, settings.languages) : null;
  if (pivotLanguage === null || code === null || code === pivotLanguage.code) {
    return { pivot: null, pivotNote: null };
  }

  const pivotModels = settings.screenModels.length > 0 ? settings.screenModels : settings.models;
  const pivotNames = settings.screenModels.length > 0 ? settings.screenNames : settings.modelNames;
  const rendered = await translateToPivot({
    provider: stages.pivot,
    models: pivotModels,
    title: standing.title,
    body,
    to: pivotLanguage,
    weather,
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
  });
  for (const failure of rendered.failures) {
    core.warning(`record: ${shown(pivotNames, failure.model)} — ${failure.reason}`);
  }
  if (rendered.draft !== null) {
    return {
      pivot: {
        language: pivotLanguage.code,
        title: rendered.draft.title,
        excerpt: rendered.draft.body.slice(0, EXCERPT),
      },
      pivotNote: null,
    };
  }

  // Weather, not a broken configuration — the write below still happens. A
  // correction without a pivot rendering is still a correction; a run that
  // refused to record over a starved translation would be trading a sure
  // thing for a nice-to-have.
  const pivotNote =
    "A pivot-language rendering could not be produced this run, so the correction was " +
    "recorded without one.";
  core.info(pivotNote);
  return { pivot: null, pivotNote };
}

/**
 * Records the current state of a thread as a correction — the taxonomy-
 * filtered labels standing on it now, its title and body, its language —
 * rather than asking for a fresh verdict. `record` never re-triages: a label
 * event already carries the maintainer's decision, and asking a model to
 * reproduce it would be asking it to guess at something already known.
 *
 * `dry-run` runs every step below except the commit itself, so the log and
 * the `recorded` output both say what a real run would have done.
 *
 * `by` is who this correction is attributed to — the human who changed the
 * label on a single-thread run, or the literal `"sweep"` when this is bulk
 * migration composing `record` with `sweep`: there is no one sender to name
 * for a thread nobody just relabelled, only a run that decided to import what
 * was already decided.
 *
 * **Bulk migration guards against training on its own past output.** A
 * migration sweep imports whatever labels stand on a thread as though they
 * were a maintainer's correction — but months of ordinary triage sweeps
 * running with `apply: label` leave plenty of threads carrying labels this
 * duty applied itself, not a maintainer. Importing those is a self-training
 * loop, not history: this run's own old verdicts, re-taught back to it as
 * ground truth. `by === "sweep"` is the one path this can happen on — a
 * single-thread run is always triggered by a human's own label change, and
 * has nothing to distrust — and there alone, each candidate taxonomy label is
 * checked against its most recent `labeled` event; one whose actor is a bot
 * is excluded. A thread left with nothing decidable is not recorded at all.
 *
 * The guard fails closed on a thread whose label history is longer than one
 * run reads, too: `listLabelEvents` reports `complete: false` when it hit its
 * own page ceiling without reaching the start of the timeline, and a label
 * with no event in what this run did see is not proof a human applied it —
 * only proof the read stopped before it got there. Nothing is imported from
 * that thread this run rather than guess.
 */
export async function recordCorrection(
  api: TrackerApi & ContentsApi,
  at: Location,
  standing: Standing,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
  by: string,
  changed: { readonly label: string; readonly action: "labeled" | "unlabeled" } | null,
): Promise<RecordOutcome> {
  const warrant = authority.warrant;

  // Taxonomy-filtered against `settings.taxonomy`, not the whole warrant: a
  // label some other tool or automation applied is not a maintainer
  // correcting this duty's taxonomy, and neither is a label from another
  // area's slice of a shared file this run's own `labels` never named —
  // recording either would teach recall a category this run was never asked
  // to propose.
  let decidedLabels = standing.labels.filter((name) => taxonomyNames(settings).has(name));

  if (by === "sweep" && decidedLabels.length > 0) {
    const history = await listLabelEvents(api, at);

    if (!history.complete) {
      core.info(
        `#${String(at.number)}: label history is longer than one run reads — cannot attribute, ` +
          "nothing imported.",
      );
      return {
        recorded: false,
        language: null,
        decided: [],
        pivot: false,
        pivotNote: null,
        machineOnly: false,
        unattributable: true,
      };
    }

    // Oldest first, so the last write into this map for a given label is its
    // most recent `labeled` event — exactly the one the guard cares about.
    const lastLabeledByBot = new Map<string, boolean>();
    for (const event of history.events) {
      if (event.action === "labeled") lastLabeledByBot.set(event.label, event.isBot);
    }
    decidedLabels = decidedLabels.filter((name) => !(lastLabeledByBot.get(name) ?? false));

    if (decidedLabels.length === 0) {
      core.info(
        `#${String(at.number)}: every taxonomy label here was machine-applied — nothing to import.`,
      );
      return {
        recorded: false,
        language: null,
        decided: [],
        pivot: false,
        pivotNote: null,
        machineOnly: true,
        unattributable: false,
      };
    }
  }

  const limit = settings.maxBodyChars;
  const body = limit === null ? standing.body : standing.body.slice(0, limit);

  const detection = await detectLanguage(
    body.length === 0 ? standing.title : body,
    settings.languages,
    createLanguagePicker(
      stages.detect,
      settings.screenModels.length > 0 ? settings.screenModels : settings.models,
      weather,
      settings.temperature,
    ),
  );
  // The code, because that is what the store and the pivot comparison below
  // both compare against — the same convention `decide`'s recall path reads
  // corrections by. The output-facing `language` a maintainer reads on this
  // run's page is a different value, further down: the same label the
  // ordinary `decide` path reports, so a workflow reading this action's
  // `language` output sees the same shape whichever path produced it.
  const code = detection.language?.code ?? null;

  const { pivot, pivotNote } = await computePivot(
    warrant,
    standing,
    body,
    code,
    settings,
    stages,
    weather,
  );

  // A genuine single-thread record — never a sweep — carries the label event
  // that triggered it, which is what turns `proposed` from an empty list
  // into an honest before/after delta: the taxonomy-filtered labels standing
  // on the thread a moment before this event landed. Only a change to a
  // taxonomy label is worth computing this for — a `labeled`/`unlabeled`
  // event on a label outside the taxonomy already left `decidedLabels`
  // untouched, and a delta around a label this duty never proposes would say
  // nothing a maintainer corrected.
  let proposed: readonly string[] = [];
  let outcomeField: Correction["outcome"] = null;
  if (by !== "sweep" && changed !== null && taxonomyNames(settings).has(changed.label)) {
    const before = new Set(decidedLabels);
    if (changed.action === "unlabeled") before.add(changed.label);
    else before.delete(changed.label);
    proposed = [...before];

    // S1: a taxonomy label a human just removed, when it was Reeve's own
    // prior run that applied it — the enrichment on top of the ordinary
    // (S2) correction this function already writes for every human relabel.
    // See `removedByAutomation`'s own doc comment for why an incomplete
    // history answers "not automation" rather than "unknown".
    if (changed.action === "unlabeled") {
      outcomeField = (await removedByAutomation(api, at, changed.label)) ? "overruled" : null;
    }
  }

  const correction: Correction = {
    repo: `${at.owner}/${at.repo}`,
    thread: at.number,
    duty: "triage",
    at: new Date().toISOString(),
    title: standing.title,
    excerpt: body.slice(0, EXCERPT),
    language: code,
    proposed,
    decided: decidedLabels,
    by,
    note: null,
    outcome: outcomeField,
    duplicateOf: null,
    pivot,
  };

  if (settings.dryRun) {
    core.info(
      `Would record #${String(at.number)} as ` +
        (decidedLabels.length > 0 ? decidedLabels.join(", ") : "no labels") +
        `${pivot !== null ? ", with a pivot rendering" : ""} — dry run, nothing committed.`,
    );
  } else {
    await writeCorrection(api, at, settings.corrections, correction);
  }

  return {
    recorded: true,
    language: detection.language?.label ?? null,
    decided: decidedLabels,
    pivot: pivot !== null,
    pivotNote,
    machineOnly: false,
    unattributable: false,
  };
}

/**
 * Records a human's reopen of a thread Reeve closed as a duplicate — S3 in
 * the outcome taxonomy `recall.ts` renders. Written under `duty: "duplicate"`
 * rather than `"triage"`, deliberately: the replacement key is (repo,
 * thread, duty), so this reversal lives in its own slot and can never
 * silently overwrite — or be overwritten by — whatever `recordCorrection`
 * last wrote for this thread's standing labels. See `Correction.duty`'s doc
 * comment.
 *
 * The caller (`run()`) only reaches this function after `checkReversal` has
 * already established both halves of the evidence — the close really was
 * Reeve's own, and the reopener has the standing to reverse it — so nothing
 * here re-checks either; this function's only job is turning that finding
 * into the record.
 *
 * Title, excerpt, language and pivot are gathered the same way
 * `recordCorrection` gathers them for an ordinary correction — S3 gets the
 * same cross-language reach as every other record, not a second-class one.
 */
export async function recordReversal(
  api: TrackerApi & ContentsApi,
  at: Location,
  standing: Standing,
  authority: Authority,
  settings: Settings,
  stages: Stages,
  weather: Weather,
  by: string,
  duplicateOf: number,
): Promise<RecordOutcome> {
  const warrant = authority.warrant;

  const limit = settings.maxBodyChars;
  const body = limit === null ? standing.body : standing.body.slice(0, limit);

  const detection = await detectLanguage(
    body.length === 0 ? standing.title : body,
    settings.languages,
    createLanguagePicker(
      stages.detect,
      settings.screenModels.length > 0 ? settings.screenModels : settings.models,
      weather,
      settings.temperature,
    ),
  );
  const code = detection.language?.code ?? null;

  const { pivot, pivotNote } = await computePivot(
    warrant,
    standing,
    body,
    code,
    settings,
    stages,
    weather,
  );

  // `decided` is incidental standing on a reversal line, not the correction
  // itself — see `Correction.decided`'s own doc comment on that distinction.
  // Kept anyway, filtered the same way an ordinary correction's `decided` is,
  // so a reader never has to special-case a reversal line to know what the
  // thread carries.
  const decidedLabels = standing.labels.filter((name) => taxonomyNames(settings).has(name));

  const correction: Correction = {
    repo: `${at.owner}/${at.repo}`,
    thread: at.number,
    duty: "duplicate",
    at: new Date().toISOString(),
    title: standing.title,
    excerpt: body.slice(0, EXCERPT),
    language: code,
    proposed: [],
    decided: decidedLabels,
    by,
    note: null,
    outcome: "overruled",
    duplicateOf,
    pivot,
  };

  if (settings.dryRun) {
    core.info(
      `Would record #${String(at.number)}'s reopen as reversing a close that named it a ` +
        `duplicate of #${String(duplicateOf)} — dry run, nothing committed.`,
    );
  } else {
    await writeCorrection(api, at, settings.corrections, correction);
  }

  return {
    recorded: true,
    language: detection.language?.label ?? null,
    decided: decidedLabels,
    pivot: pivot !== null,
    pivotNote,
    machineOnly: false,
    unattributable: false,
  };
}

/** One sweep row's outcome under bulk migration, in the fewest words that are true. */
export function describeRecordOutcome(outcome: RecordOutcome): string {
  return outcome.decided.length > 0
    ? `recorded as ${outcome.decided.map((name) => `\`${name}\``).join(", ")}`
    : "recorded with no taxonomy labels";
}
