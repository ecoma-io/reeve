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

import { parse, YAMLParseError } from "yaml";

/** What a duty may do to a thread. The closed set; a name outside it is refused. */
export type Capability = "label" | "edit-body" | "comment" | "close" | "assign";

export const CAPABILITIES: readonly Capability[] = [
  "label",
  "edit-body",
  "comment",
  "close",
  "assign",
];

/** The only version this reader understands. */
const VERSION = 1;

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
}

/** The parsed file, and the questions the rest of Reeve is allowed to ask it. */
export interface Warrant {
  /** Where it was read from, so every message about it can name the file. */
  readonly path: string;
  /** The taxonomy, in the order it was written. That order reaches the prompt. */
  readonly labels: readonly Label[];
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
 */
export function checkLabelsExist(warrant: Warrant, existing: readonly string[]): void {
  const present = new Set(existing);
  const missing = warrant.labels.map((label) => label.name).filter((name) => !present.has(name));
  if (missing.length === 0) return;

  // Every missing name at once. Reporting the first would make fixing a
  // three-label rename three failed runs.
  throw new Error(
    `warrant: \`${warrant.path}\` names ${missing.length === 1 ? "a label" : "labels"} ` +
      `this repository does not have — ${missing.map((name) => `\`${name}\``).join(", ")}. ` +
      "Create them, or correct the taxonomy.",
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
    });
  }

  const byName = new Map(labels.map((label) => [label.name, label]));

  return {
    warrant: {
      path,
      labels,
      granted: (_duty, fallback) => fallback,
      unnamed: () => false,
      labelNamed: (name) => byName.get(name),
    },
    excluded,
  };
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
    });
  }

  return labels;
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
  if (raw === undefined || raw === null) return { declared: false, granted };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `warrant: \`${path}\` has \`capabilities\` as ${describe(raw)}, ` +
        "expected a mapping of duty to what it may do.",
    );
  }

  for (const [duty, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `\`${path}\` capabilities for \`${duty}\``;
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
