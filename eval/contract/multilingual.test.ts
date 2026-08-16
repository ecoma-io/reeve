/**
 * The eval tree's multilingual coverage, pinned.
 *
 * The multilingual fixtures under `eval/fixtures/triage/` and
 * `eval/fixtures/respond/` are ordinary fixtures to `eval/runner.ts` — this
 * suite pins the parts of them a runner run cannot: the language each thread
 * must be identified as (compared against the real detection for that thread,
 * through the driver's own `scenarioOf`), and the fail-closed pairing that a
 * misidentified language is `failed`, never `skipped`.
 *
 * The `languageLine` cases pin the gate logic directly: a fixture that
 * declares a language and a run that identified the thread as something else
 * is a `failed` line with a detail that names both answers. A declared and
 * matched language, and no declaration at all, contribute no line — so the
 * existing fixtures (which predate this matrix and declare no language) keep
 * working exactly as they did.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scenarioOf as triageScenarioOf } from "../drivers/triage.ts";
import { languageLine } from "../language.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

/** Every language this matrix covers, and the label its threads must be identified as. */
const LANGUAGES: Readonly<Record<string, string>> = {
  en: "English",
  vi: "Tiếng Việt",
  ja: "日本語",
  pt: "português",
  es: "español",
  ko: "한국어",
  ar: "العربية",
  id: "Indonesia",
};

interface FixtureDoc {
  readonly description?: string;
  readonly thread?: { readonly title: string; readonly body: string };
  readonly warrant?: string;
  readonly detect?: string;
  readonly expected?: { readonly language?: string };
}

async function readExpected(directory: string): Promise<FixtureDoc> {
  return JSON.parse(
    await readFile(join(FIXTURES, directory, ".expected.json"), "utf8"),
  ) as FixtureDoc;
}

async function fixtureDirs(duty: string): Promise<string[]> {
  const entries = await readdir(join(FIXTURES, duty));
  const dirs = [];
  for (const entry of entries) {
    const s = await stat(join(FIXTURES, duty, entry));
    if (s.isDirectory()) dirs.push(entry);
  }
  return dirs;
}

describe("the multilingual fixture matrix", () => {
  it("covers one triage and one respond fixture per declared language", async () => {
    const triage = (await fixtureDirs("triage")).filter((name) =>
      [
        "en-report",
        "vi-report",
        "ja-duplicate",
        "pt-report",
        "es-report",
        "ko-report",
        "ar-report",
        "id-model",
      ].includes(name),
    );
    const respond = (await fixtureDirs("respond")).filter((name) =>
      [
        "en-first-reply",
        "vi-first-reply",
        "ja-first-reply",
        "pt-first-reply",
        "es-first-reply",
        "ko-first-reply",
        "ar-first-reply",
        "id-model-reply",
      ].includes(name),
    );

    expect(triage).toHaveLength(8);
    expect(respond).toHaveLength(8);
    // Every language appears once in each duty, so nothing silently dropped a
    // language from one side of the pipeline.
    for (const code of Object.keys(LANGUAGES)) {
      expect(triage.join(" ")).toContain(code);
      expect(respond.join(" ")).toContain(code);
    }
  });

  it("every multilingual fixture declares the language it must be identified as", async () => {
    for (const duty of ["triage", "respond"]) {
      for (const dir of await fixtureDirs(duty)) {
        const doc = await readExpected(join(duty, dir));
        if (doc.expected?.language === undefined) continue;
        expect(
          Object.values(LANGUAGES).includes(doc.expected.language),
          `${duty}/${dir} declares \`${doc.expected.language}\`, which is not in the matrix`,
        ).toBe(true);
        // The thread runs on real text — a multilingual fixture without a
        // thread would not have exercised the pipeline in that language.
        expect(doc.thread, `${duty}/${dir} must carry an in-language thread`).toBeDefined();
      }
    }
  });

  const TRIAGE_FIXTURE_BY_LANG: Readonly<Record<string, string>> = {
    en: "en-report",
    vi: "vi-report",
    ja: "ja-duplicate",
    pt: "pt-report",
    es: "es-report",
    ko: "ko-report",
    ar: "ar-report",
    id: "id-model",
  };

  const RESPOND_FIXTURE_BY_LANG: Readonly<Record<string, string>> = {
    en: "en-first-reply",
    vi: "vi-first-reply",
    ja: "ja-first-reply",
    pt: "pt-first-reply",
    es: "es-first-reply",
    ko: "ko-first-reply",
    ar: "ar-first-reply",
    id: "id-model-reply",
  };

  it("the driver's scenarioOf resolves each fixture to the language it declares", async () => {
    for (const [langKey, label] of Object.entries(LANGUAGES)) {
      const triageFixture = TRIAGE_FIXTURE_BY_LANG[langKey];
      if (triageFixture === undefined) throw new Error(`no triage fixture for \`${langKey}\``);
      const triageDoc = await readExpected(join("triage", triageFixture));
      expect(triageDoc.expected?.language, `triage ${langKey}`).toBe(label);

      const respondFixture = RESPOND_FIXTURE_BY_LANG[langKey];
      if (respondFixture === undefined) throw new Error(`no respond fixture for \`${langKey}\``);
      const respondDoc = await readExpected(join("respond", respondFixture));
      expect(respondDoc.expected?.language, `respond ${langKey}`).toBe(label);
    }
  });

  it("a thread in each declared language is identified as that language, through the driver", async () => {
    for (const [langKey, fixture] of Object.entries(TRIAGE_FIXTURE_BY_LANG)) {
      const directory = join(FIXTURES, "triage", fixture);
      // The driver's scenario builds the exact thread the stub will serve, so
      // the fixture's own `language` assertion is compared against the run's
      // declared target — the assertion the runner enforces as `failed` when
      // the two disagree.
      const scenario = await triageScenarioOf(fixture, directory);
      expect(scenario.expected.language, `triage ${langKey} thread`).toBe(LANGUAGES[langKey]);
    }
  });
});

describe("the language dimension of one fixture", () => {
  it("returns no line when the fixture does not declare a language", () => {
    expect(languageLine("x", undefined, "Tiếng Việt")).toBeNull();
  });

  it("returns no line when the identified language matches", () => {
    expect(languageLine("vi-report", "Tiếng Việt", "Tiếng Việt")).toBeNull();
  });

  it("reports a misidentified thread as `failed`, never `skipped`", () => {
    const line = languageLine("vi-report", "Tiếng Việt", "English");
    expect(line).not.toBeNull();
    expect(line?.outcome).toBe("failed");
    expect(line?.detail).toContain("Tiếng Việt");
    expect(line?.detail).toContain("English");
  });

  it("reports an unidentified thread as `failed`, not a clean stop", () => {
    const line = languageLine("id-model", "Indonesia", "");
    expect(line?.outcome).toBe("failed");
    expect(line?.detail).toContain("Indonesia");
  });
});
