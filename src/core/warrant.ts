/**
 * The authority, read from the repository it applies to.
 *
 * A reeve acted for the owner under an authority the owner had granted and
 * could withdraw. `.github/reeve.yml` is that authority, and this module is the
 * only thing that turns it from bytes into something the rest of Reeve is
 * allowed to consult.
 *
 * **This is the allowlist, and it is the whole reason injected text cannot
 * invent a permission.** Every guardrail downstream is phrased against the
 * parsed file — is this name in it, is this capability in it — rather than
 * against anything a model returned about what it believed it was allowed to
 * do. Text can persuade a model. It cannot edit a file it is not in.
 *
 * **A warrant that does not parse is a failed run, not a run with no
 * allowlist.** Everything after this point is defined in terms of this file, so
 * the fail-safe direction is stop. It is the one place Reeve fails red over
 * configuration instead of warning and carrying on, and the reason is that the
 * alternative reading — "no file, therefore no restrictions" — is the reading
 * that ends with a model's verdict applied unfiltered.
 *
 * **Refused rather than dropped, everywhere.** A misspelled capability that
 * silently granted nothing is a bug a maintainer finds as an absence months
 * later; a misspelled label that silently granted everything is the last bug
 * this action ships. Both are errors here, named, with the offending text
 * quoted back.
 *
 * **Absence at the default path is not the same failure.** A warrant that
 * does not parse said something and got it wrong — a version it invented, a
 * label with no description, a value nothing in this format can hold — and
 * that is a failure to be corrected, not read around. A file that is not
 * there said nothing at all: it cannot have been misread, because it was
 * never read. Deleting `.github/reeve.yml` is the supported way to withdraw
 * every permission the file had granted, and if that withdrawal read as "no
 * restrictions" it would make deletion the widest setting this action has —
 * the opposite of what withdrawing an authority should do. So an absent file
 * at the path nobody moved it from runs at the narrowest authority this
 * build knows, which is not the claim "no restrictions" at all: it is the
 * opposite one, the most restrictions, arrived at automatically rather than
 * written by a maintainer. A path a consumer did choose, and pointed at
 * nothing, is a different fact — they named a file that is not there, which
 * is a configuration mistake rather than an absence — and it fails exactly as
 * a warrant that does not parse does.
 */
import { readFile } from "node:fs/promises";

import * as core from "@actions/core";
import { parse, YAMLParseError } from "yaml";

import type { Location, TrackerApi } from "./forge.js";
import { listRepositoryLabels } from "./forge.js";
import { findLanguage, parseLanguages, type Language } from "./languages.js";
import type {
  DependaPolicy,
  Ecosystem,
  IgnoreRule,
  ScheduleConfig,
  UpdateType,
} from "../duties/dependa/model.js";
import { ECOSYSTEMS, UPDATE_TYPES } from "../duties/dependa/model.js";
import { DUTIES, PLANNED } from "../refusal.js";

/**
 * What a duty may do to a thread or a repository. The closed set; a name
 * outside it is refused.
 *
 * `record` is unlike the rest of this set. Every other capability changes the
 * thread a run is deciding about; `record` changes a file in the repository
 * instead — a commit to the corrections store — and that needs `contents:
 * write` on the token rather than `issues: write`. It has no duty default and
 * cannot be implied by an implicit warrant: writing to the store is a
 * project's decision to keep a memory at all, and only an explicit
 * `capabilities:` block can make it.
 *
 * `edit-file` and `open-pr` are qualitatively different again. They give a
 * duty the ability to write repository files and open pull requests — changes
 * that land in the commit history, not in a thread body. No duty defaults
 * these: a maintainer who wants `harmonise` to open sync PRs writes the
 * capabilities explicitly, because committing files is too much authority to
 * hand out at level 0.
 */
export type Capability =
  | "label"
  | "edit-body"
  | "comment"
  | "close"
  | "assign"
  | "record"
  | "propose"
  | "edit-file"
  | "open-pr";

export const CAPABILITIES: readonly Capability[] = [
  "label",
  "edit-body",
  "comment",
  "close",
  "assign",
  "record",
  "propose",
  "edit-file",
  "open-pr",
];

/** The only version this reader understands. */
const VERSION = 1;

/** The `memory:` block's shape — see {@link Warrant.memory}. */
export interface MemorySettings {
  readonly recall: number;
}

/** What resets a track's clock. `author` is the only sensible reading for a `when:` track. */
export type LifecycleResets = "author" | "any";

/** A step's `say:` — a step with no `say:` posts no comment at all. */
export type LifecycleSay =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "built-in" }
  | { readonly kind: "map"; readonly map: ReadonlyMap<string, string> };

/** One step in a track's escalation ladder. */
export interface LifecycleStep {
  /** Milliseconds from the previous step's delivery (or from clock start, for step 1). */
  readonly after: number;
  readonly label: string | null;
  readonly say: LifecycleSay | null;
  /** `true` only on the closing step of a track; always `not_planned`. */
  readonly close: boolean;
}

/** A per-label timing exception, mirroring the taxonomy's per-label confidence. */
export interface LifecycleOverride {
  readonly label: string;
  /** Milliseconds replacing the first step's `after`, or `null` when `never` won. */
  readonly after: number | null;
  readonly never: boolean;
}

/** One user-defined lifecycle track. */
export interface LifecycleTrack {
  readonly name: string;
  /** The label whose human application starts the clock, or `null` for an inactivity track. */
  readonly when: string | null;
  readonly resets: LifecycleResets;
  readonly steps: readonly LifecycleStep[];
}

/** The four layers of `lifecycle.exempt` — see the design's §1.5/§1.1. */
export interface LifecycleExempt {
  readonly labels: readonly string[];
  /** `true` = any milestone/assignee protects (default); a list scopes it; `false` disables it. */
  readonly milestones: boolean | readonly string[];
  readonly assignees: boolean | readonly string[];
  readonly taxonomy: boolean;
  /** `null` = unset = off; a whole number ≥1 blocks `close` steps only. */
  readonly comments: number | null;
  /** Whether a draft pull request is exempt from every track, when `threads:` includes PRs at all. Defaults `true`. */
  readonly drafts: boolean;
}

/** The `lifecycle:` key, in full — `null` when the file never wrote one at all. */
export interface LifecyclePolicy {
  readonly tracks: readonly LifecycleTrack[];
  readonly exempt: LifecycleExempt;
  readonly overrides: readonly LifecycleOverride[];
  readonly threads: "issues" | "prs" | "both";
}

/** The `propose.workspace:` strategy's own knobs — see the design's §3.2. */
export interface ProposeWorkspace {
  /** Exactly one `{package}` placeholder, refused otherwise. */
  readonly name: string;
  readonly except: readonly string[];
  readonly evidence: number;
  readonly window: number;
  readonly retire: boolean;
}

/** Defaults `readPropose` returns when `propose:` was never written. */
export const DEFAULT_PROPOSE_WORKSPACE: ProposeWorkspace = {
  name: "area:{package}",
  except: [],
  evidence: 3,
  window: 90 * 24 * 60 * 60 * 1000,
  retire: false,
};

/**
 * A handle, syntactically.
 *
 * Whether `@ecoma-io/runtime` can actually be assigned is decided by the API at
 * apply time and is a warning rather than a failed run — a team can be renamed
 * without the taxonomy being wrong about what it meant. What is checked here is
 * only that the value is shaped like a handle at all, because `owner: runtime`
 * with no `@` is a mistake nothing downstream can distinguish from a deliberate
 * one.
 */
const HANDLE = /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;

/** One entry in the taxonomy, as written. */
export interface Label {
  /** Matched against the repository's own labels exactly, including case. */
  readonly name: string;
  /** When this label applies, in the author's own words and language. */
  readonly description: string;
  /** When it does not. Absent is allowed and is where most accuracy is lost. */
  readonly not: string | null;
  /** Real titles from this repository. Empty when none were given. */
  readonly examples: readonly string[];
  /** Assigned when this label is applied and the duty may assign. */
  readonly owner: string | null;
  /** Labels that may not be applied alongside this one. Enforced in code. */
  readonly exclusiveWith: readonly string[];
  /**
   * This label's own confidence floor, between 0 and 1, or `null` to fall
   * back to the run's `confidence` input.
   *
   * Some labels are cheap to get wrong and some are not — a `needs
   * reproduction` mislabelled costs a re-read, a `security` mislabelled costs
   * a false alarm a maintainer has to notice is one. This is what lets a
   * taxonomy say that in the file, per label, rather than every label sharing
   * one run-wide number tuned to the riskiest one.
   */
  readonly confidence: number | null;
  /**
   * Path prefixes or package names (from `atlas`) this label answers to.
   * Evidence for the deterministic matcher and for `propose`'s drift check —
   * never authority. An entry naming a path atlas cannot find is a warning,
   * not red: packages move, and a label is not wrong for outliving one.
   */
  readonly paths: readonly string[];
  /**
   * Written by a human (directly, or by merging a `propose` PR) to let
   * `checkLabelsExist` create the repository label object instead of failing
   * red when it is missing. The merge is the grant — this key never creates
   * anything on its own; it is only ever consulted after the file that
   * carries it has already been read as authority.
   */
  readonly create: boolean;
  /** The hex color (no `#`) used only when `create` fires. `null` lets GitHub pick. */
  readonly color: string | null;
}

/** The parsed file, and the questions the rest of Reeve is allowed to ask it. */
export interface Warrant {
  /** Where it was read from, so every message about it can name the file. */
  readonly path: string;
  /** The taxonomy, in the order it was written. That order reaches the prompt. */
  readonly labels: readonly Label[];
  /**
   * The `languages:` key, or `null` when the file never answered the question
   * at all.
   *
   * `null` is deliberately not the same thing as an empty list — an empty
   * `languages:` is refused by `parseLanguages` the same way an empty
   * `languages` input already is, because a maintainer who wrote the key at
   * all meant something by it. `null` is what lets `resolveLanguages` below
   * tell "this file is silent" from "this file already answered", before it
   * has any reason to look at the `languages` input.
   */
  readonly languages: readonly Language[] | null;
  /**
   * The `pivot:` key: the language corrections are bridged through for
   * cross-language recall, as written — not yet resolved against the final
   * `languages` list, which is `resolvePivot`'s job once that list exists.
   * `null` when the file never named one, which leaves the first-listed
   * language the pivot, exactly as before this key existed.
   */
  readonly pivot: string | null;
  /**
   * The `memory:` key's `recall` field: how many corrections a duty puts in
   * front of a model, or `null` when the file never wrote the block — the
   * duty's own default applies then, same as before this key existed. `0` is
   * meaningful here rather than refused: a project that wants the store kept
   * but never consulted writes it.
   */
  readonly memory: MemorySettings | null;
  /**
   * The `about:` key: what this repository is about, in the maintainer's own
   * words, or `null` when the file never wrote one — `resolveAbout` falls
   * back to the `about` input then, the same input every duty already reads.
   */
  readonly about: string | null;
  /**
   * The `lifecycle:` key, or `null` when the file never wrote one — the
   * lifecycle duty's own no-implicit-policy floor. There is no fallback
   * here the way `memory`/`about` have one: no pre-existing artifact states
   * a staleness policy, so an absent key means the duty decides nothing,
   * ever, not "decides the duty's own default."
   */
  readonly lifecycle: LifecyclePolicy | null;
  /**
   * The `propose.workspace:` strategy, always present — defaults fill in
   * when the file never wrote `propose:` at all, because the numbers in
   * {@link DEFAULT_PROPOSE_WORKSPACE} are the design's own ruled defaults,
   * not a duty's private opinion the way `memory`'s are.
   */
  readonly propose: ProposeWorkspace;
  /**
   * The `dependa:` key, or `null` when the file never wrote one — the
   * dependa duty's own no-implicit-policy floor, the same pattern
   * `lifecycle` follows. When absent, dependa runs with its own
   * conservative defaults. Written with nothing under it is refused,
   * the same half-finished-edit shape `lifecycle:`/`capabilities:` refuse.
   */
  readonly dependa: DependaPolicy | null;
  /**
   * What this duty was granted.
   *
   * Three shapes, not two. No `capabilities:` block at all means the file
   * never turned its mind to the question, so the duty keeps `fallback` — its
   * own idea of the least it should be trusted with, which is what a consumer
   * who has only written a taxonomy expects, unchanged from before this block
   * existed. A block that exists and does name `duty` means exactly what it
   * lists, including the empty list `[none]` spells deliberately. A block
   * that exists and does *not* name `duty` is the shape new here: once a
   * maintainer has written the block, it is taken as the complete roster of
   * who may act, so a name missing from it is refused everything rather than
   * handed the default it would have had before the block was written —
   * enumerating who may act is a decision, and a duty the enumeration forgot
   * is not the same thing as a duty nobody had decided about. See `unnamed`,
   * which is how a caller tells that shape apart from an explicit `[none]`
   * before either reaches this method.
   *
   * The default belongs to the duty rather than to this module: only `triage`
   * knows that its cheapest reversible action is a label.
   */
  granted(duty: string, fallback: readonly Capability[]): readonly Capability[];
  /**
   * True when the file wrote a `capabilities:` block and that block does not
   * mention `duty` by name.
   *
   * Distinct from an absent block, which leaves the duty its own default, and
   * distinct from the duty being named `[none]`, which is a decision about it
   * rather than silence about it — `granted` alone cannot tell those two
   * "nothing" apart, because both return the same empty list. This is the
   * call that can, and it exists so a duty can stop before spending an
   * expensive model call on a verdict that could never be applied: once the
   * block exists and does not name it, no verdict changes the answer.
   */
  unnamed(duty: string): boolean;
  /** The entry for a name, or undefined. Case-sensitive, as GitHub applies them. */
  labelNamed(name: string): Label | undefined;
}

/**
 * Where `readWarrant` is told the action's own default lives, so it can tell
 * a consumer's silence from a consumer's choice.
 *
 * This module does not know `.github/reeve.yml` on its own — `action.yml`
 * owns that default, and the duty's `main.ts` is what reads it — so the
 * comparison has to be handed in rather than hard-coded here. `readWarrant`
 * only ever needs to know whether `path` is *the* default, not what the
 * default is for its own sake.
 */
export interface ReadOptions {
  readonly defaultPath: string;
}

/**
 * The file, parsed — or `null` when it was absent at the path nobody chose to
 * move it from, which is not a failure. See the top of this module for why
 * that one case reads differently from every other read failure.
 */
export async function readWarrant(path: string, options: ReadOptions): Promise<Warrant | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (path === options.defaultPath && isNotFound(error)) return null;

    const reason = error instanceof Error ? error.message : String(error);
    // Named as a missing authority rather than as a missing file, because that
    // is what it means. Deleting the warrant is the supported way to withdraw
    // what Reeve may do, and a run that read the absence as "no restrictions"
    // would make deletion the widest setting available. This still applies in
    // full to a path a consumer chose themselves: naming a file that is not
    // there is a configuration mistake, not the silence the default path gets
    // the benefit of.
    throw new Error(
      `warrant: \`${path}\` could not be read, so this run has no authority — ${reason}. ` +
        "Write one, or point `warrant` at where yours lives.",
      { cause: error },
    );
  }
  return parseWarrant(path, source);
}

/** Whether a `readFile` failure means "not there" rather than something else worth failing over. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function parseWarrant(path: string, source: string): Warrant {
  const document = load(path, source);

  // Reject unknown root keys before any sub-reader runs, so a typo is caught
  // before it becomes a silently ignored setting that someone ships to prod.
  const KNOWN_ROOT = [
    "version",
    "labels",
    "languages",
    "pivot",
    "memory",
    "about",
    "lifecycle",
    "propose",
    "dependa",
    "capabilities",
  ] as const;
  for (const key of Object.keys(document)) {
    if (!(KNOWN_ROOT as readonly string[]).includes(key)) {
      throw new Error(
        `warrant: \`${path}\` has an unrecognized key \`${key}\`. ` +
          `Expected any of ${KNOWN_ROOT.join(", ")}.`,
      );
    }
  }

  const version: unknown = document.version;
  if (version !== VERSION) {
    // Naming the version rather than parsing a future format into something
    // plausible and wrong. A file written for a format this build does not know
    // is a file whose guarantees this build cannot honour.
    throw new Error(
      `warrant: \`${path}\` declares version ${describe(version)}, and this build understands ${String(VERSION)}.`,
    );
  }

  const labels = readLabels(path, document.labels);
  const languages = readLanguages(path, document.languages);
  const pivot = readPivot(path, document.pivot);
  const memory = readMemory(path, document.memory);
  const about = readAbout(path, document.about);
  const lifecycle = readLifecycle(path, document.lifecycle);
  const propose = readPropose(path, document.propose);
  const dependa = readDependa(path, document.dependa);
  const { declared, granted: capabilities } = readCapabilities(path, document.capabilities);

  // After every entry exists, so `exclusive_with: [bg]` names the typo rather
  // than being resolved against a partly-built map.
  const names = new Set(labels.map((label) => label.name));
  for (const label of labels) {
    for (const other of label.exclusiveWith) {
      if (!names.has(other)) {
        throw new Error(
          `warrant: \`${path}\` has \`${label.name}\` exclusive with \`${other}\`, ` +
            "which is not a label in this file.",
        );
      }
    }
  }

  const byName = new Map(labels.map((label) => [label.name, label]));

  return {
    path,
    labels,
    languages,
    pivot,
    memory,
    about,
    lifecycle,
    propose,
    dependa,
    granted: (duty, fallback) => capabilities.get(duty) ?? (declared ? [] : fallback),
    unnamed: (duty) => declared && !capabilities.has(duty),
    labelNamed: (name) => byName.get(name),
  };
}

/**
 * Every name the taxonomy claims, checked against the labels that actually
 * exist.
 *
 * Separate from parsing because it is the one validation that needs the
 * network, and separate from the apply stage because failing there would look
 * exactly like a model that agreed with nothing: every label dropped, no error,
 * an empty verdict on every issue. A taxonomy naming a renamed label is a
 * configuration mistake, and it says so once, before a single request is spent.
 *
 * Case-sensitive, because GitHub applies a label by its exact name. It is also
 * where a rename that only changed case gets caught, which is otherwise
 * invisible in the tracker's own UI.
 *
 * Checks `taxonomy`, not `warrant.labels`, and defaults to the latter only
 * because most callers have not narrowed anything. A run scoped by the
 * `labels` input has already narrowed its taxonomy before this is called —
 * checking the warrant's whole one instead would fail a run over a label
 * renamed in an area it was never asked to touch, which is exactly the
 * isolation this narrowing exists to give it.
 *
 * A missing entry whose `create: true` is not an error: it is returned
 * instead, for the caller to create via the tracker API (this module never
 * touches the network) — the narrow branch `propose`'s design describes. A
 * missing entry without `create: true` still fails exactly as before.
 */
export function checkLabelsExist(
  warrant: Warrant,
  existing: readonly string[],
  taxonomy: readonly Label[] = warrant.labels,
): readonly Label[] {
  const present = new Set(existing);
  const missing = taxonomy.filter((label) => !present.has(label.name));
  if (missing.length === 0) return [];

  const toCreate = missing.filter((label) => label.create);
  const toFail = missing.filter((label) => !label.create);
  if (toFail.length > 0) {
    // Every missing name at once. Reporting the first would make fixing a
    // three-label rename three failed runs.
    throw new Error(
      `warrant: \`${warrant.path}\` names ${toFail.length === 1 ? "a label" : "labels"} ` +
        `this repository does not have — ${toFail.map((label) => `\`${label.name}\``).join(", ")}. ` +
        "Create them, correct the taxonomy, or mark the entry `create: true`.",
    );
  }
  return toCreate;
}

/**
 * The same check as {@link checkLabelsExist}, scoped to a lifecycle policy's
 * own label references (`when:`, `overrides[].label`, `exempt.labels`) —
 * kept separate because a track's clock-hand need not be a taxonomy entry at
 * all (`stale`, `never-stale` usually aren't), so it cannot reuse
 * `warrant.labels`. Always red on missing: a clock-hand label that does not
 * exist looks exactly like a clock that never ran.
 */
export function checkLifecycleLabelsExist(warrant: Warrant, existing: readonly string[]): void {
  const policy = warrant.lifecycle;
  if (policy === null) return;

  const named = new Set<string>();
  for (const track of policy.tracks) {
    if (track.when !== null) named.add(track.when);
    for (const step of track.steps) {
      if (step.label !== null) named.add(step.label);
    }
  }
  for (const override of policy.overrides) named.add(override.label);
  for (const label of policy.exempt.labels) named.add(label);

  const present = new Set(existing);
  const missing = [...named].filter((name) => !present.has(name));
  if (missing.length === 0) return;

  throw new Error(
    `warrant: \`${warrant.path}\`'s \`lifecycle:\` names ${missing.length === 1 ? "a label" : "labels"} ` +
      `this repository does not have — ${missing.map((name) => `\`${name}\``).join(", ")}. ` +
      "Create them, or correct the policy.",
  );
}

/** What `implicitWarrant` reads from each label. Any hosting platform's own shape satisfies it. */
export interface RepositoryLabel {
  readonly name: string;
  /** What the maintainers wrote for it, or `null` when they wrote nothing. */
  readonly description: string | null;
}

/** What building the implicit warrant produced, and what it left out along the way. */
export interface Implicit {
  readonly warrant: Warrant;
  /**
   * Labels this repository has that carry no description on GitHub, and so
   * were left out of the taxonomy this call built. A name alone gives a model
   * nothing to match a thread against honestly, and offering one anyway would
   * be pretending a taxonomy exists where only a label does.
   */
  readonly excluded: readonly string[];
}

/**
 * The warrant a repository runs under when it has written none.
 *
 * Built rather than read, from exactly the labels this repository already
 * has and exactly the descriptions its maintainers already wrote for them —
 * a taxonomy that existed the whole time without anybody calling it one. It
 * is deliberately thin: `not`, `examples`, `owner` and `exclusive_with` are
 * things only a written warrant can say, because none of them can be
 * recovered honestly from a label alone.
 *
 * No `capabilities:` block was ever written, because there is no file, so
 * `granted` hands back whatever `fallback` the caller offers — which is what
 * every duty already reaches for when a warrant is silent about it, and here
 * is the whole reason this function does not need to know a single duty's
 * name to build the narrowest authority for all of them.
 *
 * `languages` is always `null` here, for the same reason `not`, `examples`
 * and `owner` are never recovered on a label: a repository's labels cannot
 * honestly be read as a reader-language list, and an implicit warrant only
 * ever states what it can derive without guessing.
 */
export function implicitWarrant(
  path: string,
  repositoryLabels: readonly RepositoryLabel[],
): Implicit {
  const labels: Label[] = [];
  const excluded: string[] = [];

  for (const label of repositoryLabels) {
    const description = label.description?.trim() ?? "";
    if (description.length === 0) {
      excluded.push(label.name);
      continue;
    }
    labels.push({
      name: label.name,
      description,
      not: null,
      examples: [],
      owner: null,
      exclusiveWith: [],
      confidence: null,
      paths: [],
      create: false,
      color: null,
    });
  }

  const byName = new Map(labels.map((label) => [label.name, label]));

  return {
    warrant: {
      path,
      labels,
      languages: null,
      pivot: null,
      memory: null,
      about: null,
      lifecycle: null,
      dependa: null,
      propose: DEFAULT_PROPOSE_WORKSPACE,
      granted: (_duty, fallback) => fallback,
      unnamed: () => false,
      labelNamed: (name) => byName.get(name),
    },
    excluded,
  };
}

/**
 * What `readWarrant` returned, turned into the warrant a run actually acts
 * under.
 *
 * Shared by every duty rather than reimplemented per `main.ts`, because the
 * question it answers — "was there a file, or is this the narrowest authority
 * this build assumes in its place" — is the same question for all of them,
 * and the answer has to stay one function so it cannot drift between duties
 * that read it differently.
 */
export interface Authority {
  readonly warrant: Warrant;
  /** True when there was no warrant file, and this ran at the narrowest authority instead. */
  readonly implicit: boolean;
  /** Repository labels the implicit warrant left out for carrying no description. */
  readonly excludedLabels: readonly string[];
}

/**
 * The real warrant when there was one to read, or the implicit one built from
 * this repository's own labels when there was not.
 *
 * The single point where "absent at the default path" turns from a fact
 * about a file into a fact about what a duty may do — everything past this
 * function treats `Authority.warrant` as *the* warrant, written or not.
 */
export async function resolveAuthority(
  read: Warrant | null,
  path: string,
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
): Promise<Authority> {
  if (read !== null) return { warrant: read, implicit: false, excludedLabels: [] };

  const repositoryLabels = await listRepositoryLabels(api, at);
  const built = implicitWarrant(path, repositoryLabels);
  return { warrant: built.warrant, implicit: true, excludedLabels: built.excluded };
}

/**
 * Where every duty's `action.yml` defaults its `warrant` input to.
 *
 * Declared once, here, rather than repeated as a private constant in five
 * `main.ts` files. `readWarrant` has to be told which path is the default so
 * it can tell a consumer's silence from a consumer's choice — an absent file
 * at this path is the implicit warrant, an absent file at a path somebody
 * typed is an error — and there is no version of that comparison where the
 * five duties should be free to disagree about the value.
 */
export const DEFAULT_WARRANT_PATH = ".github/reeve.yml";

/** The authority a run acts under, and what it already knows about its own grant. */
export interface Opened {
  readonly authority: Authority;
  /**
   * True when a written `capabilities:` block never named this duty at all —
   * decided once per run, before anything is spent, because no verdict
   * downstream can change it.
   */
  readonly denied: boolean;
}

/**
 * The three lines every duty's `run` opens with: read the warrant, resolve
 * the absent one into the implicit one, and ask whether a written block named
 * this duty at all.
 *
 * First, and before anything is spent, in every duty. A file that does not
 * parse is a run with no allowlist and the fail-safe direction is to stop —
 * but a file that is simply not there, at the path nobody moved it from, is
 * not that failure, and `resolveAuthority` is what turns that absence into
 * the implicit warrant rather than an error.
 */
export async function openAuthority(
  path: string,
  api: TrackerApi,
  at: Pick<Location, "owner" | "repo">,
  duty: string,
): Promise<Opened> {
  const read = await readWarrant(path, { defaultPath: DEFAULT_WARRANT_PATH });
  const authority = await resolveAuthority(read, path, api, at);
  return { authority, denied: authority.warrant.unnamed(duty) };
}

/** What resolving `languages` against the warrant and the input decided. */
export interface LanguagesResolution {
  readonly languages: readonly Language[];
  /**
   * Set only when the warrant's key won, so a run can say once why the
   * `languages` input was never consulted — a maintainer staring at an input
   * that looks configured and a run that plainly ignored it deserves the one
   * sentence that explains it, not a warning storm.
   */
  readonly notice: string | null;
}

/**
 * Which of the two sources answers "what to translate into" or "what a
 * contributor writes in" this run.
 *
 * The warrant wins outright when it has an opinion: once `languages:` is
 * written there, the `languages` input is not a fallback to blend with it, it
 * is not consulted at all — the file is the whole answer, the same way a
 * `capabilities:` block is. Only when the file is silent about it — no key,
 * or no warrant at all, which `implicitWarrant` always leaves silent — does
 * the input get asked, exactly as it always has.
 */
export function resolveLanguages(warrant: Warrant, rawInput: string): LanguagesResolution {
  if (warrant.languages !== null) {
    return {
      languages: warrant.languages,
      notice:
        `languages: read from \`${warrant.path}\`'s \`languages:\` key, not the \`languages\` ` +
        "input — the file is the whole answer once that key is written.",
    };
  }

  if (rawInput.trim().length === 0) {
    throw new Error(
      "languages: no language is configured. Write `languages:` in the warrant " +
        `(\`${warrant.path}\`), or set the \`languages\` input.`,
    );
  }

  return { languages: parseLanguages(rawInput), notice: null };
}

/**
 * {@link resolveLanguages} as the four duties that share a `denied` gate
 * actually call it: resolved, its notice said once, and skipped entirely for
 * a run the warrant already refused.
 *
 * A denied run is promised a green no-op. Resolving `languages` for it would
 * red-fail it over configuration it was never going to use — a repository
 * that never intended to grant this duty anything has no reason to have
 * configured a language for it, and the honest answer for a run that will
 * read nothing is that it reads no languages.
 *
 * `rawInput` is passed rather than read here, because a duty's `main.ts` is
 * where its own `action.yml` inputs are read — see any duty's
 * `main.integration.test.ts` for the audit that keeps it that way.
 */
export function dutyLanguages(
  warrant: Warrant,
  denied: boolean,
  rawInput: string,
): readonly Language[] {
  if (denied) return [];

  const resolution = resolveLanguages(warrant, rawInput);
  if (resolution.notice !== null) core.notice(resolution.notice);
  return resolution.languages;
}

/**
 * The pivot language corrections are bridged through, resolved against the
 * final list of configured languages — whichever of `languages:` or the
 * `languages` input answered that.
 *
 * The warrant's `pivot:` wins outright when written, refused if it names a
 * language that is not in `languages` — a pivot nothing translates into or
 * out of cannot bridge anything. Absent, the first-listed language is the
 * pivot, exactly the behaviour this key made explicit rather than changed.
 */
export function resolvePivot(warrant: Warrant, languages: readonly Language[]): Language {
  const first = languages[0];
  if (warrant.pivot === null) {
    if (first === undefined) {
      throw new Error("pivot: no languages are configured to choose one from.");
    }
    return first;
  }

  const found = findLanguage(languages, warrant.pivot);
  if (found === undefined) {
    throw new Error(
      `warrant: \`${warrant.path}\`'s \`pivot: ${warrant.pivot}\` is not one of the configured ` +
        `languages (${languages.map((language) => language.code).join(", ")}).`,
    );
  }
  return found;
}

/**
 * {@link resolvePivot}, for the four call sites that have to cope with a run
 * that configured no languages at all.
 *
 * There is no pivot to resolve when nothing is configured to bridge between,
 * and that is not an error: a single-language project recalls in its own
 * language and never spends a request on a translation. `resolvePivot` throws
 * on an empty list because a caller that has already committed to bridging
 * needs to hear about it; a caller still deciding whether to bridge asks this
 * instead and reads `null` as "there is nothing here worth a bridge".
 */
export function pivotOrNone(warrant: Warrant, languages: readonly Language[]): Language | null {
  return languages.length > 0 ? resolvePivot(warrant, languages) : null;
}

/** What resolving `about` against the warrant and the input decided. */
export interface AboutResolution {
  readonly about: string;
  /** Set only when the warrant's key won — see {@link resolveLanguages}'s identical field. */
  readonly notice: string | null;
}

/**
 * Which of the two sources answers "what this repository is about" this run —
 * the same warrant-wins, input-falls-back pattern as {@link resolveLanguages},
 * on a field where both an absent warrant key and an absent input are
 * legitimate: an empty answer just leaves the spam screen asking from the
 * title alone, as it always has.
 */
export function resolveAbout(warrant: Warrant, rawInput: string): AboutResolution {
  if (warrant.about !== null) {
    return {
      about: warrant.about,
      notice:
        `about: read from \`${warrant.path}\`'s \`about:\` key, not the \`about\` input — the file ` +
        "is the whole answer once that key is written.",
    };
  }
  return { about: rawInput.trim(), notice: null };
}

/** The document, or a parse error that says where in the file it is. */
function load(path: string, source: string): Record<string, unknown> {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    const reason =
      error instanceof YAMLParseError ? error.message : error instanceof Error ? error.message : "";
    throw new Error(`warrant: \`${path}\` is not valid YAML — ${reason}`, { cause: error });
  }

  // An empty file parses to null, and a file that is one string parses to that
  // string. Neither is a warrant, and both would otherwise reach the version
  // check as `undefined` and be reported as a version problem.
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(
      `warrant: \`${path}\` is not a warrant — expected a YAML mapping with \`version\` and \`labels\`.`,
    );
  }
  return document as Record<string, unknown>;
}

/**
 * The taxonomy.
 *
 * An absent `labels:` is an empty taxonomy rather than an error: a repository
 * that has written a warrant to configure capabilities and nothing else is a
 * legitimate configuration, and the duty that needs a taxonomy is the one that
 * knows it needs one.
 */
function readLabels(path: string, raw: unknown): readonly Label[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`warrant: \`${path}\` has \`labels\` as ${describe(raw)}, expected a list.`);
  }

  const labels: Label[] = [];
  // Case-insensitive, because GitHub will not let a repository hold both `Bug`
  // and `bug`. Two entries differing only in case are therefore two entries
  // that cannot both be applied, and the file is describing something the
  // tracker cannot represent.
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const at = `\`${path}\` label ${String(index + 1)}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`warrant: ${at} is ${describe(entry)}, expected a mapping with a \`name\`.`);
    }
    const fields = entry as Record<string, unknown>;

    // Reject unknown keys so a typo is caught rather than silently ignored.
    const KNOWN_LABEL = [
      "name",
      "description",
      "not",
      "examples",
      "owner",
      "exclusive_with",
      "confidence",
      "paths",
      "create",
      "color",
    ] as const;
    for (const key of Object.keys(fields)) {
      if (!(KNOWN_LABEL as readonly string[]).includes(key)) {
        throw new Error(
          `warrant: ${at} has an unrecognized key \`${key}\`. ` +
            `Expected any of ${KNOWN_LABEL.join(", ")}.`,
        );
      }
    }

    const name = text(at, "name", fields.name, { required: true });
    if (seen.has(name.toLowerCase())) {
      throw new Error(`warrant: \`${path}\` names \`${name}\` more than once.`);
    }
    seen.add(name.toLowerCase());

    const owner = text(`${at} (\`${name}\`)`, "owner", fields.owner, { required: false });
    if (owner.length > 0 && !HANDLE.test(owner)) {
      throw new Error(
        `warrant: \`${path}\` gives \`${name}\` the owner \`${owner}\`, ` +
          "which is not a handle. Expected `@user` or `@org/team`.",
      );
    }

    labels.push({
      name,
      description: text(`${at} (\`${name}\`)`, "description", fields.description, {
        required: true,
      }),
      not: nullable(text(`${at} (\`${name}\`)`, "not", fields.not, { required: false })),
      examples: strings(`${at} (\`${name}\`)`, "examples", fields.examples),
      owner: nullable(owner),
      exclusiveWith: strings(`${at} (\`${name}\`)`, "exclusive_with", fields.exclusive_with),
      confidence: confidenceField(`${at} (\`${name}\`)`, "confidence", fields.confidence),
      paths: strings(`${at} (\`${name}\`)`, "paths", fields.paths),
      create: booleanField(`${at} (\`${name}\`)`, "create", fields.create, false),
      color: colorField(`${at} (\`${name}\`)`, "color", fields.color),
    });
  }

  return labels;
}

/**
 * The `languages:` key: the reader languages, as a YAML list.
 *
 * Absent entirely, this is `null` — the file never turned its mind to the
 * question, and `resolveLanguages` reads that as leaving the `languages`
 * input to answer it instead, exactly as it does today. That reading is for
 * a key that was never written, not for one written empty: `languages:` with
 * nothing under it is refused, because once the key is in the file the file
 * is the whole answer, and silently consulting the input behind an empty key
 * would make an unfinished edit indistinguishable from a decision.
 *
 * Present, every entry is fed to `parseLanguages` unchanged, as the list YAML
 * already split: this is the identical bare-code and `code:Label:Script`
 * grammar the input accepts, not a second parser for a second surface — and
 * handing entries over one-per-element means a comma inside a spelled-out
 * label stays inside it, where the input's one-line grammar would have read
 * it as a separator.
 */
function readLanguages(path: string, raw: unknown): readonly Language[] | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error(
      `warrant: \`${path}\` writes \`languages:\` with nothing under it. Name at least one ` +
        "language, or delete the key to leave the `languages` input in charge.",
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(`warrant: \`${path}\` has \`languages\` as ${describe(raw)}, expected a list.`);
  }

  const entries = raw.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(
        `warrant: \`${path}\` \`languages\` entry ${String(index + 1)} is ${describe(entry)}, expected text.`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error(
        `warrant: \`${path}\` \`languages\` entry ${String(index + 1)} is empty, expected a language.`,
      );
    }
    return entry.trim();
  });

  return parseLanguages(entries);
}

/**
 * The `pivot:` key: a language code, or `null` when the file never wrote one.
 *
 * Not resolved against the final `languages` list here — that list may still
 * come from the `languages` input rather than this file, and `readWarrant`
 * runs before either duty has decided which. `resolvePivot` does that once
 * the caller has the real list in hand.
 *
 * `pivot:` with nothing under it parses as YAML `null`, which is refused
 * rather than read as absence — the same distinction `readLanguages` draws:
 * once the key is in the file, an unfinished edit is not the same fact as
 * the key never having been written.
 */
function readPivot(path: string, raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      `warrant: \`${path}\` has \`pivot\` as ${describe(raw)}, expected a language code.`,
    );
  }
  return raw.trim();
}

/**
 * The `memory:` block. Absent entirely is `null`, which leaves a duty's own
 * default in charge — see {@link Warrant.memory}. Present, `recall` is
 * required: a block with nothing in it — including `memory:` written with
 * nothing under it, which parses as YAML `null` — is the same half-finished-
 * edit shape `capabilities:` and `languages:` both refuse rather than guess
 * at.
 */
function readMemory(path: string, raw: unknown): MemorySettings | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error(
      `warrant: \`${path}\` writes \`memory:\` with nothing under it. Write \`recall:\` under it, ` +
        "or remove the key to leave the duty's own default in charge.",
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`warrant: \`${path}\` has \`memory\` as ${describe(raw)}, expected a mapping.`);
  }

  const fields = raw as Record<string, unknown>;
  const recall = fields.recall;
  if (recall === undefined || recall === null) {
    throw new Error(`warrant: \`${path}\`'s \`memory\` has no \`recall\`.`);
  }
  if (typeof recall !== "number" || !Number.isInteger(recall) || recall < 0) {
    throw new Error(
      `warrant: \`${path}\`'s \`memory.recall\` is ${describe(recall)}, expected a whole number of 0 or more.`,
    );
  }
  return { recall };
}

/** The `about:` key. Absent or empty are both `null` — see {@link Warrant.about}. */
function readAbout(path: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error(`warrant: \`${path}\` has \`about\` as ${describe(raw)}, expected text.`);
  }
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

/**
 * The `lifecycle:` key. Absent entirely is `null` — see {@link Warrant.lifecycle}'s
 * no-implicit-policy doc comment. Written with nothing under it is refused,
 * the same half-finished-edit shape `memory:`/`capabilities:` both refuse.
 */
function readLifecycle(path: string, raw: unknown): LifecyclePolicy | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error(
      `warrant: \`${path}\` writes \`lifecycle:\` with nothing under it. Write \`tracks:\` under ` +
        "it, or remove the key to leave the duty unwired.",
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `warrant: \`${path}\` has \`lifecycle\` as ${describe(raw)}, expected a mapping.`,
    );
  }
  const fields = raw as Record<string, unknown>;
  rejectUnknownKeys(`\`${path}\`'s \`lifecycle\``, fields, [
    "tracks",
    "exempt",
    "overrides",
    "threads",
  ]);

  const tracks = readLifecycleTracks(path, fields.tracks);
  const exempt = readLifecycleExempt(path, fields.exempt);
  const overrides = readLifecycleOverrides(path, fields.overrides);

  const threadsRaw = fields.threads;
  const threads = threadsRaw === undefined ? "issues" : threadsRaw;
  if (threads !== "issues" && threads !== "prs" && threads !== "both") {
    throw new Error(
      `warrant: \`${path}\`'s \`lifecycle.threads\` is ${describe(threadsRaw)}, ` +
        "expected `issues`, `prs`, or `both`.",
    );
  }

  // The permanent escape hatch must exist before closing may be configured at
  // all — enforced structurally, not editorially, once here rather than once
  // per track.
  const hasClose = tracks.some((track) => track.steps.some((step) => step.close));
  if (hasClose && exempt.labels.length === 0) {
    throw new Error(
      `warrant: \`${path}\`'s \`lifecycle:\` configures a \`close\` step, but \`exempt.labels\` is ` +
        "empty. A permanent escape hatch must exist before closing may be configured at all.",
    );
  }

  return { tracks, exempt, overrides, threads };
}

/** `lifecycle.tracks`: required, non-empty, unique names. */
function readLifecycleTracks(path: string, raw: unknown): readonly LifecycleTrack[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `warrant: \`${path}\`'s \`lifecycle:\` has no \`tracks\` — a lifecycle with no tracks ` +
        "decides nothing. Delete the key, or write a track.",
    );
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const at = `\`${path}\`'s \`lifecycle.tracks\` entry ${String(index + 1)}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`warrant: ${at} is ${describe(entry)}, expected a mapping with a \`name\`.`);
    }
    const fields = entry as Record<string, unknown>;
    rejectUnknownKeys(at, fields, ["name", "when", "resets", "steps"]);

    const name = text(at, "name", fields.name, { required: true });
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(
        `warrant: ${at} names the track \`${name}\`, expected lowercase letters, digits and ` +
          "hyphens, starting with a letter.",
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `warrant: \`${path}\`'s \`lifecycle.tracks\` names \`${name}\` more than once.`,
      );
    }
    seen.add(name);

    const named = `${at} (\`${name}\`)`;
    const when = nullable(text(named, "when", fields.when, { required: false }));
    const resets = resetsField(named, fields.resets, when !== null ? "author" : "any");

    const stepsRaw = fields.steps;
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
      throw new Error(
        `warrant: ${named} has no \`steps\` — a track with no steps decides nothing.`,
      );
    }
    const steps = stepsRaw.map((step, stepIndex) =>
      readLifecycleStep(
        `${named} step ${String(stepIndex + 1)}`,
        step,
        stepIndex === stepsRaw.length - 1,
      ),
    );

    // A close with no prior warning on mere silence is the single most-
    // regretted behaviour in the field. A `when:` track may close first —
    // there the human's label application was the warning.
    if (when === null && steps[0]?.close === true) {
      throw new Error(
        `warrant: ${named} is an inactivity track whose first step closes — a close with no prior ` +
          "warning is refused. Add a `when:` start, or a warning step before the close.",
      );
    }

    return { name, when, resets, steps };
  });
}

function resetsField(at: string, raw: unknown, fallback: LifecycleResets): LifecycleResets {
  if (raw === undefined || raw === null) return fallback;
  if (raw === "author" || raw === "any") return raw;
  throw new Error(
    `warrant: ${at} has \`resets\` as ${describe(raw)}, expected \`author\` or \`any\`.`,
  );
}

function readLifecycleStep(at: string, raw: unknown, isLast: boolean): LifecycleStep {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`warrant: ${at} is ${describe(raw)}, expected a mapping.`);
  }
  const fields = raw as Record<string, unknown>;
  rejectUnknownKeys(at, fields, ["after", "label", "say", "close"]);

  const after = durationField(at, "after", fields.after, { allowNever: false });
  const label = nullable(text(at, "label", fields.label, { required: false }));
  const say = readSay(at, fields.say);
  const close = closeField(at, fields.close);

  if (close && !isLast) {
    throw new Error(
      `warrant: ${at} has \`close\` on a step that is not the track's last — close must be the ` +
        "terminal step.",
    );
  }
  if (label === null && say === null && !close) {
    throw new Error(
      `warrant: ${at} carries none of \`label\`, \`say\`, \`close\` — a step must do something.`,
    );
  }

  return { after, label, say, close };
}

/** A step's `say:` — bare `true` = built-in template, text, or a language-keyed mapping. */
function readSay(at: string, raw: unknown): LifecycleSay | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return { kind: "built-in" };
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value.length === 0) throw new Error(`warrant: ${at} has an empty \`say\`.`);
    return { kind: "text", text: value };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const map = new Map<string, string>();
    for (const [lang, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`warrant: ${at}'s \`say.${lang}\` is ${describe(value)}, expected text.`);
      }
      map.set(lang, value.trim());
    }
    if (map.size === 0) throw new Error(`warrant: ${at} writes \`say:\` with nothing under it.`);
    return { kind: "map", map };
  }
  throw new Error(
    `warrant: ${at} has \`say\` as ${describe(raw)}, expected true, text, or a mapping of language to text.`,
  );
}

/**
 * A step's `close:`. `true` and the literal `not_planned` both mean the
 * same thing. `completed` is refused by name: `forge.ts`'s own
 * `closeAsNotPlanned` doctrine comment is the argument — "nothing Reeve
 * closes was completed by Reeve closing it."
 */
function closeField(at: string, raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === false) return false;
  if (raw === true || raw === "not_planned") return true;
  if (raw === "completed") {
    throw new Error(
      `warrant: ${at} has \`close: completed\` — Reeve closes only as \`not_planned\`. Write ` +
        "`close: true`.",
    );
  }
  throw new Error(`warrant: ${at} has \`close\` as ${describe(raw)}, expected true or false.`);
}

/** `lifecycle.exempt`: the four layers. Protective defaults even when the key is unwritten. */
function readLifecycleExempt(path: string, raw: unknown): LifecycleExempt {
  const at = `\`${path}\`'s \`lifecycle.exempt\``;
  if (raw === undefined || raw === null) {
    return {
      labels: [],
      milestones: true,
      assignees: true,
      taxonomy: true,
      comments: null,
      drafts: true,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`warrant: ${at} is ${describe(raw)}, expected a mapping.`);
  }
  const fields = raw as Record<string, unknown>;
  rejectUnknownKeys(at, fields, [
    "labels",
    "milestones",
    "assignees",
    "taxonomy",
    "comments",
    "drafts",
  ]);
  return {
    labels: strings(at, "labels", fields.labels),
    milestones: guardField(at, "milestones", fields.milestones, true),
    assignees: guardField(at, "assignees", fields.assignees, true),
    taxonomy: booleanField(at, "taxonomy", fields.taxonomy, true),
    comments: optionalWholeNumber(at, "comments", fields.comments, 1),
    drafts: booleanField(at, "drafts", fields.drafts, true),
  };
}

/** `true`, `false`, or a scoping list of names — the shape `milestones`/`assignees` share. */
function guardField(
  at: string,
  key: string,
  raw: unknown,
  fallback: boolean,
): boolean | readonly string[] {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string" || Array.isArray(raw)) return strings(at, key, raw);
  throw new Error(
    `warrant: ${at} has \`${key}\` as ${describe(raw)}, expected true, false, or a list of names.`,
  );
}

/** `lifecycle.overrides`: per-label timing exceptions. */
function readLifecycleOverrides(path: string, raw: unknown): readonly LifecycleOverride[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `warrant: \`${path}\`'s \`lifecycle.overrides\` is ${describe(raw)}, expected a list.`,
    );
  }
  return raw.map((entry, index) => {
    const at = `\`${path}\`'s \`lifecycle.overrides\` entry ${String(index + 1)}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`warrant: ${at} is ${describe(entry)}, expected a mapping with a \`label\`.`);
    }
    const fields = entry as Record<string, unknown>;
    rejectUnknownKeys(at, fields, ["label", "after", "never"]);
    const label = text(at, "label", fields.label, { required: true });
    const hasAfter = fields.after !== undefined && fields.after !== null;
    const never = booleanField(at, "never", fields.never, false);
    if (hasAfter && never) {
      throw new Error(
        `warrant: ${at} (\`${label}\`) has both \`after\` and \`never\` — write one.`,
      );
    }
    if (!hasAfter && !never) {
      throw new Error(`warrant: ${at} (\`${label}\`) has neither \`after\` nor \`never\`.`);
    }
    const after = hasAfter ? durationField(at, "after", fields.after, { allowNever: false }) : null;
    return { label, after, never };
  });
}

/**
 * The `dependa:` key. Absent entirely is `null` — dependa runs with its own
 * conservative defaults, the same pattern `lifecycle` follows. Written with
 * nothing under it is refused, the same half-finished-edit shape
 * `lifecycle:`/`capabilities:` both refuse rather than guess at.
 */
function readDependa(path: string, raw: unknown): DependaPolicy | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error(
      `warrant: \`${path}\` writes \`dependa:\` with nothing under it. Write \`allowed-types:\` under it, ` +
        "or remove the key to leave dependa's own defaults in charge.",
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `warrant: \`${path}\` has \`dependa\` as ${describe(raw)}, expected a mapping.`,
    );
  }
  const fields = raw as Record<string, unknown>;
  rejectUnknownKeys(`\`${path}\`'s \`dependa\``, fields, [
    "ecosystems",
    "allowed-types",
    "ignore",
    "grouping",
    "security-separate",
    "auto-approve",
    "auto-close",
    "auto-rebase",
    "schedule",
  ]);

  return {
    ecosystems: readDependaEcosystems(path, fields.ecosystems),
    allowedTypes: readDependaAllowedTypes(path, fields["allowed-types"]),
    ignore: readDependaIgnore(path, fields.ignore),
    grouping: readDependaGrouping(path, fields.grouping),
    securitySeparate: booleanField(
      `\`${path}\`'s \`dependa\``,
      "security-separate",
      fields["security-separate"],
      true,
    ),
    autoApprove: readDependaAutoApprove(path, fields["auto-approve"]),
    autoClose: booleanField(`\`${path}\`'s \`dependa\``, "auto-close", fields["auto-close"], false),
    autoRebase: booleanField(
      `\`${path}\`'s \`dependa\``,
      "auto-rebase",
      fields["auto-rebase"],
      true,
    ),
    schedule: readDependaSchedule(path, fields.schedule),
  };
}

function readDependaEcosystems(path: string, raw: unknown): readonly Ecosystem[] {
  if (raw === undefined || raw === null) return [];
  const list = strings(`\`${path}\`'s \`dependa\``, "ecosystems", raw);
  const ecosystems: Ecosystem[] = [];
  for (const entry of list) {
    const eco = ECOSYSTEMS.find((e) => e === entry);
    if (eco === undefined) {
      throw new Error(
        `warrant: \`${path}\`'s \`dependa.ecosystems\` names \`${entry}\`, which is not a known ecosystem. ` +
          `Expected any of ${ECOSYSTEMS.join(", ")}.`,
      );
    }
    if (!ecosystems.includes(eco)) ecosystems.push(eco);
  }
  return ecosystems;
}

function readDependaAllowedTypes(path: string, raw: unknown): readonly UpdateType[] {
  if (raw === undefined || raw === null) {
    return ["patch", "minor", "pin", "digest", "rollback", "security"];
  }
  const list = strings(`\`${path}\`'s \`dependa\``, "allowed-types", raw);
  if (list.length === 0) {
    throw new Error(
      `warrant: \`${path}\`'s \`dependa.allowed-types\` is empty. Write at least one, or remove the key to take the defaults.`,
    );
  }
  const types: UpdateType[] = [];
  for (const entry of list) {
    const ut = UPDATE_TYPES.find((t) => t === entry);
    if (ut === undefined) {
      throw new Error(
        `warrant: \`${path}\`'s \`dependa.allowed-types\` names \`${entry}\`, which is not a known update type. ` +
          `Expected any of ${UPDATE_TYPES.join(", ")}.`,
      );
    }
    if (!types.includes(ut)) types.push(ut);
  }
  return types;
}

function readDependaIgnore(path: string, raw: unknown): readonly IgnoreRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `warrant: \`${path}\`'s \`dependa.ignore\` is ${describe(raw)}, expected a list.`,
    );
  }
  return raw.map((entry, index) => {
    const at = `\`${path}\`'s \`dependa.ignore\` entry ${String(index + 1)}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`warrant: ${at} is ${describe(entry)}, expected a mapping with a \`name\`.`);
    }
    const fields = entry as Record<string, unknown>;
    rejectUnknownKeys(at, fields, ["name", "ecosystem", "types"]);

    const name = text(at, "name", fields.name, { required: true });
    const ecosystem = readIgnoreEcosystem(at, fields.ecosystem);
    const types = readIgnoreTypes(at, fields.types);

    return { name, ecosystem, types };
  });
}

function readIgnoreEcosystem(at: string, raw: unknown): Ecosystem | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error(
      `warrant: ${at} has \`ecosystem\` as ${describe(raw)}, expected an ecosystem name.`,
    );
  }
  const eco = ECOSYSTEMS.find((e) => e === raw.trim());
  if (eco === undefined) {
    throw new Error(
      `warrant: ${at} has \`ecosystem: ${raw}\`, which is not a known ecosystem. ` +
        `Expected any of ${ECOSYSTEMS.join(", ")}.`,
    );
  }
  return eco;
}

function readIgnoreTypes(at: string, raw: unknown): readonly UpdateType[] {
  if (raw === undefined || raw === null) return [];
  const list = strings(at, "types", raw);
  const types: UpdateType[] = [];
  for (const entry of list) {
    const ut = UPDATE_TYPES.find((t) => t === entry);
    if (ut === undefined) {
      throw new Error(
        `warrant: ${at} has \`types\` naming \`${entry}\`, which is not a known update type. ` +
          `Expected any of ${UPDATE_TYPES.join(", ")}.`,
      );
    }
    if (!types.includes(ut)) types.push(ut);
  }
  return types;
}

function readDependaGrouping(path: string, raw: unknown): "by-ecosystem" | "by-package" | "single" {
  if (raw === undefined || raw === null) return "by-ecosystem";
  if (raw !== "by-ecosystem" && raw !== "by-package" && raw !== "single") {
    throw new Error(
      `warrant: \`${path}\`'s \`dependa.grouping\` is ${describe(raw)}, expected \`by-ecosystem\`, \`by-package\`, or \`single\`.`,
    );
  }
  return raw;
}

function readDependaAutoApprove(path: string, raw: unknown): UpdateType | "none" {
  if (raw === undefined || raw === null) return "minor";
  if (raw === "none") return "none";
  const ut = UPDATE_TYPES.find((t) => t === raw);
  if (ut === undefined) {
    throw new Error(
      `warrant: \`${path}\`'s \`dependa.auto-approve\` is ${describe(raw)}, expected an update type or \`none\`.`,
    );
  }
  return ut;
}

function readDependaSchedule(path: string, raw: unknown): ScheduleConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Interval shorthand: "7d", "14d", etc.
    if (/^\d+d$/.test(trimmed)) {
      const days = Number(trimmed.slice(0, -1));
      if (days === 0) {
        throw new Error(
          `warrant: \`${path}\`'s \`dependa.schedule: 0d\` is not a schedule. Write a duration like \`7d\`, a cron expression, or remove the key.`,
        );
      }
      return { kind: "interval", days };
    }
    // Anything else is treated as a cron expression
    return { kind: "cron", expression: trimmed };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>;
    rejectUnknownKeys(`\`${path}\`'s \`dependa.schedule\``, fields, ["interval", "cron"]);

    const interval = fields.interval;
    const cron = fields.cron;

    if (interval !== undefined && cron !== undefined) {
      throw new Error(
        `warrant: \`${path}\`'s \`dependa.schedule\` has both \`interval\` and \`cron\` — write one.`,
      );
    }
    if (interval !== undefined && interval !== null) {
      const days = wholeNumber(`\`${path}\`'s \`dependa.schedule\``, "interval", interval, 1);
      return { kind: "interval", days };
    }
    if (cron !== undefined && cron !== null) {
      if (typeof cron !== "string" || cron.trim().length === 0) {
        throw new Error(
          `warrant: \`${path}\`'s \`dependa.schedule.cron\` is ${describe(cron)}, expected a cron expression.`,
        );
      }
      return { kind: "cron", expression: cron.trim() };
    }
    throw new Error(
      `warrant: \`${path}\`'s \`dependa.schedule\` writes a mapping with neither \`interval\` nor \`cron\`.`,
    );
  }
  throw new Error(
    `warrant: \`${path}\`'s \`dependa.schedule\` is ${describe(raw)}, expected a duration, a cron expression, or a mapping.`,
  );
}

/**
 * The `propose.workspace:` strategy. Absent entirely — either no `propose:`
 * key, or `propose:` written without a `workspace:` sub-key — takes the
 * design's own ruled defaults ({@link DEFAULT_PROPOSE_WORKSPACE}); these are
 * numbers the design already settled, not a duty's private opinion, so
 * defaulting them here (rather than leaving `null` for a caller to guess at)
 * is honest.
 */
function readPropose(path: string, raw: unknown): ProposeWorkspace {
  if (raw === undefined) return DEFAULT_PROPOSE_WORKSPACE;
  if (raw === null) {
    throw new Error(
      `warrant: \`${path}\` writes \`propose:\` with nothing under it. Write \`workspace:\` under ` +
        "it, or remove the key to take the defaults.",
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `warrant: \`${path}\` has \`propose\` as ${describe(raw)}, expected a mapping.`,
    );
  }
  const fields = raw as Record<string, unknown>;
  rejectUnknownKeys(`\`${path}\`'s \`propose\``, fields, ["workspace"]);
  const workspaceRaw = fields.workspace;
  if (workspaceRaw === undefined || workspaceRaw === null) return DEFAULT_PROPOSE_WORKSPACE;
  if (typeof workspaceRaw !== "object" || Array.isArray(workspaceRaw)) {
    throw new Error(
      `warrant: \`${path}\`'s \`propose.workspace\` is ${describe(workspaceRaw)}, expected a mapping.`,
    );
  }
  const w = workspaceRaw as Record<string, unknown>;
  const at = `\`${path}\`'s \`propose.workspace\``;
  rejectUnknownKeys(at, w, ["name", "except", "evidence", "window", "retire"]);

  const nameRaw = text(at, "name", w.name, { required: false });
  const name = nameRaw.length === 0 ? DEFAULT_PROPOSE_WORKSPACE.name : nameRaw;
  if ((name.match(/\{package\}/g) ?? []).length !== 1) {
    throw new Error(
      `warrant: ${at} has \`name: ${name}\`, expected exactly one \`{package}\` placeholder.`,
    );
  }

  const except = strings(at, "except", w.except);
  // A floor of zero is no floor — `evidence: 0` reads as "any candidate
  // qualifies", which is not what an evidence *requirement* means. The
  // lowest real requirement is one matching issue.
  const evidence =
    w.evidence === undefined
      ? DEFAULT_PROPOSE_WORKSPACE.evidence
      : wholeNumber(at, "evidence", w.evidence, 1);
  const window =
    w.window === undefined
      ? DEFAULT_PROPOSE_WORKSPACE.window
      : durationField(at, "window", w.window, { allowNever: false });
  const retire = booleanField(at, "retire", w.retire, false);

  return { name, except, evidence, window, retire };
}

function wholeNumber(at: string, key: string, raw: unknown, min: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min) {
    throw new Error(
      `warrant: ${at} has \`${key}\` as ${describe(raw)}, expected a whole number of ${String(min)} or more.`,
    );
  }
  return raw;
}

function optionalWholeNumber(at: string, key: string, raw: unknown, min: number): number | null {
  if (raw === undefined || raw === null) return null;
  return wholeNumber(at, key, raw, min);
}

/** Whether the block existed at all, and what it named if it did. */
interface Capabilities {
  /**
   * True the moment `capabilities:` is present in the file, even as an empty
   * mapping — `declared` is about whether the question was asked, not about
   * how it was answered. `granted`'s fallback behaviour, and `unnamed`'s
   * whole existence, both turn on this rather than on whether any duty in
   * particular was named.
   */
  readonly declared: boolean;
  readonly granted: ReadonlyMap<string, readonly Capability[]>;
}

/**
 * The capability block: which duty may do what.
 *
 * `[none]` is the way to grant nothing explicitly, and it has to be explicit —
 * an empty list is the shape a half-finished edit leaves behind, and reading it
 * as "grant nothing" would make a mistake indistinguishable from a decision.
 */
function readCapabilities(path: string, raw: unknown): Capabilities {
  const granted = new Map<string, readonly Capability[]>();
  if (raw === undefined) return { declared: false, granted };
  if (raw === null) {
    throw new Error(
      `warrant: \`${path}\` writes \`capabilities:\` with nothing under it. ` +
        "Use `[none]` to grant nothing, write the mapping, or remove the key " +
        "to keep every duty's own default.",
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `warrant: \`${path}\` has \`capabilities\` as ${describe(raw)}, ` +
        "expected a mapping of duty to what it may do.",
    );
  }

  for (const [duty, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `\`${path}\` capabilities for \`${duty}\``;

    if (!DUTIES.includes(duty) && !PLANNED.includes(duty)) {
      throw new Error(
        `warrant: \`${path}\` capabilities names \`${duty}\`, which is not a known duty. ` +
          `Expected any of ${[...DUTIES, ...PLANNED].join(", ")}.`,
      );
    }

    const entries = strings(at, duty, value);
    if (entries.length === 0) {
      throw new Error(
        `warrant: ${at} is empty. Use \`[none]\` to grant nothing, explicitly, ` +
          "or remove the entry to take this duty's own default.",
      );
    }

    if (entries.length === 1 && entries[0] === "none") {
      granted.set(duty, []);
      continue;
    }

    const permitted: Capability[] = [];
    for (const entry of entries) {
      const capability = CAPABILITIES.find((known) => known === entry);
      if (capability === undefined) {
        throw new Error(
          `warrant: ${at} names \`${entry}\`, which is not something a duty can be granted. ` +
            `Expected any of ${CAPABILITIES.join(", ")}, or \`none\` on its own.`,
        );
      }
      if (!permitted.includes(capability)) permitted.push(capability);
    }
    granted.set(duty, permitted);
  }

  return { declared: true, granted };
}

/** A required or optional string field, trimmed. Absent optional fields are empty. */
function text(at: string, key: string, raw: unknown, options: { required: boolean }): string {
  if (raw === undefined || raw === null) {
    if (!options.required) return "";
    throw new Error(`warrant: ${at} has no \`${key}\`.`);
  }
  if (typeof raw !== "string") {
    throw new Error(`warrant: ${at} has \`${key}\` as ${describe(raw)}, expected text.`);
  }
  const value = raw.trim();
  if (value.length === 0 && options.required) {
    throw new Error(`warrant: ${at} has an empty \`${key}\`.`);
  }
  return value;
}

/** A list-of-strings field. Absent is empty; a bare string is one entry. */
function strings(at: string, key: string, raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  // `exclusive_with: bug` is what somebody writes when there is one of them,
  // and reading it as one entry is the only reading it can have. This is the
  // single place this module guesses, and it guesses at a shape rather than at
  // a meaning.
  const list = Array.isArray(raw) ? raw : [raw];

  return list.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(
        `warrant: ${at} has \`${key}\` entry ${String(index + 1)} as ${describe(entry)}, expected text.`,
      );
    }
    const value = entry.trim();
    if (value.length === 0) {
      throw new Error(`warrant: ${at} has an empty \`${key}\` entry.`);
    }
    return value;
  });
}

function nullable(value: string): string | null {
  return value.length === 0 ? null : value;
}

/**
 * A label's own `confidence:` floor — a fraction between 0 and 1, or absent
 * to fall back on the run's floor, the same `confidence` input every label
 * has always shared. Written to raise or lower one label's own bar without
 * moving everyone else's: a label costly to get wrong can ask for more
 * certainty than the run's floor requires, without the run's floor having to
 * move for every other label to get it.
 */
function confidenceField(at: string, key: string, raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(
      `warrant: ${at} has \`${key}\` as ${describe(raw)}, expected a number between 0 and 1.`,
    );
  }
  return raw;
}

/** A required-or-defaulted boolean field. */
function booleanField(at: string, key: string, raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "boolean") {
    throw new Error(`warrant: ${at} has \`${key}\` as ${describe(raw)}, expected true or false.`);
  }
  return raw;
}

const HEX_COLOR = /^[0-9a-fA-F]{6}$/;

/** A label's own `color:` — a bare 6-digit hex, consulted only when `create` fires. */
function colorField(at: string, key: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !HEX_COLOR.test(raw.trim())) {
    throw new Error(
      `warrant: ${at} has \`${key}\` as ${describe(raw)}, expected a 6-digit hex color with no \`#\`.`,
    );
  }
  return raw.trim().toLowerCase();
}

/**
 * A duration field in the one grammar this file uses everywhere: `<n>d`,
 * whole days only. `never` is accepted only where the caller says so.
 * `0d` is refused — a duration of zero is not a duration, it is a `close:
 * true` in disguise.
 */
function durationField(
  at: string,
  key: string,
  raw: unknown,
  options: { allowNever: false },
): number;
function durationField(
  at: string,
  key: string,
  raw: unknown,
  options: { allowNever: true },
): number | null;
function durationField(
  at: string,
  key: string,
  raw: unknown,
  options: { readonly allowNever: boolean },
): number | null {
  if (options.allowNever && raw === "never") return null;
  if (typeof raw !== "string" || !/^\d+d$/.test(raw.trim())) {
    throw new Error(
      `warrant: ${at} has \`${key}\` as ${describe(raw)}, expected a duration like \`14d\`` +
        (options.allowNever ? " or `never`." : "."),
    );
  }
  const days = Number(raw.trim().slice(0, -1));
  if (days === 0) {
    throw new Error(
      `warrant: ${at} has \`${key}: 0d\`, which is not a duration. Write \`never\`, or remove the step.`,
    );
  }
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Refuses any key in `fields` that is not in `known` — a misspelled
 * `wehn:` (meant `when:`) or `exmept:` (meant `exempt:`) is not silently
 * dropped, it is caught the same way any other malformed block here is
 * (D5). Scoped to the new `lifecycle:`/`propose:` readers only — `readLabels`
 * and the rest of the taxonomy predate this check and are not retrofitted
 * by it.
 */
function rejectUnknownKeys(
  at: string,
  fields: Record<string, unknown>,
  known: readonly string[],
): void {
  for (const key of Object.keys(fields)) {
    if (!known.includes(key)) {
      throw new Error(`warrant: ${at} has an unrecognized key \`${key}\`.`);
    }
  }
}

/** What a wrong value is, for a message that helps rather than quotes YAML at somebody. */
function describe(value: unknown): string {
  if (value === null) return "empty";
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  if (typeof value === "string") return `the text \`${value}\``;
  // Named one at a time rather than as "whatever is left", because what is left
  // of `unknown` after the cases above still includes a function — the one thing
  // `String` renders as its own source code — and because a scalar is the only
  // kind of value worth quoting back at somebody reading a mistake in a file.
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `\`${String(value)}\``;
  }
  return "a value of a kind this file cannot hold";
}
