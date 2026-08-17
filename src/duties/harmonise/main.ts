/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. The pipeline:
 *
 *   1. Read the warrant — or, missing one at the default path, build the
 *      implicit warrant. `languages` comes from the warrant's own
 *      `languages:` key, or this duty's documented default when the file is
 *      silent.
 *   1a. A written `duties:` block that does not name `harmonise` is
 *      checked here, once — the duty does nothing, and the run is green.
 *   2. Discover document groups by scanning for locale suffix files.
 *   3. Read the provenance state file.
 *   4. For each document group with a changed source:
 *      a. Classify the diff (semantic / correction / locale-specific).
 *      b. If semantic changes exist, draft updated translations for stale
 *         locales — `drafts` times per locale, scored deterministically.
 *      c. Let the judge panel pick between the admitted drafts, or fall
 *         back to the best-scored draft when no panel is configured.
 *   5. Open a PR per document group with the updated locale files — unless
 *      the warrant does not grant `edit-file` + `open-pr`, in which case
 *      every step above still ran and only the write is withheld.
 *
 * **A locale that fails does not fail the run.** Only a broken configuration
 * and a provenance state that cannot be read are `setFailed` — everything
 * else is a warning.
 *
 * **Idempotent.** If no source has changed since the last sync, the run does
 * nothing. No model call, no PR. This is D9.
 *
 * **Human edits are inviolable.** A target locale edited by a human since
 * the last sync is reported as a conflict, never overwritten. This is D3.
 */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { isCapacityError, readBlob, type Location, readContentsFile } from "../../core/forge.js";
import {
  bounded,
  counted,
  readShared,
  whole,
  type ApiKeySpec,
  type EndpointSpec,
} from "../../core/inputs.js";
import { type Language, parseLanguages } from "../../core/languages.js";
import { createMeter, type Meter } from "../../core/meter.js";
import {
  assembleClient,
  createWeather,
  parseSeats,
  settleAuth,
  starved,
  type Names,
  type Provider,
  type Weather,
} from "../../core/provider.js";
import { warnIfStarved, failIfProtocolExhausted, writeRunSummary } from "../../core/summary.js";
import { newAccumulator, remainingOf, reportNoSweep } from "../../core/sweep.js";
import {
  dutyLanguages,
  openAuthority,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";

import { budgetExhausted, createBudget, type Budget } from "./budget.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";
import { classifyDiff, type ClassificationResult } from "./classify.js";
import { computeSourceDiff, formatInitialSync } from "./diff.js";
import { discoverGroups, type DocumentGroup } from "./discover.js";
import { draftSyncs, type Draft, type GlossaryEntry } from "./draft.js";
import { parsePaths } from "./inputs.js";
import { judge as judgePanel, type Verdict } from "./judge.js";
import {
  findOrCreate,
  markStale,
  markSynced,
  readState,
  serialiseState,
  writeState,
  type DocumentState,
} from "./provenance.js";
import { publishSync, type PublishApi, type SyncResult } from "./publish.js";
import { publishState, type StateBranchApi } from "../../core/state-branch.js";
import { summarize, type GroupResult } from "./summary.js";

/** This duty's `languages` default (target locales only), when the warrant is silent. */
const DEFAULT_LANGUAGES: readonly Language[] = parseLanguages("vi, zh");
/** This duty's `source-language` default. */
const DEFAULT_SOURCE_LANGUAGE_INPUT = "en";

export interface Settings {
  readonly token: string;
  readonly models: readonly string[];
  readonly modelNames: Names;
  readonly sourceLanguage: Language;
  readonly languages: readonly Language[];
  readonly warrant: string;
  /** What the file grants — the sole authority, so the run's only `permitted` list. */
  readonly permitted: readonly Capability[];
  readonly judges: readonly (readonly string[])[];
  readonly judgeNames: Names;
  readonly drafts: number;
  readonly provenanceDir: string;
  readonly stateBranch: string;
  readonly glossaryDir: string;
  readonly paths: readonly string[];
  readonly dryRun: boolean;
  readonly maxRequests: number | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly endpoints: readonly EndpointSpec[];
  readonly apiKeys: readonly ApiKeySpec[];
  readonly requestTimeoutMs: number;
  readonly temperature: number | undefined;
  readonly chunkChars: number;
  readonly ignore: boolean;
  readonly sweep: boolean;
  readonly limit: number | null;
}

function readSettings(): Omit<Settings, "sourceLanguage" | "languages" | "permitted"> {
  const shared = readShared({ needsThread: false });
  const panel = parseSeats(core.getInput("judge-models"));

  return {
    ...shared,
    warrant: core.getInput("warrant", { required: true }),
    judges: panel.seats,
    judgeNames: panel.names,
    drafts: whole("drafts", core.getInput("drafts")),
    provenanceDir: core.getInput("provenance-dir", { required: true }),
    stateBranch: core.getInput("state-branch"),
    glossaryDir: core.getInput("glossary-dir", { required: true }),
    paths: parsePaths(core.getInput("paths")),
    maxRequests: bounded("max-requests", core.getInput("max-requests")),
    chunkChars: counted("chunk-chars", core.getInput("chunk-chars")),
    ignore: core.getInput("ignore") !== "false",
  };
}

/**
 * The outcome of a run this duty was never going to be allowed to act on.
 * Green — enumerating who may act is a maintainer's decision.
 */
function notGranted(warrant: Warrant): string {
  return (
    `\`${warrant.path}\`'s \`duties:\` block does not name \`harmonise\`; once that block ` +
    "exists it is the whole answer, so add `harmonise: [edit-file, open-pr]` to it " +
    "(or remove the block to return to defaults)."
  );
}

export async function run(): Promise<void> {
  const meter = createMeter();
  // `denied` is set exactly once, by `budgetExhausted` — see `createBudget`'s
  // doc comment in `budget.ts` for why one mutable object rather than a
  // recomputed boolean.
  const budget = createBudget();
  let weather = createWeather();
  let settings: Settings | null = null;
  let authority: Authority | null = null;
  const acc = newAccumulator<GroupResult>();
  let statePr: number | null = null;

  try {
    const base = readSettings();
    const client = assembleClient(base, meter, ["classify", "draft", "judge"] as const, [
      base.judges.flat(),
    ]);
    weather = client.weather;
    const api = getOctokit(base.token);

    const opened = await openAuthority(base.warrant, api, context.repo, "harmonise");
    authority = opened.authority;
    const denied = opened.denied;

    // Parse source language — the language unsuffixed documentation files are
    // written in. This is a deliberate organisational decision, not an
    // incidental preference.
    const rawSourceLanguage = core.getInput("source-language");
    const sourceLanguage = parseSourceLanguage(
      rawSourceLanguage,
      authority.warrant.languages,
      denied,
    );

    // Parse target languages — the locales the documentation is translated
    // into, from the warrant's `languages:` key or this duty's own default.
    const languages = dutyLanguages(authority.warrant, denied, DEFAULT_LANGUAGES);

    // Validate: source language must not appear in target languages
    if (sourceLanguage !== null && languages.length > 0) {
      const duplicate = languages.find(
        (l) => l.code.toLowerCase() === sourceLanguage.code.toLowerCase(),
      );
      if (duplicate !== undefined) {
        core.warning(
          `harmonise: source language \`${sourceLanguage.code}\` also appears in \`languages\` — ` +
            "the source language must not be a target. Removing it from targets.",
        );
      }
    }
    const targetLanguages = languages.filter(
      (l) => sourceLanguage?.code.toLowerCase() !== l.code.toLowerCase(),
    );

    // Notice when running on the default language config
    if (!denied && authority.warrant.languages === null) {
      core.notice(
        "languages: running on the default (`vi, zh`) — nobody has set this yet. " +
          "Write `languages:` in the warrant to choose on purpose.",
      );
    }

    if (
      !denied &&
      rawSourceLanguage.trim() === DEFAULT_SOURCE_LANGUAGE_INPUT &&
      authority.warrant.languages === null
    ) {
      core.notice(
        "source-language: running on the default (`en`) — nobody has set this yet. " +
          "Write the `source-language` input to choose on purpose.",
      );
    }

    const permitted = authority.warrant.granted("harmonise", DEFAULT_CAPABILITIES);

    const fallbackSource = parseLanguages("en")[0];
    if (fallbackSource === undefined) {
      throw new Error("source-language: could not parse default 'en'.");
    }
    settings = {
      ...base,
      sourceLanguage: sourceLanguage ?? fallbackSource,
      languages: targetLanguages,
      permitted,
    };

    // If the warrant doesn't name harmonise, stop here
    if (authority.warrant.unnamed("harmonise")) {
      core.notice(notGranted(authority.warrant));
      settleAuth(weather);
      return;
    }

    if (sourceLanguage === null) {
      core.setFailed(
        "harmonise: source language could not be resolved — this is a configuration error.",
      );
      settleAuth(weather);
      return;
    }

    if (targetLanguages.length === 0) {
      core.notice("harmonise: no target languages configured — nothing to synchronise.");
      settleAuth(weather);
      return;
    }

    // Discover document groups
    const allFiles = await listMarkdownFiles(api, context.repo);
    const groups = discoverGroups(allFiles, sourceLanguage, targetLanguages, settings.paths);
    acc.candidates = groups.length;

    if (groups.length === 0) {
      core.info("harmonise: no document groups found with locale variants.");
      settleAuth(weather);
      return;
    }

    // Read provenance state
    const provenancePath = `${settings.provenanceDir}/state.json`;
    const { state, sha: stateSha } = await readState(
      api,
      context.repo,
      provenancePath,
      settings.stateBranch !== "" ? settings.stateBranch : undefined,
    );

    // Load glossary
    const glossary = await loadGlossary(api, context.repo, settings.glossaryDir);

    // Process each document group
    for (const group of groups) {
      // Starvation check: every model in the roster has failed on capacity.
      // Stop before spending requests that cannot succeed.
      if (starved(settings.models, weather)) {
        acc.starvedRun = true;
        core.warning(
          "harmonise: the roster ran out of capacity — remaining document groups were not attempted. " +
            "What was already drafted still publishes.",
        );
        break;
      }

      // Limit check: a sweep cap stops the walk before the next group.
      if (settings.limit !== null && acc.results.length >= settings.limit) {
        core.info(
          `harmonise: sweep limit (${String(settings.limit)}) reached — ` +
            "remaining document groups were not attempted this run.",
        );
        break;
      }

      // Budget check: checked before spending the requests a group is about to
      // cost — so a budget already at its ceiling does not start a group it
      // cannot finish.
      if (budgetExhausted(settings, meter, budget)) {
        core.warning(
          "`max-requests` was reached, so remaining document groups were not attempted this run. " +
            "What was already drafted still publishes.",
        );
        break;
      }

      const result = await processGroup(
        group,
        state,
        targetLanguages,
        sourceLanguage,
        glossary,
        api,
        context.repo,
        settings,
        client.stages.classify,
        client.stages.draft,
        client.stages.judge,
        meter,
        budget,
        weather,
      );
      acc.results.push(result);
    }

    // Write updated state
    if (!settings.dryRun) {
      try {
        if (settings.stateBranch !== "") {
          // Branch-write path: write state file to the state branch via publishState
          const canWriteBranch =
            settings.permitted.includes("edit-file") && settings.permitted.includes("open-pr");

          if (!canWriteBranch) {
            core.notice(
              "harmonise: `state-branch` is set but `edit-file` and `open-pr` are not both granted. " +
                "Provenance state will not be written to the branch.",
            );
          } else {
            const stateContent = serialiseState(state);
            const stateFiles = [
              {
                path: provenancePath,
                content: stateContent,
                message: "harmonise: update provenance state",
              },
            ];

            const stateBranchApi = api as unknown as StateBranchApi;
            const result = await publishState(
              stateBranchApi,
              context.repo,
              settings.stateBranch,
              stateFiles,
              "harmonise: provenance state",
              "## harmonise provenance state\n\nUpdated provenance state file.",
              false,
            );

            if (result !== null) {
              statePr = result.pr;
              core.info(
                `harmonise: state written to \`${settings.stateBranch}\`, PR #${String(result.pr)}`,
              );
            }
          }
        } else {
          // Default-branch write path: write state directly
          const canWriteDefault = settings.permitted.includes("edit-file");

          if (!canWriteDefault) {
            core.notice(
              "harmonise: provenance state cannot be written to the default branch " +
                "because `edit-file` is not granted. State may become stale.",
            );
          } else {
            await writeState(api, context.repo, provenancePath, state, stateSha);
          }
        }
      } catch (error) {
        if (isCapacityError(error)) {
          core.warning(
            "harmonise: could not write provenance state — capacity error. State may be stale.",
          );
        } else {
          throw error;
        }
      }
    }

    settleAuth(weather);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (settings !== null && authority !== null) {
      const rosterStarved = warnIfStarved(settings.models, weather, false);

      // `budget.denied` answers this the same way as `translate` — see
      // `createBudget`'s doc comment in `budget.ts`.
      const budgetSpent = budget.denied;
      if (budgetSpent) {
        core.warning(
          "`max-requests` was reached this run. What was already drafted still publishes; " +
            "anything past the budget was left for a later run.",
        );
      }

      core.setOutput(
        "classified",
        JSON.stringify(
          acc.results.filter((r) => r.classification !== "none").map((r) => r.group.id),
        ),
      );
      core.setOutput(
        "synced",
        JSON.stringify(acc.results.filter((r) => r.synced.length > 0).map((r) => r.group.id)),
      );
      core.setOutput(
        "conflicts",
        JSON.stringify(
          acc.results
            .filter((r) => r.conflicts.length > 0)
            .map((r) => ({ group: r.group.id, locales: r.conflicts })),
        ),
      );
      core.setOutput(
        "skipped",
        JSON.stringify(
          acc.results
            .filter(
              (r) =>
                r.classification === "none" ||
                (r.classification !== "semantic" && r.synced.length === 0),
            )
            .map((r) => r.group.id),
        ),
      );
      core.setOutput("starved", String(rosterStarved));
      core.setOutput("budget-exhausted", String(budgetSpent));
      core.setOutput("state-pr", statePr !== null ? String(statePr) : "");

      // Sweep outputs: `processed` and `remaining` answer the question "how
      // much of the backlog did this run reach?" — honestly at zero when
      // `sweep` is off, and from the accumulator when it is on.
      if (settings.sweep) {
        core.setOutput("processed", String(acc.results.length));
        core.setOutput("remaining", String(remainingOf(acc)));
      } else {
        reportNoSweep();
      }

      await writeRunSummary(
        summarize({
          dryRun: settings.dryRun,
          results: acc.results,
          warrant: settings.warrant,
          implicit: authority.implicit,
          ungranted: authority.warrant.unnamed("harmonise") ? notGranted(authority.warrant) : null,
          spent: meter.spent(),
          modelNames: settings.modelNames,
        }),
        weather,
      );
    }
  }
}

/**
 * Processes one document group: classify, draft, score, judge.
 */
async function processGroup(
  group: DocumentGroup,
  state: DocumentState[],
  targetLanguages: readonly Language[],
  sourceLanguage: Language,
  glossary: readonly GlossaryEntry[],
  api: ReturnType<typeof getOctokit>,
  at: Pick<Location, "owner" | "repo">,
  settings: Settings,
  classifier: Provider,
  drafter: Provider,
  judger: Provider,
  meter: Meter,
  budget: Budget,
  weather: Weather,
): Promise<GroupResult> {
  const sourcePath = group.files.get(sourceLanguage.code.toLowerCase());
  if (sourcePath === undefined) {
    return { group, classification: "none", hunks: [], synced: [], conflicts: [], skipped: [] };
  }

  // Read source and target files
  const sourceFile = await readContentsFile(api, at, sourcePath);
  if (sourceFile === null) {
    core.warning(`harmonise: source file \`${sourcePath}\` not found — skipping ${group.id}`);
    return { group, classification: "none", hunks: [], synced: [], conflicts: [], skipped: [] };
  }

  // Find or create provenance entry
  const doc = findOrCreate(state, group.id, group.files);

  // Read target file SHAs
  const targetShas = new Map<string, string>();
  for (const [locale, path] of group.files) {
    if (locale === sourceLanguage.code.toLowerCase()) continue;
    const targetFile = await readContentsFile(api, at, path);
    if (targetFile !== null) targetShas.set(locale, targetFile.sha);
  }

  // Mark stale/conflicting locales
  markStale(doc, sourceFile.sha, targetShas, sourceLanguage.code.toLowerCase());

  if (doc.stale.length === 0 && doc.conflicts.length === 0) {
    return { group, classification: "none", hunks: [], synced: [], conflicts: [], skipped: [] };
  }

  const conflicts = [...doc.conflicts];
  const synced: string[] = [];
  const skipped: string[] = [];

  // Compute the diff: resolve the historical source content from the
  // stored sourceRevision blob SHA, then diff it against the current content.
  // On first run (sourceRevision is empty), everything is considered new.
  let diffDescription: string;
  if (doc.sourceRevision === "") {
    diffDescription = formatInitialSync(sourceFile.text);
  } else {
    const previousContent = await readBlob(api, at, doc.sourceRevision);
    if (previousContent === null) {
      core.warning(
        `harmonise: cannot resolve source revision ${doc.sourceRevision.slice(0, 8)} ` +
          `for ${group.id} — skipping. The blob SHA may no longer be reachable.`,
      );
      return {
        group,
        classification: "none",
        hunks: [],
        synced: [],
        conflicts,
        skipped: doc.stale,
      };
    }
    diffDescription = computeSourceDiff(previousContent, sourceFile.text);
  }

  // Classify the diff
  let classification: ClassificationResult;
  if (doc.stale.length > 0) {
    // We need the first stale locale's content for classification context
    const firstStaleLocale = doc.stale[0];
    if (firstStaleLocale === undefined) {
      return { group, classification: "none", hunks: [], synced: [], conflicts, skipped: [] };
    }
    const firstStalePath = group.files.get(firstStaleLocale);
    const firstStaleFile =
      firstStalePath !== undefined ? await readContentsFile(api, at, firstStalePath) : null;

    const primaryModel = settings.models[0];
    if (primaryModel === undefined) {
      return { group, classification: "none", hunks: [], synced: [], conflicts, skipped: [] };
    }

    // A classification failure is a run that cannot decide what to propagate.
    // The doctrine says "a locale that fails does not fail the run" — skip the
    // group and continue, rather than crashing the whole document group.
    try {
      classification = await classifyDiff(
        diffDescription,
        firstStaleFile?.text ?? "",
        sourceLanguage.code,
        firstStaleLocale,
        classifier,
        primaryModel,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`harmonise: classification failed for ${group.id} — ${message}`);
      return {
        group,
        classification: "none",
        hunks: [],
        synced: [],
        conflicts,
        skipped: doc.stale,
      };
    }
  } else {
    classification = { hunks: [], hasSemantic: false };
  }

  if (!classification.hasSemantic) {
    // No semantic changes — nothing to propagate
    const firstHunk = classification.hunks[0];
    return {
      group,
      classification: firstHunk !== undefined ? firstHunk.classification : "none",
      hunks: classification.hunks,
      synced: [],
      conflicts,
      skipped: doc.stale,
    };
  }

  // Draft and judge for each stale locale
  const bestDrafts = new Map<string, Draft>();
  for (const locale of doc.stale) {
    // Checked before spending the requests a locale is about to cost, not
    // after — so a budget set tight enough to stop mid-group stops before
    // the request that would have gone over it.
    if (budgetExhausted(settings, meter, budget)) {
      const remaining = doc.stale.slice(doc.stale.indexOf(locale));
      skipped.push(...remaining);
      core.warning(
        `harmonise: \`max-requests\` was reached, so ${remaining.map((l) => l).join(", ")} ` +
          `${remaining.length === 1 ? "was" : "were"} not attempted this run. ` +
          "What was already drafted still publishes.",
      );
      break;
    }

    const targetLang = targetLanguages.find((l) => l.code.toLowerCase() === locale);
    if (targetLang === undefined) {
      skipped.push(locale);
      continue;
    }

    const targetPath = group.files.get(locale);
    if (targetPath === undefined) {
      skipped.push(locale);
      continue;
    }

    const targetFile = await readContentsFile(api, at, targetPath);
    const targetContent = targetFile?.text ?? "";

    // Run the multi-draft loop
    const result = await draftSyncs({
      provider: drafter,
      models: settings.models,
      sourceContent: sourceFile.text,
      targetContent,
      semanticHunks: classification.hunks.filter((h) => h.classification === "semantic"),
      sourceLanguage,
      targetLanguage: targetLang,
      languages: settings.languages,
      glossary,
      drafts: settings.drafts,
      weather,
      chunkChars: settings.chunkChars,
      ignore: settings.ignore,
    });

    for (const failure of result.failures) {
      core.warning(
        `harmonise: ${targetLang.code}: model ${failure.model} failed — ${failure.reason}`,
      );
    }

    if (result.attempts.length === 0) {
      failIfProtocolExhausted(settings.models, result.failures);
      core.warning(
        `harmonise: no admissible draft produced for ${locale} translation of ${group.id}`,
      );
      skipped.push(locale);
      continue;
    }

    // Let the judge panel pick between the admitted drafts — or fall back
    // to the best-scored draft when no panel is configured (or only one
    // attempt was admitted).
    const winner = await pickWinner(
      result.attempts,
      targetContent,
      targetLang,
      settings.judges,
      judger,
      weather,
    );

    if (winner === null) {
      core.warning(`harmonise: no winner for ${locale} translation of ${group.id}`);
      skipped.push(locale);
      continue;
    }

    bestDrafts.set(locale, winner);

    // Marked as pending in provenance — the real SHA comes from the write's
    // response, applied once `publishSync` returns below. Recording "pending"
    // now keeps the state honest if the run dies before the write.
    markSynced(doc, locale, "pending");
    synced.push(locale);
  }

  // Check if we have permission to publish
  const canPublish =
    settings.permitted.includes("edit-file") && settings.permitted.includes("open-pr");

  if (!canPublish) {
    core.info(
      `harmonise: ${synced.length > 0 ? `${String(synced.length)} locale(s) would be synced` : "no locales to sync"} for ${group.id}, ` +
        "but `edit-file` and `open-pr` are not both granted. Nothing written.",
    );
  } else if (bestDrafts.size > 0) {
    // Publish the sync PR
    const syncResult: SyncResult = {
      group,
      drafts: bestDrafts,
      conflicts,
    };

    const publishApi = api as unknown as PublishApi;
    const pr = await publishSync(publishApi, at, syncResult, settings.dryRun);

    if (pr !== null) {
      // Record the real SHA each locale file now has, replacing the "pending"
      // placeholder set above. A locale whose SHA the write did not answer
      // stays "pending" — the honest reading of "synced, but to what is not
      // known", which the next source change treats as stale rather than as a
      // false conflict.
      for (const [locale, sha] of pr.shas) {
        markSynced(doc, locale, sha);
      }
      core.info(`harmonise: opened PR #${String(pr.pr)} for ${group.id}`);
    }
  }

  return {
    group,
    classification: "semantic",
    hunks: classification.hunks,
    synced,
    conflicts,
    skipped,
  };
}

/**
 * Picks the winning draft from the admitted attempts.
 *
 * When a judge panel is configured and more than one attempt was admitted,
 * the panel votes and the verdict decides. Otherwise the best-scored draft
 * wins — the same fallback `translate` uses.
 */
async function pickWinner(
  attempts: readonly Draft[],
  targetContent: string,
  targetLanguage: Language,
  judges: readonly (readonly string[])[],
  judger: Provider,
  weather: Weather,
): Promise<Draft | null> {
  // One candidate is already the answer, and none means the work was skipped
  // before this. Asking which of one is best spends a request on a foregone
  // conclusion.
  if (attempts.length === 0) return null;
  if (attempts.length === 1 || judges.length === 0) {
    // Best score first — the draft loop already sorted them.
    return attempts[0] ?? null;
  }

  const verdict: Verdict<Draft> = await judgePanel({
    provider: judger,
    judges,
    targetContent,
    to: targetLanguage,
    attempts,
    weather,
  });

  return verdict.winner;
}

/**
 * Lists all Markdown files in the repository.
 *
 * Uses `git ls-tree` via the Contents API to walk the tree.
 * For now, a simplified approach that reads the tree at the default branch.
 */
async function listMarkdownFiles(
  api: ReturnType<typeof getOctokit>,
  at: Pick<Location, "owner" | "repo">,
): Promise<string[]> {
  const files: string[] = [];

  // Walk the repository tree to find .md files
  // This uses the Git data API to get the tree recursively
  try {
    const { data: ref } = await api.rest.git.getRef({
      owner: at.owner,
      repo: at.repo,
      ref: context.ref.replace(/^refs\//, ""),
    });

    const { data: tree } = await api.rest.git.getTree({
      owner: at.owner,
      repo: at.repo,
      tree_sha: ref.object.sha,
      recursive: "true",
    });

    for (const entry of tree.tree) {
      if (entry.path.endsWith(".md") && entry.type === "blob") {
        files.push(entry.path);
      }
    }
  } catch (error) {
    if (isCapacityError(error)) {
      core.warning("harmonise: could not list repository files — capacity error.");
    } else {
      throw error;
    }
  }

  return files;
}

/**
 * Loads the glossary from the `glossary-dir` input.
 *
 * Returns empty when the file does not exist — a missing glossary is not an
 * error, it just means there are no project-specific terms to protect.
 */
async function loadGlossary(
  api: ReturnType<typeof getOctokit>,
  at: Pick<Location, "owner" | "repo">,
  path: string,
): Promise<readonly GlossaryEntry[]> {
  const file = await readContentsFile(api, at, path);
  if (file === null) return [];

  try {
    const { parse } = await import("yaml");
    const parsed: unknown = parse(file.text);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];

    const record = parsed as Record<string, unknown>;
    const entries: GlossaryEntry[] = [];
    for (const [term, value] of Object.entries(record)) {
      if (typeof term === "string" && term.length > 0) {
        entries.push(typeof value === "string" ? { term, note: value } : { term });
      }
    }

    return entries;
  } catch {
    core.warning(
      `harmonise: glossary file \`${path}\` could not be parsed — continuing without glossary.`,
    );
    return [];
  }
}

/**
 * Parses the single `source-language` input.
 *
 * The source language is deliberately separate from `languages`: committed
 * documentation has a known organisational source language, while PR and issue
 * authors may write in any language. Exactly one source language is required.
 */
function parseSourceLanguage(
  raw: string,
  warrantLanguages: readonly Language[] | null,
  denied: boolean,
): Language | null {
  if (denied) return null;

  const parsed = parseLanguages(raw);
  if (parsed.length !== 1) {
    throw new Error(
      "source-language: expected exactly one language code. Target locales belong in `languages`.",
    );
  }

  const source = parsed[0];
  if (source === undefined) {
    throw new Error("source-language: no language configured.");
  }

  // `warrantLanguages` is accepted to make the separate authority boundary
  // explicit: the warrant may choose targets, but the workflow chooses source.
  void warrantLanguages;
  return source;
}

await run();
