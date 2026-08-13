/**
 * Action entry point: the `action.yml` contract wired to the pipeline.
 *
 * Everything below is orchestration. The pipeline:
 *
 *   1. Read the warrant — or, missing one at the default path, build the
 *      implicit warrant. `languages` comes from whichever of the warrant's
 *      own `languages:` key and the `languages` input answers it.
 *   1a. A written `capabilities:` block that does not name `harmonise` is
 *      checked here, once — the duty does nothing, and the run is green.
 *   2. Discover document groups by scanning for locale suffix files.
 *   3. Read the provenance state file.
 *   4. For each document group with a changed source:
 *      a. Classify the diff (semantic / correction / locale-specific).
 *      b. If semantic changes exist, draft updated translations for stale
 *         locales.
 *      c. Score the drafts deterministically.
 *   5. Open a PR per document group with the updated locale files — unless
 *      the warrant does not grant `edit-file` + `open-pr`, or `apply` is
 *      `none`, in which case every step above still ran and only the write
 *      is withheld.
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

import { narrowWarned, parseApply } from "../../core/enforce.js";
import { isCapacityError, type Location, readContentsFile } from "../../core/forge.js";
import { bounded, readCore, whole, type ApiKeySpec, type EndpointSpec } from "../../core/inputs.js";
import { type Language, parseLanguages } from "../../core/languages.js";
import { createMeter } from "../../core/meter.js";
import {
  assembleClient,
  createWeather,
  parseSeats,
  settleAuth,
  type Names,
  type Provider,
} from "../../core/provider.js";
import { warnIfStarved, writeRunSummary } from "../../core/summary.js";
import {
  dutyLanguages,
  openAuthority,
  type Authority,
  type Capability,
  type Warrant,
} from "../../core/warrant.js";

import { DEFAULT_CAPABILITIES } from "./capabilities.js";
import { classifyDiff, type ClassificationResult } from "./classify.js";
import { discoverGroups, type DocumentGroup } from "./discover.js";
import { draftSync, type Draft, type GlossaryEntry } from "./draft.js";
import { parsePaths } from "./inputs.js";
import {
  findOrCreate,
  markStale,
  markSynced,
  readState,
  writeState,
  type DocumentState,
} from "./provenance.js";
import { publishSync, type PublishApi, type SyncResult } from "./publish.js";
import { scoreDraft } from "./score.js";
import { summarize, type GroupResult } from "./summary.js";

/** This duty's `languages` default (target locales only). */
const DEFAULT_LANGUAGES_INPUT = "vi, zh";
/** This duty's `source-language` default. */
const DEFAULT_SOURCE_LANGUAGE_INPUT = "en";

export interface Settings {
  readonly token: string;
  readonly models: readonly string[];
  readonly modelNames: Names;
  readonly sourceLanguage: Language;
  readonly languages: readonly Language[];
  readonly warrant: string;
  readonly apply: readonly Capability[];
  readonly permitted: readonly Capability[];
  readonly judges: readonly (readonly string[])[];
  readonly judgeNames: Names;
  readonly drafts: number;
  readonly state: string;
  readonly glossary: string;
  readonly paths: readonly string[];
  readonly dryRun: boolean;
  readonly maxRequests: number | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly endpoints: readonly EndpointSpec[];
  readonly apiKeys: readonly ApiKeySpec[];
  readonly requestTimeoutMs: number;
  readonly temperature: number | undefined;
}

function readSettings(): Omit<Settings, "sourceLanguage" | "languages" | "permitted"> {
  const coreInputs = readCore();
  const panel = parseSeats(core.getInput("judge-models"));

  return {
    ...coreInputs,
    warrant: core.getInput("warrant", { required: true }),
    apply: parseApply(core.getInput("apply", { required: true })),
    judges: panel.seats,
    judgeNames: panel.names,
    drafts: whole("drafts", core.getInput("drafts")),
    state: core.getInput("state", { required: true }),
    glossary: core.getInput("glossary", { required: true }),
    paths: parsePaths(core.getInput("paths")),
    maxRequests: bounded("max-requests", core.getInput("max-requests")),
  };
}

/**
 * The outcome of a run this duty was never going to be allowed to act on.
 * Green — enumerating who may act is a maintainer's decision.
 */
function notGranted(warrant: Warrant): string {
  return (
    `\`${warrant.path}\`'s \`capabilities:\` block does not name \`harmonise\`; once that block ` +
    "exists it is the whole answer, so add `harmonise: [edit-file, open-pr]` to it " +
    "(or remove the block to return to defaults)."
  );
}

export async function run(): Promise<void> {
  const meter = createMeter();
  let weather = createWeather();
  let settings: Settings | null = null;
  let authority: Authority | null = null;
  const groupResults: GroupResult[] = [];

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

    // Parse target languages — the locales the documentation is translated into.
    const rawLanguages = core.getInput("languages");
    const languages = dutyLanguages(authority.warrant, denied, rawLanguages);

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
    if (
      !denied &&
      authority.warrant.languages === null &&
      rawLanguages.trim() === DEFAULT_LANGUAGES_INPUT
    ) {
      core.notice(
        "languages: running on the default (`vi, zh`) — nobody has set this yet. " +
          "Write the `languages` input, or `languages:` in the warrant, to choose on purpose.",
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

    const { permitted } = narrowWarned(
      authority.warrant.granted("harmonise", DEFAULT_CAPABILITIES),
      base.apply,
      "harmonise",
      base.warrant,
    );

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

    if (groups.length === 0) {
      core.info("harmonise: no document groups found with locale variants.");
      settleAuth(weather);
      return;
    }

    // Read provenance state
    const { state, sha: stateSha } = await readState(api, context.repo, settings.state);

    // Load glossary
    const glossary = await loadGlossary(api, context.repo, settings.glossary);

    // Process each document group
    for (const group of groups) {
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
      );
      groupResults.push(result);
    }

    // Write updated state
    if (!settings.dryRun) {
      try {
        await writeState(api, context.repo, settings.state, state, stateSha);
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

      core.setOutput(
        "classified",
        JSON.stringify(
          groupResults.filter((r) => r.classification !== "none").map((r) => r.group.id),
        ),
      );
      core.setOutput(
        "synced",
        JSON.stringify(groupResults.filter((r) => r.synced.length > 0).map((r) => r.group.id)),
      );
      core.setOutput(
        "conflicts",
        JSON.stringify(
          groupResults
            .filter((r) => r.conflicts.length > 0)
            .map((r) => ({ group: r.group.id, locales: r.conflicts })),
        ),
      );
      core.setOutput(
        "skipped",
        JSON.stringify(
          groupResults
            .filter(
              (r) =>
                r.classification === "none" ||
                (r.classification !== "semantic" && r.synced.length === 0),
            )
            .map((r) => r.group.id),
        ),
      );
      core.setOutput("starved", String(rosterStarved));
      core.setOutput("budget-exhausted", String(false));

      await writeRunSummary(
        summarize({
          dryRun: settings.dryRun,
          results: groupResults,
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
 * Processes one document group: classify, draft, score.
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

  // Compute the diff: compare current source to what's in provenance
  // On first run (sourceRevision is empty), everything is considered new
  const diffDescription = computeDiff(
    sourceFile.text,
    doc.sourceRevision === "" ? null : doc.sourceRevision,
  );

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

    classification = await classifyDiff(
      diffDescription,
      firstStaleFile?.text ?? "",
      sourceLanguage.code,
      firstStaleLocale,
      classifier,
      primaryModel,
    );
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

  // Draft and score for each stale locale
  const drafts = new Map<string, Draft>();
  for (const locale of doc.stale) {
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

    const glossaryTerms = glossary.map((g) => g.term);

    const draftModel = settings.models[0];
    if (draftModel === undefined) {
      skipped.push(locale);
      continue;
    }

    const draft = await draftSync(
      sourceFile.text,
      targetContent,
      classification.hunks.filter((h) => h.classification === "semantic"),
      sourceLanguage,
      targetLang,
      glossary,
      drafter,
      draftModel,
    );

    if (draft === null) {
      core.warning(`harmonise: no draft produced for ${locale} translation of ${group.id}`);
      skipped.push(locale);
      continue;
    }

    const score = scoreDraft(draft.text, targetContent, glossaryTerms);
    if (score.value === 0 && !score.admissible) {
      core.warning(
        `harmonise: draft for ${locale} translation of ${group.id} refused — ${score.reason ?? "unknown"}`,
      );
      skipped.push(locale);
      continue;
    }

    drafts.set(locale, { ...draft, score: score.value });

    // Mark as synced in provenance
    // The real SHA will come after the write; we'll update later
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
  } else if (drafts.size > 0) {
    // Publish the sync PR
    const syncResult: SyncResult = {
      group,
      drafts,
      conflicts,
    };

    const publishApi = api as unknown as PublishApi;
    const pr = await publishSync(publishApi, at, syncResult, settings.dryRun);

    if (pr !== null) {
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
 * Computes a human-readable diff description from the source content.
 *
 * On first run (no previous revision), describes the entire document as new.
 * On subsequent runs, we compare the current content against what we know
 * from the provenance. Since we don't store the previous content, we use
 * a simplified approach: describe the overall document structure and note
 * that it has changed.
 */
function computeDiff(currentContent: string, previousRevision: string | null): string {
  if (previousRevision === null) {
    return `This is the initial sync. The source document is:\n\n${currentContent}`;
  }

  return `The source document has changed since revision ${previousRevision.slice(0, 8)}. Current content:\n\n${currentContent}`;
}

/**
 * Loads the glossary from `.reeve/glossary.yml`.
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
