/**
 * The one-language, one-chunk draft-and-judge pass, and the whole-language
 * pipeline built out of it.
 *
 * No tracker access and no input reads anywhere in this module — everything
 * here is a provider request and the bookkeeping around it, which is what
 * makes it the cleanest cut out of `main.ts`: `translateChunk` and
 * `translateInto` take a `Settings` already resolved and a `Stages` already
 * built, and hand back either a result or `null`, never a decision about
 * whether to write one.
 */
import * as core from "@actions/core";

import type { Language } from "../../core/languages.js";
import { chunks, isCodeOnly } from "../../core/markdown.js";
import { shown, type Failure, type Provider, type Weather } from "../../core/provider.js";

/**
 * A hook the caller can supply to detect whole-roster protocol exhaustion at
 * the point where it is discovered — the one operation whose models all failed.
 *
 * Translate's pipeline discards failures after logging them, so main.ts cannot
 * reconstruct which operation's models exhausted the roster from any run-wide
 * aggregate. The callback receives the exact models and failures from the
 * single empty-draft operation, which is the only semantically safe input for
 * {@link failIfProtocolExhausted}: merging unrelated failures from separate
 * rotations could falsely imply the entire roster was protocol-exhausted when
 * each rotation independently had at least one success.
 *
 * Optional because tests and internal callers have no reason to act on it.
 */
export type ProtocolCheck = (models: readonly string[], failures: readonly Failure[]) => void;

import { translate } from "./draft.js";
import { judge } from "./judge.js";
import type { Settings } from "./main.js";
import type { Posted } from "./publish.js";

/**
 * One provider per stage, each counting its own requests.
 *
 * Three handles on the same endpoint rather than one, because the meter records
 * a purpose and a stage is the only thing that knows its own. Built once in
 * `run` and passed down, so a stage cannot be metered as another one by being
 * called from the wrong place.
 */
export interface Stages {
  readonly detect: Provider;
  readonly draft: Provider;
  readonly judge: Provider;
}

/** One chunk's own draft-and-judge pass — everything a single-chunk body used to get, once. */
export interface ChunkResult {
  readonly text: string;
  /** The model that wrote it, already a display name — or null for a chunk no model touched. */
  readonly model: string | null;
  readonly contested: boolean;
  readonly score: number;
  readonly drafts: number;
  readonly decidedBy: "score" | "judges";
  readonly votes: readonly { readonly model: string; readonly pick: string }[];
}

export async function translateChunk(
  to: Language,
  settings: Settings,
  stages: Stages,
  from: Language | null,
  source: string,
  weather: Weather,
  onProtocolExhausted?: ProtocolCheck,
): Promise<ChunkResult | null> {
  const drafted = await translate({
    provider: stages.draft,
    models: settings.models,
    source,
    from,
    to,
    languages: settings.languages,
    drafts: settings.drafts,
    weather,
  });

  // Named as the workflow named them, everywhere a person reads them. A
  // maintainer who called a model `Careful` did so because the id is theirs to
  // keep, and a warning quoting the id would hand it to the log they masked it
  // out of.
  const model = (id: string): string => shown(settings.modelNames, id);

  for (const failure of drafted.failures) {
    core.warning(`${to.code}: ${model(failure.model)} failed — ${failure.reason}`);
  }
  for (const refused of drafted.refused) {
    core.warning(
      `${to.code}: ${model(refused.model)} was refused — ${refused.score.reason ?? "unscored"}`,
    );
  }

  if (drafted.attempts.length === 0) {
    onProtocolExhausted?.(settings.models, drafted.failures);
  }

  const verdict = await judge({
    provider: stages.judge,
    judges: settings.judges,
    source,
    to,
    attempts: drafted.attempts,
    weather,
  });

  const seat = (id: string): string => shown(settings.judgeNames, id);

  for (const failure of verdict.failures) {
    core.warning(`${to.code}: judge ${seat(failure.model)} — ${failure.reason}`);
  }

  if (verdict.winner === null) return null;

  const cast = verdict.votes.map((vote) => ({ model: seat(vote.model), pick: model(vote.pick) }));
  const votes = cast.map((vote) => `${vote.model}→${vote.pick}`).join(", ");
  core.info(
    `${to.code}: ${model(verdict.winner.model)} by ${verdict.decidedBy}` +
      ` (score ${verdict.winner.score.value.toFixed(3)}${votes.length > 0 ? `, ${votes}` : ""})`,
  );

  // A contest only when there was one. One draft that no judge voted on won by
  // being the only candidate, and `Scored 0.91 of 1.00, decided by score` reads
  // like a field of losers was beaten. Leaving it absent lets the block say the
  // one true thing — which model wrote this — and stop.
  const contested = drafted.attempts.length > 1 || verdict.votes.length > 0;

  return {
    text: verdict.winner.text,
    model: model(verdict.winner.model),
    contested,
    score: verdict.winner.score.value,
    drafts: drafted.attempts.length,
    decidedBy: verdict.decidedBy,
    votes: cast,
  };
}

/**
 * A whole language, chunked.
 *
 * `chunks()` never splits a fence, so a chunk that is entirely code — a
 * chunk `isCodeOnly` — is reused verbatim instead of asked for: whatever a
 * model answered would still have to reproduce the code unchanged, so the
 * request is spent on an answer already known. Every other chunk gets its
 * own draft-and-judge pass, one at a time — sequential, not concurrent, so a
 * model this body grounds partway through is already grounded for the chunk
 * after it, the same reason `translateReplies` walks its replies one at a
 * time rather than firing them all at once.
 *
 * **One chunk failing skips the whole language.** A translation missing its
 * middle paragraph because chunk two ran out of models is worse than no
 * translation for this run — the next run tries again in full, rather than
 * this run publishing a body no chunk boundary was ever meant to be visible
 * in.
 */
export async function translateInto(
  to: Language,
  settings: Settings,
  stages: Stages,
  from: Language | null,
  source: string,
  weather: Weather,
  onProtocolExhausted?: ProtocolCheck,
): Promise<Posted | null> {
  const pieces = chunks(source, settings.chunkChars);
  const results: ChunkResult[] = [];

  for (const piece of pieces) {
    if (isCodeOnly(piece)) {
      results.push({
        text: piece,
        model: null,
        contested: false,
        score: 1,
        drafts: 0,
        decidedBy: "score",
        votes: [],
      });
      continue;
    }

    const outcome = await translateChunk(
      to,
      settings,
      stages,
      from,
      piece,
      weather,
      onProtocolExhausted,
    );
    if (outcome === null) return null;
    results.push(outcome);
  }

  // Almost always one entry — a body under `chunk-chars` is one chunk and
  // every chunk of it was won by the same model, which is what makes the
  // common case read exactly as it always has. A body chunked across more
  // than one model reports every one of them rather than picking a winner
  // among winners, and drops the score/decision breakdown: "decided by
  // judges" is a fact about one contest, and a multi-chunk body ran several.
  const models = [...new Set(results.flatMap((r) => (r.model === null ? [] : [r.model])))];
  const single = results.length === 1 ? results[0] : undefined;

  return {
    to,
    text: results.map((r) => r.text).join(""),
    model: models.length > 0 ? models.join(", ") : "—",
    ...(single?.contested
      ? {
          decision: {
            score: single.score,
            drafts: single.drafts,
            decidedBy: single.decidedBy,
            votes: single.votes,
          },
        }
      : {}),
  };
}
