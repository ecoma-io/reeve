/**
 * Steps 1–8 of the pipeline: turning one thread's body, and then its replies,
 * into whatever this run publishes — the part of the duty that actually
 * calls a model and writes to GitHub, as opposed to the sweep bookkeeping and
 * reporting that stays in `main.ts` around it.
 *
 * **The `dryRun` gate sits inside `translateText`, after drafting and before
 * the `edit-body` permission check.** A dry run's whole job is to report what
 * this run would have written, and a write the `edit-body` capability would
 * withhold is still something the run would have drafted — so a dry run has
 * to say so even on a run where a real write never had permission to happen.
 * Checking `dryRun` first answers that; checking permission first would
 * report nothing instead, which is not what a dry run promises. This is
 * translate's own placement, not a shared rule: triage checks `dryRun` at
 * each call site instead of inside a shared step, and duplicate checks it
 * inside `act`, one function further into its own pipeline — three different
 * shapes for the same knob, an accepted divergence (see the design's §1.2).
 */
import * as core from "@actions/core";
import { type getOctokit } from "@actions/github";

import { createLanguagePicker, detectLanguage, residue } from "../../core/detect.js";
import { createReply, createThread, listReplies, type Thread } from "../../core/forge.js";
import { type Language } from "../../core/languages.js";
import { type Weather } from "../../core/provider.js";
import { assemble, publish } from "../../core/publish.js";
import { type Meter } from "../../core/meter.js";

import { budgetExhausted, type Budget } from "./budget.js";
import { translateInto, type Stages, type RosterCheck } from "./engine.js";
import { readBody, targets } from "./inputs.js";
import { type Looked } from "./summary.js";
import {
  marker,
  publication,
  translationFingerprint,
  type Posted,
  type Translated,
} from "./publish.js";
import type { Settings } from "./main.js";

/**
 * What one text cost and produced, whether it was a body or a reply.
 *
 * `Looked` is the reporting half and lives with the summary that renders it;
 * what this adds is the one thing only the caller needs — whether anything was
 * actually written, which is what `replies-translated` counts.
 */
export interface Report extends Looked {
  /** True when this text got a translation written to it this run. */
  readonly published: boolean;
}

export function nothing(what: string, note: string): Report {
  return { what, from: null, posted: [], skipped: [], budgetSkipped: [], note, published: false };
}

/**
 * Steps 1–7 for one text, wherever it lives.
 *
 * `what` names the text in the log — `#42` or `#42 comment 991` — because a run
 * over a thread and twelve replies otherwise reports thirteen indistinguishable
 * verdicts. `thread` is the port to write back through, so this function never
 * knows whether it is editing an issue body or a comment.
 *
 * `branding` is the one thing that has to come from the caller, precisely
 * *because* this function cannot tell a body from a reply and must not learn
 * to. The branding line belongs on a thread's body and on nothing else: a
 * reader lands on a body once, and scrolls past every reply under it. So the
 * two call sites decide — `processThread` passes what the workflow configured,
 * `translateReplies` passes `false` — and everything between them stays
 * identical, which is the property that keeps a reply from quietly getting a
 * cheaper pipeline than a body.
 */
export async function translateText(
  what: string,
  body: string,
  thread: Thread,
  branding: boolean,
  settings: Settings,
  stages: Stages,
  weather: Weather,
  meter: Meter,
  budget: Budget,
  onRosterExhausted?: RosterCheck,
): Promise<Report> {
  const { official, source, truncated, published } = readBody(body, settings.maxBodyChars);
  if (source.trim().length === 0) {
    core.info(`${what} has an empty body — nothing to translate.`);
    return nothing(what, "empty body");
  }

  // A stack trace, a log paste, a bare URL: text with no prose in it is written
  // the same way in every language, so there is nothing here to translate into
  // anything. Screened before detection rather than after it, because detection
  // would honestly answer `unknown` — and `unknown` means "translate into all of
  // them", which is the most expensive answer available for the one input where
  // no answer is worth anything.
  if (residue(source).trim().length === 0) {
    core.info(`${what} has no prose in it — nothing to translate.`);
    return nothing(what, "no prose to translate");
  }

  // Before a single request is made, because the whole value of this check is
  // that it costs nothing. Publishing fires the `edited` event this workflow
  // listens for, so the run that event starts has to reach this line and stop —
  // that is the termination argument, and it holds for a PAT and an App
  // installation, which get no recursion prevention from GitHub.
  // Over `source` rather than `official`, so the digest describes the text that
  // is actually translated. Hashing the whole body while translating a prefix of
  // it made `max-body-chars` a one-way door: raising it left the marker matching
  // and the run skipping, so the tail the block promises to come back for never
  // was. The two are the same string whenever nothing was truncated, which is
  // why a thread translated in full keeps the marker it already has.
  const wanted = translationFingerprint(source, settings.languages);
  if (published === wanted) {
    core.info(`${what} already carries the translation for this text and these languages.`);
    return nothing(what, "already translated");
  }

  if (truncated) {
    core.warning(
      `${what}: only the first ${String(settings.maxBodyChars)} characters were ` +
        "translated. Raise `max-body-chars` to translate the rest.",
    );
  }

  // Before detection, same as every other checkpoint below: the free checks
  // above already ran (they cost nothing to make, whatever the budget), but
  // detection is the first thing that would actually spend a request, and a
  // budget already at its ceiling has no business starting a text it cannot
  // finish deciding about.
  if (budgetExhausted(settings, meter, budget)) {
    core.warning(`${what}: \`max-requests\` was reached, so this text was not attempted this run.`);
    return nothing(what, "budget exhausted");
  }

  const detection = await detectLanguage(
    source,
    settings.languages,
    createLanguagePicker(stages.detect, settings.models, weather),
  );
  core.info(
    detection.language === null
      ? `${what}: source language is none of the configured ones (${String(detection.candidates.length)} candidates).`
      : `${what}: source language ${detection.language.code} (by ${detection.by}).`,
  );

  const toTranslate = targets(settings.languages, detection.language);
  const posted: Posted[] = [];
  const skipped: Language[] = [];
  const budgetSkipped: Language[] = [];
  for (const [index, to] of toTranslate.entries()) {
    // Checked before spending the request a language is about to cost, not
    // after — so a budget set tight enough to stop mid-thread stops before
    // the request that would have gone over it, not after.
    if (budgetExhausted(settings, meter, budget)) {
      const remaining = toTranslate.slice(index);
      skipped.push(...remaining);
      budgetSkipped.push(...remaining);
      core.warning(
        `${what}: \`max-requests\` was reached, so ${remaining.map((language) => language.code).join(", ")} ` +
          `${remaining.length === 1 ? "was" : "were"} not attempted this run. ` +
          "What was already drafted still publishes.",
      );
      break;
    }

    const translated = await translateInto(
      to,
      settings,
      stages,
      detection.language,
      source,
      weather,
      onRosterExhausted,
    );
    if (translated === null) {
      core.warning(`${what} ${to.code}: no model produced a translation this run.`);
      skipped.push(to);
    } else {
      posted.push(translated);
    }
  }

  // What the run got, not what it was asked for. `wanted` above is the whole
  // configured set; this is the set that came back, plus the source language,
  // which the run legitimately had nothing to translate into. The two are equal
  // exactly when nothing was skipped — so a language a provider could not
  // translate this run leaves a marker the next run does not match, and the next
  // run tries it again instead of reading its own claim and stopping.
  const achieved = translationFingerprint(source, [
    ...posted.map((entry) => entry.to),
    ...(detection.language === null ? [] : [detection.language]),
  ]);

  const translated: Translated = {
    from: detection.language,
    posted,
    skipped,
    truncated,
    fingerprint: achieved,
    attribution: settings.attribution,
    branding,
  };

  if (settings.dryRun) {
    const would = publication(translated);
    core.info(
      would.sections.length === 0
        ? `Dry run — ${what} would have been left alone: no language produced a translation.`
        : `Dry run — ${what} would have become:\n${assemble(official, marker, would)}`,
    );
    return {
      what,
      from: detection.language,
      posted,
      skipped,
      budgetSkipped,
      note: null,
      published: false,
    };
  }

  // Guarded here and nowhere earlier: detection, drafting and judging all ran
  // and all spent whatever they were going to spend, exactly as they would
  // under a bare-grant warrant — a capability the file withheld is a reason
  // not to write, not a reason not to have decided.
  if (!settings.permitted.includes("edit-body")) {
    // The note reaches the summary and the sweep's outcome column, so a
    // reader can tell a write the warrant blocked from a run where no
    // draft survived — the two look identical once `posted` is emptied. Only
    // set when something was actually withheld: with no drafts, "no draft
    // survived" is the true story whatever the warrant says. A warrant that
    // never granted `edit-body` is the whole story — there is no second gate
    // to blame half of.
    if (posted.length > 0) {
      core.warning(
        `${what}: \`edit-body\` is not permitted this run, so ` +
          `${posted.length === 1 ? "the translation" : `${String(posted.length)} translations`} ` +
          `drafted this run ${posted.length === 1 ? "was" : "were"} not published.`,
      );
      return {
        what,
        from: detection.language,
        posted: [],
        skipped,
        budgetSkipped,
        note:
          `\`edit-body\` is not permitted this run, so the ` +
          `${posted.length === 1 ? "translation" : `${String(posted.length)} translations`} ` +
          `drafted this run ${posted.length === 1 ? "was" : "were"} not published`,
        published: false,
      };
    }
    return {
      what,
      from: detection.language,
      posted: [],
      skipped,
      budgetSkipped,
      note: null,
      published: false,
    };
  }

  const outcome = await publish(thread, marker, publication(translated));
  core.info(
    outcome.action === "none"
      ? `${what}: nothing written — ${outcome.reason}.`
      : `${what}: ${outcome.action}.`,
  );
  // Not red: the write already landed, and whatever raced it is a fact about
  // this run's timing, not about whether it was allowed to happen.
  // `docs/getting-started/installation.md`'s `concurrency:` group is the fix;
  // this is the run saying it hit exactly the gap that guidance closes.
  if (outcome.action === "published" && outcome.mismatched) {
    core.warning(
      `${what}: another write landed on this thread between this run's write and its check — ` +
        "the body may not be exactly what this run published. Add a `concurrency:` group keyed " +
        "on the thread (see the installation guide) to stop two runs from racing the same body.",
    );
  }

  return {
    what,
    from: detection.language,
    posted,
    skipped,
    budgetSkipped,
    note: null,
    published: outcome.action === "published",
  };
}

/**
 * Every reply on the thread, each translated on its own terms.
 *
 * Its own detection and its own fingerprint per reply, rather than the thread's:
 * a Vietnamese issue routinely collects English answers, and a reply inherits
 * neither the language of the body nor the language of the reply above it.
 *
 * Sequential rather than concurrent. The provider Reeve is built for is whatever
 * a consumer can run for nothing, and firing a hundred completions at one is how
 * a run that would have finished gets rate-limited into failing halfway.
 */
export async function translateReplies(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
  settings: Settings,
  stages: Stages,
  looked: Looked[],
  weather: Weather,
  meter: Meter,
  budget: Budget,
  onRosterExhausted?: RosterCheck,
): Promise<number> {
  const { replies, more } = await listReplies(api, at, {
    max: settings.maxReplies ?? Number.MAX_SAFE_INTEGER,
    order: "newest",
  });
  if (more) {
    core.warning(
      `#${String(at.number)} has more replies than one run reads, so the oldest were not ` +
        "translated. They are picked up by editing them, or by a run against a smaller thread.",
    );
  }

  let published = 0;
  for (const reply of replies) {
    // Checked before the reply's own first request, same as the per-language
    // check inside `translateText` — a reply not yet started is cheaper to
    // leave for a later run than one translated into half its languages.
    if (budgetExhausted(settings, meter, budget)) {
      core.warning(
        `#${String(at.number)}: \`max-requests\` was reached, so its remaining replies were not ` +
          "attempted this run.",
      );
      break;
    }

    const translated = await translateText(
      `#${String(at.number)} comment ${String(reply.id)}`,
      reply.body,
      createReply(api, at, reply),
      // Never on a reply, whatever `show-branding` says. The setting decides
      // whether a thread carries the line at all; this decides that "a thread"
      // means its body — a logo repeated under every comment on an active
      // thread is not a signature, it is noise the reader cannot collapse.
      false,
      settings,
      stages,
      weather,
      meter,
      budget,
      onRosterExhausted,
    );
    looked.push(translated);
    if (translated.published) published += 1;
  }
  return published;
}

/**
 * Steps 1–8 for one thread, from a body already in hand.
 *
 * The single call both modes route every thread through — `run` for the one
 * thread an event named, `runSweep` for however many `limit` allows — so a
 * change to what translating one thread involves cannot land in one mode and
 * not the other. Takes the body rather than fetching it, so a sweep spends no
 * second request on a thread its own listing already read.
 */
export interface ThreadResult {
  readonly looked: readonly Looked[];
  readonly translated: Report;
  readonly replies: number;
  /**
   * Why this duty was granted nothing, when a written `duties:` block
   * simply does not name it — `null` on every path that reached `decide`'s
   * translate equivalent at all, including one that translated nothing for
   * an ordinary reason.
   */
  readonly ungranted: string | null;
}

export async function processThread(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
  body: string,
  settings: Settings,
  stages: Stages,
  weather: Weather,
  meter: Meter,
  budget: Budget,
  onRosterExhausted?: RosterCheck,
): Promise<ThreadResult> {
  const thread = createThread(api, at);
  const translated = await translateText(
    `#${String(at.number)}`,
    body,
    thread,
    // The body is the one text in the thread that gets the branding line, so
    // this is the only place the workflow's own answer is consulted.
    settings.branding,
    settings,
    stages,
    weather,
    meter,
    budget,
    onRosterExhausted,
  );
  const looked: Looked[] = [translated];

  const replies = settings.replies
    ? await translateReplies(
        api,
        at,
        settings,
        stages,
        looked,
        weather,
        meter,
        budget,
        onRosterExhausted,
      )
    : 0;

  return { looked, translated, replies, ungranted: null };
}
