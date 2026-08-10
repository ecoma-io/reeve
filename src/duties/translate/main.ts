/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. Each decision it reaches for lives in a
 * module that is tested on its own — most of them in the core, which is shared
 * with every other duty — and the only judgement made here is the order they run
 * in and what a failure at each step means for the run:
 *
 *   1. Read the thread, and keep only the author's half of the body — anything
 *      below the marker is this duty's own output, not a source.
 *   2. Stop when there is nothing to translate — an empty body, or text with no
 *      prose in it at all — and stop when the fingerprint of that half and the
 *      target languages matches what is already published. This is what makes an
 *      edit-triggered rerun free, and it is what stops the loop that writing into
 *      the body creates.
 *   3. Truncate to `max-body-chars`, and remember that the block has to say so.
 *   4. Detect the source language — script, then profile, then a model, and
 *      `null` is a real answer meaning none of the configured languages wrote
 *      it.
 *   5. Translate into every configured language except the one it came from.
 *   6. Let the panel pick between the drafts the score admitted.
 *   7. Append the translations to the body, under the marker.
 *   8. When `translate-replies` is on, do all of the above again per reply.
 *
 * **Steps 1–7 are one function, run once per text.** A reply has an author, a
 * body, and a reader who needs it in their language, so it gets the same
 * treatment rather than a cheaper one — including its own fingerprint, which is
 * what keeps a hundred-reply backfill from re-spending anything on the
 * ninety-nine that have not changed.
 *
 * **A language that fails does not fail the run.** A provider out of quota for
 * Chinese must still publish the English translation that worked, and say which
 * one it could not do. Only a broken configuration and a thread that cannot be
 * read are `setFailed` — everything else is a warning and a `skipped` output a
 * workflow can branch on. A reply that fails is smaller still: it is warned
 * about and the run moves to the next one, because a thread whose body
 * translated and whose fourth reply did not is better off published than
 * failed.
 *
 * This file is excluded from coverage because it calls `run()` at import, so
 * measuring it would execute the action. It is exercised by driving the built
 * bundle against a stub API, which is what a runner does — see
 * `main.integration.test.ts`.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { createLanguagePicker, detectLanguage, residue } from "../../core/detect.js";
import { createReply, createThread, listReplies, type Thread } from "../../core/forge.js";
import { readShared, whole } from "../../core/inputs.js";
import { parseLanguages, type Language } from "../../core/languages.js";
import { createProvider, parseModels, type Provider } from "../../core/provider.js";
import { assemble, publish } from "../../core/publish.js";

import { translate } from "./draft.js";
import { judge } from "./judge.js";
import {
  marker,
  publication,
  translationFingerprint,
  type Attribution,
  type Posted,
  type Translated,
} from "./publish.js";

interface Settings {
  readonly token: string;
  readonly number: number;
  readonly models: readonly string[];
  readonly languages: readonly Language[];
  readonly judges: readonly string[];
  readonly drafts: number;
  readonly maxBodyChars: number;
  readonly replies: boolean;
  readonly attribution: Attribution;
  readonly dryRun: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * The inputs, parsed and rejected here rather than deeper in.
 *
 * The five every duty shares come from the core, so `models` means the same
 * thing here as it will in the next duty a consumer configures. What is left is
 * this duty's own, and every problem it throws on is a typo in a workflow file:
 * a run that continued past one would translate into a language nobody asked for
 * or spend a provider's budget on a number that was never a number.
 */
function readSettings(): Settings {
  const shared = readShared();

  return {
    ...shared,
    languages: parseLanguages(core.getInput("languages", { required: true })),
    judges: parseModels(core.getInput("judge-models")),
    drafts: whole("drafts", core.getInput("drafts")),
    maxBodyChars: whole("max-body-chars", core.getInput("max-body-chars")),
    replies: core.getBooleanInput("translate-replies"),
    attribution: readAttribution(),
  };
}

/**
 * The `show-attribution` input, refused rather than guessed at.
 *
 * A misspelling is a workflow that would otherwise publish a hundred bodies with
 * the wrong amount of detail in them and say nothing — and the fingerprint means
 * the run that fixes the spelling will not rewrite them. Failing on the first
 * thread is the cheap end of that.
 */
function readAttribution(): Attribution {
  const raw = core.getInput("show-attribution").trim().toLowerCase();
  if (raw === "none" || raw === "model" || raw === "detail") return raw;
  throw new Error(`show-attribution: expected \`none\`, \`model\` or \`detail\`, got \`${raw}\`.`);
}

/**
 * The author's own words, and whether the tail of them was left behind.
 *
 * Split before truncation, so the limit applies to what is actually translated
 * rather than being spent on a block a previous run wrote. Takes text rather
 * than fetching it, because a reply's body arrives from the listing that found
 * it and a body arrives from the thread — the same three answers either way.
 */
function readBody(
  body: string,
  limit: number,
): { official: string; source: string; truncated: boolean; published: string | null } {
  const { official, fingerprint: published } = marker.split(body);
  return {
    official,
    source: official.slice(0, limit),
    truncated: official.length > limit,
    published,
  };
}

/**
 * The languages to translate into: every configured one except the one the
 * thread is already written in.
 *
 * A thread whose language is none of the configured ones is translated into all
 * of them. That is the honest reading of "no source language among these": a
 * German issue in a repository set up for English, Vietnamese and Chinese needs
 * all three, and there is nothing to leave out.
 */
function targets(languages: readonly Language[], from: Language | null): readonly Language[] {
  if (from === null) return languages;
  const source = from.code.toLowerCase();
  return languages.filter((language) => language.code.toLowerCase() !== source);
}

async function translateInto(
  to: Language,
  settings: Settings,
  provider: Provider,
  from: Language | null,
  source: string,
): Promise<Posted | null> {
  const drafted = await translate({
    provider,
    models: settings.models,
    source,
    from,
    to,
    languages: settings.languages,
    drafts: settings.drafts,
  });

  for (const failure of drafted.failures) {
    core.warning(`${to.code}: ${failure.model} failed — ${failure.reason}`);
  }
  for (const refused of drafted.refused) {
    core.warning(
      `${to.code}: ${refused.model} was refused — ${refused.score.reason ?? "unscored"}`,
    );
  }

  const verdict = await judge({
    provider,
    judges: settings.judges,
    source,
    to,
    attempts: drafted.attempts,
  });

  for (const failure of verdict.failures) {
    core.warning(`${to.code}: judge ${failure.model} — ${failure.reason}`);
  }

  if (verdict.winner === null) return null;

  const votes = verdict.votes.map((vote) => `${vote.model}→${vote.pick}`).join(", ");
  core.info(
    `${to.code}: ${verdict.winner.model} by ${verdict.decidedBy}` +
      ` (score ${verdict.winner.score.value.toFixed(3)}${votes.length > 0 ? `, ${votes}` : ""})`,
  );

  // A contest only when there was one. One draft that no judge voted on won by
  // being the only candidate, and `Scored 0.91 of 1.00, decided by score` reads
  // like a field of losers was beaten. Leaving it absent lets the block say the
  // one true thing — which model wrote this — and stop.
  const contested = drafted.attempts.length > 1 || verdict.votes.length > 0;

  return {
    to,
    text: verdict.winner.text,
    model: verdict.winner.model,
    ...(contested
      ? {
          decision: {
            score: verdict.winner.score.value,
            drafts: drafted.attempts.length,
            decidedBy: verdict.decidedBy,
            votes: verdict.votes.map((vote) => ({ model: vote.model, pick: vote.pick })),
          },
        }
      : {}),
  };
}

/** What one text cost and produced, whether it was a body or a reply. */
interface Report {
  readonly from: Language | null;
  readonly posted: readonly Posted[];
  readonly skipped: readonly Language[];
  /** True when this text got a translation written to it this run. */
  readonly published: boolean;
}

const NOTHING: Report = { from: null, posted: [], skipped: [], published: false };

/**
 * Steps 1–7 for one text, wherever it lives.
 *
 * `what` names the text in the log — `#42` or `#42 comment 991` — because a run
 * over a thread and twelve replies otherwise reports thirteen indistinguishable
 * verdicts. `thread` is the port to write back through, so this function never
 * knows whether it is editing an issue body or a comment.
 */
async function translateText(
  what: string,
  body: string,
  thread: Thread,
  settings: Settings,
  provider: Provider,
): Promise<Report> {
  const { official, source, truncated, published } = readBody(body, settings.maxBodyChars);
  if (source.trim().length === 0) {
    core.info(`${what} has an empty body — nothing to translate.`);
    return NOTHING;
  }

  // A stack trace, a log paste, a bare URL: text with no prose in it is written
  // the same way in every language, so there is nothing here to translate into
  // anything. Screened before detection rather than after it, because detection
  // would honestly answer `unknown` — and `unknown` means "translate into all of
  // them", which is the most expensive answer available for the one input where
  // no answer is worth anything.
  if (residue(source).trim().length === 0) {
    core.info(`${what} has no prose in it — nothing to translate.`);
    return NOTHING;
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
    return NOTHING;
  }

  if (truncated) {
    core.warning(
      `${what}: only the first ${String(settings.maxBodyChars)} characters were ` +
        "translated. Raise `max-body-chars` to translate the rest.",
    );
  }

  const detection = await detectLanguage(
    source,
    settings.languages,
    createLanguagePicker(provider, settings.models),
  );
  core.info(
    detection.language === null
      ? `${what}: source language is none of the configured ones (${String(detection.candidates.length)} candidates).`
      : `${what}: source language ${detection.language.code} (by ${detection.by}).`,
  );

  const posted: Posted[] = [];
  const skipped: Language[] = [];
  for (const to of targets(settings.languages, detection.language)) {
    const translated = await translateInto(to, settings, provider, detection.language, source);
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
  };

  if (settings.dryRun) {
    const would = publication(translated);
    core.info(
      would.sections.length === 0
        ? `Dry run — ${what} would have been left alone: no language produced a translation.`
        : `Dry run — ${what} would have become:\n${assemble(official, marker, would)}`,
    );
    return { from: detection.language, posted, skipped, published: false };
  }

  const outcome = await publish(thread, marker, publication(translated));
  core.info(
    outcome.action === "none"
      ? `${what}: nothing written — ${outcome.reason}.`
      : `${what}: ${outcome.action}.`,
  );

  return {
    from: detection.language,
    posted,
    skipped,
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
async function translateReplies(
  api: ReturnType<typeof getOctokit>,
  at: { owner: string; repo: string; number: number },
  settings: Settings,
  provider: Provider,
): Promise<number> {
  const { replies, more } = await listReplies(api, at);
  if (more) {
    core.warning(
      `#${String(at.number)} has more replies than one run reads, so the oldest were not ` +
        "translated. They are picked up by editing them, or by a run against a smaller thread.",
    );
  }

  let published = 0;
  for (const reply of replies) {
    const translated = await translateText(
      `#${String(at.number)} comment ${String(reply.id)}`,
      reply.body,
      createReply(api, at, reply),
      settings,
      provider,
    );
    if (translated.published) published += 1;
  }
  return published;
}

export async function run(): Promise<void> {
  try {
    const settings = readSettings();
    const api = getOctokit(settings.token);
    const at = { ...context.repo, number: settings.number };
    const provider = createProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });

    const thread = createThread(api, at);
    const body = await thread.read();
    const translated = await translateText(
      `#${String(at.number)}`,
      body,
      thread,
      settings,
      provider,
    );

    // Even when the body needed nothing. A new comment on an already-translated
    // thread is the ordinary case for this feature: the body's fingerprint still
    // matches, and the reply is the only thing that changed.
    const replies = settings.replies ? await translateReplies(api, at, settings, provider) : 0;

    report(translated, replies);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Every output, written on every path that reaches an answer — including the
 * ones that answer "nothing". A workflow branching on `skipped` needs it to be
 * an empty array rather than an unset output on the run where everything worked.
 *
 * The three language outputs describe the thread's own body and not its replies.
 * A reply has its own source language and its own skipped set, and folding
 * twelve of those into one array would produce a value no workflow could act on
 * — so replies report the one thing that is answerable across all of them: how
 * many got a translation written.
 */
function report(translated: Report, replies: number): void {
  core.setOutput("source-language", translated.from?.code ?? "");
  core.setOutput("translated", JSON.stringify(translated.posted.map((entry) => entry.to.code)));
  core.setOutput("skipped", JSON.stringify(translated.skipped.map((language) => language.code)));
  core.setOutput("replies-translated", String(replies));
}

await run();
