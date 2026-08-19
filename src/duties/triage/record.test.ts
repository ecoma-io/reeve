import { beforeEach, describe, expect, it, vi } from "vitest";

interface Payload {
  action?: string;
  sender?: { login?: string; type?: string };
  label?: { name?: string };
}

const { payload } = vi.hoisted((): { payload: Payload } => ({ payload: {} }));

vi.mock("@actions/github", () => ({ context: { payload } }));

import * as core from "@actions/core";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  info: vi.fn(),
  warning: vi.fn(),
}));

import type { ContentsApi, Location, Standing, TrackerApi } from "../../core/forge.js";
import type { Language } from "../../core/languages.js";
import { parseCorrection, type Correction } from "../../core/memory.js";
import { createWeather, type Provider } from "../../core/provider.js";
import {
  DEFAULT_PROPOSE_WORKSPACE,
  type Authority,
  type Label,
  type Warrant,
} from "../../core/warrant.js";

import type { Settings } from "./inputs.js";
import type { Stages } from "./main.js";
import {
  describeRecordOutcome,
  labelChange,
  recordCorrection,
  recordGrantedByRun,
  recordReversal,
  recordTrigger,
  senderLogin,
  type RecordOutcome,
} from "./record.js";

const AT: Location = { owner: "acme", repo: "widgets", number: 42 };

beforeEach(() => {
  delete payload.action;
  delete payload.sender;
  delete payload.label;
  delete process.env.GITHUB_EVENT_NAME;
  vi.clearAllMocks();
});

describe("recordTrigger", () => {
  it("is not eligible off any event but `issues`", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment";
    payload.action = "created";
    expect(recordTrigger()).toEqual({ eligible: false, kind: "label", reason: "" });
  });

  it("is eligible on a human reopen", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    payload.action = "reopened";
    payload.sender = { login: "maintainer" };
    expect(recordTrigger()).toEqual({ eligible: true, kind: "reopen", reason: "" });
  });

  it("refuses a bot's reopen, and says why", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    payload.action = "reopened";
    payload.sender = { login: "some-bot[bot]" };
    expect(recordTrigger()).toEqual({
      eligible: false,
      kind: "reopen",
      reason: "the reopen came from a bot",
    });
  });

  it("is eligible on a human's `labeled`", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    payload.action = "labeled";
    payload.sender = { login: "maintainer" };
    expect(recordTrigger()).toEqual({ eligible: true, kind: "label", reason: "" });
  });

  it("is eligible on a human's `unlabeled`", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    payload.action = "unlabeled";
    payload.sender = { login: "maintainer" };
    expect(recordTrigger()).toEqual({ eligible: true, kind: "label", reason: "" });
  });

  it("refuses a bot's label change, and says why", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    payload.action = "labeled";
    payload.sender = { type: "Bot", login: "renovate" };
    expect(recordTrigger()).toEqual({
      eligible: false,
      kind: "label",
      reason: "the label change came from a bot",
    });
  });

  it("is not eligible on an `issues` action it never fires on", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    payload.action = "opened";
    payload.sender = { login: "maintainer" };
    expect(recordTrigger()).toEqual({ eligible: false, kind: "label", reason: "" });
  });
});

describe("senderLogin", () => {
  it("is the triggering sender's login", () => {
    payload.sender = { login: "maintainer" };
    expect(senderLogin()).toBe("maintainer");
  });

  it("is empty when there is no sender on the payload", () => {
    expect(senderLogin()).toBe("");
  });
});

describe("labelChange", () => {
  it("is the label and action on a `labeled` event", () => {
    payload.action = "labeled";
    payload.label = { name: "bug" };
    expect(labelChange()).toEqual({ label: "bug", action: "labeled" });
  });

  it("is the label and action on an `unlabeled` event", () => {
    payload.action = "unlabeled";
    payload.label = { name: "bug" };
    expect(labelChange()).toEqual({ label: "bug", action: "unlabeled" });
  });

  it("is null on any action but `labeled`/`unlabeled`", () => {
    payload.action = "reopened";
    expect(labelChange()).toBeNull();
  });

  it("is null when the event carries no label name", () => {
    payload.action = "labeled";
    payload.label = {};
    expect(labelChange()).toBeNull();
  });
});

describe("recordGrantedByRun", () => {
  it("is true only when the warrant's grant includes `record`", () => {
    expect(recordGrantedByRun(["record"])).toBe(true);
    expect(recordGrantedByRun(["label"])).toBe(false);
    expect(recordGrantedByRun([])).toBe(false);
  });
});

function outcomeOf(over: Partial<RecordOutcome> = {}): RecordOutcome {
  return {
    recorded: true,
    language: null,
    decided: [],
    pivot: false,
    pivotNote: null,
    machineOnly: false,
    unattributable: false,
    ...over,
  };
}

describe("describeRecordOutcome", () => {
  it("names the decided labels when there are any", () => {
    expect(describeRecordOutcome(outcomeOf({ decided: ["bug", "docs"] }))).toBe(
      "recorded as `bug`, `docs`",
    );
  });

  it("says so plainly when there are none", () => {
    expect(describeRecordOutcome(outcomeOf({ decided: [] }))).toBe(
      "recorded with no taxonomy labels",
    );
  });
});

function labelOf(over: Partial<Label> = {}): Label {
  return {
    name: "bug",
    description: "Something is broken.",
    not: null,
    examples: [],
    owner: null,
    exclusiveWith: [],
    confidence: null,
    paths: [],
    create: false,
    color: null,
    ...over,
  };
}

function warrantOf(): Warrant {
  return {
    path: ".github/reeve.yml",
    labels: [],
    languages: null,
    pivot: null,
    memory: null,
    about: null,
    lifecycle: null,
    dependa: null,
    propose: DEFAULT_PROPOSE_WORKSPACE,
    granted: (_duty, fallback) => fallback,
    unnamed: () => false,
    labelNamed: () => undefined,
  };
}

function authorityOf(): Authority {
  return { warrant: warrantOf(), implicit: false, excludedLabels: [] };
}

function standingOf(over: Partial<Standing> = {}): Standing {
  return {
    title: "Dark mode setting is lost between sessions",
    body: "It resets every time I close the app.",
    labels: ["bug"],
    closed: false,
    author: { login: "reporter", isBot: false },
    milestone: null,
    assignees: [],
    createdAt: new Date(0),
    isPullRequest: false,
    ...over,
  };
}

function settingsOf(over: Partial<Settings> = {}): Settings {
  return {
    token: "stub-token",
    number: 42,
    models: ["stub-model"],
    modelNames: new Map(),
    screenModels: [],
    screenNames: new Map(),
    // Empty on purpose: `detectLanguage` and `computePivot` both short-circuit
    // without ever calling a model when the allowed-language list is empty
    // (see `detect.ts`/`resolvePivot`'s own callers), which is what lets
    // `stagesOf` below hand back throwing stubs instead of a working model.
    languages: [],
    warrant: ".github/reeve.yml",
    taxonomy: [labelOf({ name: "bug" }), labelOf({ name: "docs" })],
    confidence: 0.75,
    correctionsDir: "corrections",
    about: "",
    minBodyChars: 0,
    maxBodyChars: null,
    dryRun: false,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    sweep: false,
    since: null,
    limit: null,
    endpoints: [],
    apiKeys: [],
    requestTimeoutMs: 120_000,
    temperature: undefined,
    sweepState: "open",
    stateBranch: "",
    ...over,
  };
}

function throwingProvider(): Provider {
  return {
    complete: () => {
      throw new Error(
        "not used by record.test.ts — settings.languages is empty, so neither " +
          "detectLanguage nor computePivot ever reaches a model",
      );
    },
  };
}

function stagesOf(): Stages {
  const provider = throwingProvider();
  return { detect: provider, screen: provider, triage: provider, pivot: provider };
}

/** A pivot provider that always answers with `rendered`, whatever model or messages it is asked. */
function pivotProvider(rendered: { readonly title: string; readonly body: string }): Provider {
  return {
    complete: () =>
      Promise.resolve({
        ok: true,
        model: "stub-model",
        content: JSON.stringify(rendered),
        finishReason: null,
      }),
  };
}

/** A pivot provider that always fails — every model in the rotation starved. */
function starvedPivotProvider(): Provider {
  return {
    complete: () =>
      Promise.resolve({
        ok: false,
        model: "stub-model",
        reason: "quota exceeded",
        kind: "capacity",
      }),
  };
}

const WEATHER = createWeather();

function notFoundError(): { status: number } & Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

interface Write {
  readonly path: string;
  readonly content: string;
  readonly branch: string | undefined;
}

/** One page of `listEvents`, shaped the way `listLabelEvents` reads it. */
interface EventPage {
  readonly event?: string;
  readonly label?: { name?: string };
  readonly actor?: { login?: string; type?: string } | null;
}

/**
 * A writable, in-memory `TrackerApi & ContentsApi` — `files` seeds the
 * corrections store the way `store.test.ts`'s own `contentsOf` does, and
 * `eventPages` seeds one page of `listEvents` per entry, so `listLabelEvents`
 * (called both by the sweep guard and by `removedByAutomation`) reads however
 * many pages a test hands it before `complete` answers.
 *
 * Every method neither `recordCorrection` nor `recordReversal` calls throws —
 * the same hand-built-stub idiom `outcome.test.ts`/`store.test.ts` already use.
 */
function apiOf(
  options: {
    readonly files?: Record<string, string>;
    readonly eventPages?: readonly (readonly EventPage[])[];
  } = {},
): { readonly api: TrackerApi & ContentsApi; readonly writes: Write[] } {
  const { files = {}, eventPages = [[]] } = options;
  const state = new Map(Object.entries(files));
  const writes: Write[] = [];

  const api: TrackerApi & ContentsApi = {
    rest: {
      issues: {
        get: () => {
          throw new Error("not used by record.test.ts");
        },
        update: () => {
          throw new Error("not used by record.test.ts");
        },
        addLabels: () => {
          throw new Error("not used by record.test.ts");
        },
        removeLabel: () => {
          throw new Error("not used by record.test.ts");
        },
        createLabel: () => {
          throw new Error("not used by record.test.ts");
        },
        createComment: () => {
          throw new Error("not used by record.test.ts");
        },
        addAssignees: () => {
          throw new Error("not used by record.test.ts");
        },
        listLabelsForRepo: () => {
          throw new Error("not used by record.test.ts");
        },
        listForRepo: () => {
          throw new Error("not used by record.test.ts");
        },
        listEvents: ({ page }: { page?: number }) =>
          Promise.resolve({ data: [...(eventPages[(page ?? 1) - 1] ?? [])] }),
      },
      repos: {
        getCollaboratorPermissionLevel: () => {
          throw new Error("not used by record.test.ts");
        },
        getContent: ({ path }: { path: string }) => {
          if (state.has(path)) {
            const content = state.get(path) ?? "";
            return Promise.resolve({
              data: {
                sha: `sha-${path}`,
                content: Buffer.from(content, "utf8").toString("base64"),
                encoding: "base64",
              },
            });
          }
          const prefix = `${path.replace(/\/+$/, "")}/`;
          const children = [...state.keys()].filter((entry) => entry.startsWith(prefix));
          if (children.length > 0) {
            return Promise.resolve({
              data: children.map((entry) => ({
                name: entry.slice(prefix.length),
                path: entry,
                sha: `sha-${entry}`,
              })),
            });
          }
          return Promise.reject(notFoundError());
        },
        createOrUpdateFileContents: (params: {
          path: string;
          content: string;
          branch?: string;
        }) => {
          const content = Buffer.from(params.content, "base64").toString("utf8");
          state.set(params.path, content);
          writes.push({ path: params.path, content, branch: params.branch });
          return Promise.resolve(undefined);
        },
      },
    },
  };

  return { api, writes };
}

/** A full (100-entry) page of events `listLabelEvents` skips over — every one an unrelated action. */
function fullFillerPage(): readonly EventPage[] {
  return Array.from({ length: 100 }, () => ({ event: "commented" }));
}

function writtenCorrection(writes: readonly Write[]): Correction {
  expect(writes).toHaveLength(1);
  const lines = (writes[0]?.content ?? "").trim().split("\n");
  expect(lines).toHaveLength(1);
  const correction = parseCorrection(lines[0] ?? "");
  expect(correction).not.toBeNull();
  return correction!;
}

describe("recordCorrection", () => {
  it("records the thread's taxonomy-filtered standing labels", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug", "not-in-taxonomy"] });

    const outcome = await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
    );

    expect(outcome).toEqual(
      outcomeOf({ recorded: true, language: null, decided: ["bug"], pivot: false }),
    );
    const correction = writtenCorrection(writes);
    expect(correction.repo).toBe("acme/widgets");
    expect(correction.thread).toBe(42);
    expect(correction.duty).toBe("triage");
    expect(correction.decided).toEqual(["bug"]);
    expect(correction.by).toBe("maintainer");
    expect(correction.proposed).toEqual([]);
    expect(correction.outcome).toBeNull();
    expect(correction.duplicateOf).toBeNull();
    expect(correction.pivot).toBeNull();
  });

  it("does not write anything on a dry run, but still reports what it would have recorded", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug"] });

    const outcome = await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf({ dryRun: true }),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
    );

    expect(outcome).toEqual(outcomeOf({ recorded: true, decided: ["bug"] }));
    expect(writes).toHaveLength(0);
    expect(core.info).toHaveBeenCalledWith("Would record #42 as bug — dry run, nothing committed.");
  });

  it("says `no labels` in the dry-run log when nothing was decided", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: [] });

    await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf({ dryRun: true }),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
    );

    expect(writes).toHaveLength(0);
    expect(core.info).toHaveBeenCalledWith(
      "Would record #42 as no labels — dry run, nothing committed.",
    );
  });

  it("notes a pivot rendering in the dry-run log when one was produced", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({
      title: "Dark mode setting is lost between sessions",
      body: "It resets every time I close the app, which is annoying for daily use.",
      labels: ["bug"],
    });
    const languages: readonly Language[] = [
      { code: "en", label: "English", scripts: ["Latin"] },
      { code: "zh", label: "Chinese", scripts: ["Han"] },
    ];
    const stages: Stages = {
      ...stagesOf(),
      pivot: pivotProvider({
        title: "深色模式设置在会话之间丢失",
        body: "每次关闭应用时都会重置。",
      }),
    };
    const authority: Authority = {
      warrant: { ...warrantOf(), pivot: "zh" },
      implicit: false,
      excludedLabels: [],
    };

    await recordCorrection(
      api,
      AT,
      standing,
      authority,
      settingsOf({ dryRun: true, languages }),
      stages,
      WEATHER,
      "maintainer",
      null,
    );

    expect(writes).toHaveLength(0);
    expect(core.info).toHaveBeenCalledWith(
      "Would record #42 as bug, with a pivot rendering — dry run, nothing committed.",
    );
  });

  it("computes proposed as the honest before/after delta on a single-thread `labeled` event", async () => {
    const { api, writes } = apiOf();
    // The event already landed on the thread by the time this reads it — `bug`
    // is standing now, so `proposed` is what stood a moment before: without it.
    const standing = standingOf({ labels: ["bug"] });

    const outcome = await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      { label: "bug", action: "labeled" },
    );

    expect(outcome.decided).toEqual(["bug"]);
    const correction = writtenCorrection(writes);
    expect(correction.proposed).toEqual([]);
  });

  it("computes proposed on an `unlabeled` event, adding the removed label back to the before-set", async () => {
    const { api, writes } = apiOf({
      eventPages: [[{ event: "labeled", label: { name: "bug" }, actor: { login: "maintainer" } }]],
    });
    const standing = standingOf({ labels: [] });

    const outcome = await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      { label: "bug", action: "unlabeled" },
    );

    expect(outcome.decided).toEqual([]);
    const correction = writtenCorrection(writes);
    expect(correction.proposed).toEqual(["bug"]);
    // A human applied `bug` last, per the event history above — not automation.
    expect(correction.outcome).toBeNull();
  });

  it("marks an unlabeled taxonomy label `overruled` when Reeve's own run applied it last", async () => {
    const { api, writes } = apiOf({
      eventPages: [
        [{ event: "labeled", label: { name: "bug" }, actor: { login: "reeve-bot", type: "Bot" } }],
      ],
    });
    const standing = standingOf({ labels: [] });

    await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      { label: "bug", action: "unlabeled" },
    );

    const correction = writtenCorrection(writes);
    expect(correction.outcome).toBe("overruled");
  });

  it("ignores a labelChange naming a label outside the taxonomy", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug"] });

    await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      { label: "not-in-taxonomy", action: "labeled" },
    );

    const correction = writtenCorrection(writes);
    expect(correction.proposed).toEqual([]);
  });

  describe('bulk migration (`by === "sweep"`)', () => {
    it("imports every taxonomy label a complete history shows a human applied", async () => {
      const { api, writes } = apiOf({
        eventPages: [
          [{ event: "labeled", label: { name: "bug" }, actor: { login: "maintainer" } }],
        ],
      });
      const standing = standingOf({ labels: ["bug"] });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        null,
      );

      expect(outcome).toEqual(outcomeOf({ decided: ["bug"] }));
      const correction = writtenCorrection(writes);
      expect(correction.by).toBe("sweep");
      expect(correction.decided).toEqual(["bug"]);
    });

    it("filters out a taxonomy label whose most recent `labeled` event was a bot's", async () => {
      const { api, writes } = apiOf({
        eventPages: [
          [
            {
              event: "labeled",
              label: { name: "bug" },
              actor: { login: "reeve-bot", type: "Bot" },
            },
            { event: "labeled", label: { name: "docs" }, actor: { login: "maintainer" } },
          ],
        ],
      });
      const standing = standingOf({ labels: ["bug", "docs"] });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        null,
      );

      expect(outcome.decided).toEqual(["docs"]);
      const correction = writtenCorrection(writes);
      expect(correction.decided).toEqual(["docs"]);
    });

    it("records nothing, and says why, when every taxonomy label here was machine-applied", async () => {
      const { api, writes } = apiOf({
        eventPages: [
          [
            {
              event: "labeled",
              label: { name: "bug" },
              actor: { login: "reeve-bot", type: "Bot" },
            },
          ],
        ],
      });
      const standing = standingOf({ labels: ["bug"] });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        null,
      );

      expect(outcome).toEqual(
        outcomeOf({ recorded: false, decided: [], machineOnly: true, unattributable: false }),
      );
      expect(writes).toHaveLength(0);
      expect(core.info).toHaveBeenCalledWith(
        "#42: every taxonomy label here was machine-applied — nothing to import.",
      );
    });

    it("imports a label whose only event is `unlabeled` — no `labeled` event to distrust", async () => {
      // The self-training guard only ever excludes a label on the strength of
      // its own most recent `labeled` event's actor — a label with no
      // `labeled` event at all in what this run read has nothing to distrust,
      // and `?? false` (record.ts) reads that absence as "not a bot" rather
      // than fail closed the way an incomplete history does.
      const { api, writes } = apiOf({
        eventPages: [
          [{ event: "unlabeled", label: { name: "bug" }, actor: { login: "maintainer" } }],
        ],
      });
      const standing = standingOf({ labels: ["bug"] });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        null,
      );

      expect(outcome).toEqual(outcomeOf({ decided: ["bug"] }));
      const correction = writtenCorrection(writes);
      expect(correction.decided).toEqual(["bug"]);
    });

    it("imports a standing taxonomy label whose history carries no `labeled` event at all", async () => {
      const { api, writes } = apiOf({ eventPages: [[{ event: "commented" }]] });
      const standing = standingOf({ labels: ["bug"] });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        null,
      );

      expect(outcome).toEqual(outcomeOf({ decided: ["bug"] }));
      const correction = writtenCorrection(writes);
      expect(correction.decided).toEqual(["bug"]);
    });

    it("records nothing, and says why, when the label history is longer than one run reads", async () => {
      const pages = Array.from({ length: 10 }, () => fullFillerPage());
      const { api, writes } = apiOf({ eventPages: pages });
      const standing = standingOf({ labels: ["bug"] });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        null,
      );

      expect(outcome).toEqual(
        outcomeOf({ recorded: false, decided: [], machineOnly: false, unattributable: true }),
      );
      expect(writes).toHaveLength(0);
      expect(core.info).toHaveBeenCalledWith(
        "#42: label history is longer than one run reads — cannot attribute, nothing imported.",
      );
    });

    it("never reads label history at all when the thread carries no taxonomy label", async () => {
      const { api, writes } = apiOf();
      const standing = standingOf({ labels: [] });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        null,
      );

      expect(outcome).toEqual(outcomeOf({ decided: [] }));
      expect(writes).toHaveLength(1);
    });

    it("computes no proposed delta on a sweep, even when a labelChange is passed", async () => {
      const { api, writes } = apiOf({
        eventPages: [
          [{ event: "labeled", label: { name: "bug" }, actor: { login: "maintainer" } }],
        ],
      });
      const standing = standingOf({ labels: ["bug"] });

      await recordCorrection(
        api,
        AT,
        standing,
        authorityOf(),
        settingsOf(),
        stagesOf(),
        WEATHER,
        "sweep",
        { label: "bug", action: "labeled" },
      );

      const correction = writtenCorrection(writes);
      expect(correction.proposed).toEqual([]);
    });
  });

  it("truncates the body against `maxBodyChars` before recording it", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ body: "0123456789", labels: [] });

    await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf({ maxBodyChars: 4 }),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
    );

    const correction = writtenCorrection(writes);
    expect(correction.excerpt).toBe("0123");
  });

  describe("pivot rendering", () => {
    // Distinct scripts so `detectLanguage` decides at step 2 (script) alone —
    // one candidate's script present, the other's absent — without ever
    // reaching the model `pick` step, which is what lets `stages.detect` stay
    // a throwing stub even in these two tests.
    const languages: readonly Language[] = [
      { code: "en", label: "English", scripts: ["Latin"] },
      { code: "zh", label: "Chinese", scripts: ["Han"] },
    ];

    function authorityWithPivot(pivot: string): Authority {
      return { warrant: { ...warrantOf(), pivot }, implicit: false, excludedLabels: [] };
    }

    it("renders a pivot translation when the detected language differs from the pivot language", async () => {
      const { api, writes } = apiOf();
      const standing = standingOf({
        title: "Dark mode setting is lost between sessions",
        body: "It resets every time I close the app, which is annoying for daily use.",
        labels: ["bug"],
      });
      const stages: Stages = {
        ...stagesOf(),
        pivot: pivotProvider({
          title: "深色模式设置在会话之间丢失",
          body: "每次关闭应用时都会重置。",
        }),
      };

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityWithPivot("zh"),
        settingsOf({ languages }),
        stages,
        WEATHER,
        "maintainer",
        null,
      );

      expect(outcome.pivot).toBe(true);
      expect(outcome.pivotNote).toBeNull();
      const correction = writtenCorrection(writes);
      expect(correction.language).toBe("en");
      expect(correction.pivot).toEqual({
        language: "zh",
        title: "深色模式设置在会话之间丢失",
        excerpt: "每次关闭应用时都会重置。",
      });
    });

    it("records without a pivot, and notes why, when the pivot rendering could not be produced", async () => {
      const { api, writes } = apiOf();
      const standing = standingOf({
        title: "Dark mode setting is lost between sessions",
        body: "It resets every time I close the app.",
        labels: ["bug"],
      });
      const stages: Stages = { ...stagesOf(), pivot: starvedPivotProvider() };

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityWithPivot("zh"),
        settingsOf({ languages }),
        stages,
        WEATHER,
        "maintainer",
        null,
      );

      expect(outcome.pivot).toBe(false);
      expect(outcome.pivotNote).toBe(
        "A pivot-language rendering could not be produced this run, so the correction was " +
          "recorded without one.",
      );
      const correction = writtenCorrection(writes);
      expect(correction.pivot).toBeNull();
    });

    it("renders no pivot at all when the pivot language is the detected language", async () => {
      const { api, writes } = apiOf();
      const standing = standingOf({
        title: "Dark mode setting is lost between sessions",
        body: "It resets every time I close the app.",
        labels: ["bug"],
      });

      const outcome = await recordCorrection(
        api,
        AT,
        standing,
        authorityWithPivot("en"),
        settingsOf({ languages }),
        stagesOf(),
        WEATHER,
        "maintainer",
        null,
      );

      expect(outcome.pivot).toBe(false);
      expect(outcome.pivotNote).toBeNull();
      const correction = writtenCorrection(writes);
      expect(correction.pivot).toBeNull();
    });
  });
});

describe("recordReversal", () => {
  it('records a reversal under `duty: "duplicate"`, `outcome: "overruled"`', async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug"] });

    const outcome = await recordReversal(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      7,
    );

    expect(outcome).toEqual(outcomeOf({ decided: ["bug"] }));
    const correction = writtenCorrection(writes);
    expect(correction.duty).toBe("duplicate");
    expect(correction.outcome).toBe("overruled");
    expect(correction.duplicateOf).toBe(7);
    expect(correction.proposed).toEqual([]);
  });

  it("does not write anything on a dry run", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug"] });

    const outcome = await recordReversal(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf({ dryRun: true }),
      stagesOf(),
      WEATHER,
      "maintainer",
      7,
    );

    expect(outcome.recorded).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("passes stateBranch to writeCorrection", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug"] });
    const branch = "reeve/corrections";

    await recordReversal(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      7,
      branch,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.branch).toBe(branch);
  });
});

describe("DETERMIN-05 — the recorded `at` comes from an injectable clock", () => {
  const FIXED = () => new Date("2026-01-02T03:04:05.000Z");
  const OTHER = () => new Date("2026-06-07T08:09:10.000Z");

  it("writes byte-identical store lines for identical inputs with the same clock", async () => {
    const { api, writes } = apiOf();
    await recordCorrection(
      api,
      AT,
      standingOf({ labels: ["bug"] }),
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
      undefined,
      FIXED,
    );
    const first = writes[0]?.content;

    const { api: api2, writes: writes2 } = apiOf();
    await recordCorrection(
      api2,
      AT,
      standingOf({ labels: ["bug"] }),
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
      undefined,
      FIXED,
    );
    expect(writes2[0]?.content).toBe(first);
    expect(parseCorrection(first ?? "")?.at).toBe("2026-01-02T03:04:05.000Z");
  });

  it("records the reversal at the injected clock too", async () => {
    const { api, writes } = apiOf();
    await recordReversal(
      api,
      AT,
      standingOf({ labels: ["bug"] }),
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      7,
      undefined,
      OTHER,
    );
    expect(writes[0]?.content ?? "").toContain('"at":"2026-06-07T08:09:10.000Z"');
  });

  it("differs only in `at` when the clock differs — everything else stays put", async () => {
    const { api, writes } = apiOf();
    await recordCorrection(
      api,
      AT,
      standingOf({ labels: ["bug"] }),
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
      undefined,
      FIXED,
    );
    await recordCorrection(
      api,
      AT,
      standingOf({ labels: ["bug"] }),
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
      undefined,
      OTHER,
    );
    expect(writes).toHaveLength(2);
    const a = writes[0]?.content ?? "";
    const b = writes[1]?.content ?? "";
    expect(a).not.toBe(b);
    // The only differing field is the timestamp the correction carries.
    expect(a.replace('"at":"2026-01-02T03:04:05.000Z"', '"at":"X"')).toBe(
      b.replace('"at":"2026-06-07T08:09:10.000Z"', '"at":"X"'),
    );
  });
});

describe("recordCorrection with stateBranch", () => {
  it("passes stateBranch to writeCorrection", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug"] });
    const branch = "reeve/corrections";

    await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
      branch,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.branch).toBe(branch);
  });

  it("does not pass a branch when stateBranch is omitted", async () => {
    const { api, writes } = apiOf();
    const standing = standingOf({ labels: ["bug"] });

    await recordCorrection(
      api,
      AT,
      standing,
      authorityOf(),
      settingsOf(),
      stagesOf(),
      WEATHER,
      "maintainer",
      null,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.branch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A6 — which roster the pivot rendering is bought from.
//
// `computePivot` picks `screenModels` when one is configured and falls back to
// `models` when it is not (`record.ts:177-178`) — the same rule `core/recall.ts:198`
// and `triage/main.ts:911` each write out by hand. Only recall's copy was
// pinned: every case above hands `settingsOf` an empty `screenModels`, so this
// copy's first arm could not be taken and a change that spent the expensive
// roster on the cheap job would have gone out green.
//
// Both arms are asserted by the models the pivot provider was actually asked,
// never by reading the settings back.
// ---------------------------------------------------------------------------

/** A pivot provider that records which models it was asked, in order. */
function recordingPivotProvider(rendered: { readonly title: string; readonly body: string }): {
  provider: Provider;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    provider: {
      complete: (model: string) => {
        asked.push(model);
        return Promise.resolve({
          ok: true as const,
          model,
          content: JSON.stringify(rendered),
          finishReason: null,
        });
      },
    },
  };
}

/** The two languages a pivot needs: the thread's own, and one to pivot into. */
const PIVOT_LANGUAGES: readonly Language[] = [
  { code: "en", label: "English", scripts: ["Latin"] },
  { code: "zh", label: "Chinese", scripts: ["Han"] },
];

/** Everything a pivot-rendering case needs, minus the roster it is asking about. */
async function recordWithPivot(
  rosters: Pick<Settings, "models" | "screenModels">,
): Promise<string[]> {
  const { api } = apiOf();
  const { provider, asked } = recordingPivotProvider({
    title: "深色模式设置在会话之间丢失",
    body: "每次关闭应用时都会重置。",
  });

  await recordCorrection(
    api,
    AT,
    standingOf({
      title: "Dark mode setting is lost between sessions",
      body: "It resets every time I close the app, which is annoying for daily use.",
      labels: ["bug"],
    }),
    {
      warrant: { ...warrantOf(), pivot: "zh" },
      implicit: false,
      excludedLabels: [],
    },
    settingsOf({ languages: PIVOT_LANGUAGES, ...rosters }),
    { ...stagesOf(), pivot: provider },
    createWeather(),
    "maintainer",
    null,
  );

  return asked;
}

describe("the roster the pivot rendering is bought from", () => {
  it("pays_the_cheap_screen_roster_when_one_is_configured", async () => {
    // The pivot is a cheap job — a title and a body rendered into one other
    // language for the corrections store. A repository that configured
    // `screen-models` did so to keep exactly this kind of work off the
    // expensive roster.
    const asked = await recordWithPivot({ models: ["expensive"], screenModels: ["cheap"] });

    expect(asked).toEqual(["cheap"]);
    expect(asked).not.toContain("expensive");
  });

  it("falls_back_to_the_main_roster_when_no_cheap_roster_is_configured", async () => {
    // The documented default rather than a degraded mode: an unset
    // `screen-models` means "use the one roster there is", not "skip the
    // pivot".
    const asked = await recordWithPivot({ models: ["expensive"], screenModels: [] });

    expect(asked).toEqual(["expensive"]);
  });

  it("rotates_the_cheap_roster_rather_than_locking_onto_its_first_entry", async () => {
    const { api } = apiOf();
    const asked: string[] = [];
    const provider: Provider = {
      complete: (model: string) => {
        asked.push(model);
        return Promise.resolve(
          model === "cheap-b"
            ? {
                ok: true as const,
                model,
                content: JSON.stringify({ title: "深色模式", body: "会重置。" }),
                finishReason: null,
              }
            : { ok: false as const, model, reason: "HTTP 500", kind: "capacity" as const },
        );
      },
    };

    await recordCorrection(
      api,
      AT,
      standingOf({
        title: "Dark mode setting is lost between sessions",
        body: "It resets every time I close the app, which is annoying for daily use.",
        labels: ["bug"],
      }),
      { warrant: { ...warrantOf(), pivot: "zh" }, implicit: false, excludedLabels: [] },
      settingsOf({
        languages: PIVOT_LANGUAGES,
        models: ["expensive"],
        screenModels: ["cheap-a", "cheap-b"],
      }),
      { ...stagesOf(), pivot: provider },
      createWeather(),
      "maintainer",
      null,
    );

    // The whole cheap roster in order, and the expensive one still untouched:
    // a cheap model being out of room is not a reason to reach for the
    // expensive list.
    expect(asked).toEqual(["cheap-a", "cheap-b"]);
    expect(asked).not.toContain("expensive");
  });
});
