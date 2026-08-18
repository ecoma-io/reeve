import { describe, expect, it, vi } from "vitest";

import type { Provider } from "./provider.js";
import { createLanguagePicker, detectLanguage } from "./detect.js";
import type { LanguagePicker } from "./detect.js";
import type { Language } from "./languages.js";

// Every configured script counts as present, so the candidate set is decided
// only by the languages handed in — the profile step for an UNPROFILED code
// cannot answer and the picker is consulted.
vi.mock("./script.js", () => ({
  containsScript: vi.fn(() => true),
}));

// Contract: the picker that triage builds for language detection (and its
// empty-cheap-roster fallback at triage/main.ts:911) is a rotation, never
// models[0] - every configured model gets its turn in order, and an exhausted
// roster returns null (a detection nobody reached) rather than a wrong answer
// or a crash. (matrix GAP 1: triage/main.ts:911)

const LANGUAGES: Language[] = [
  { code: "en", label: "English", scripts: ["Latin"] },
  { code: "vi", label: "Vietnamese", scripts: ["Latin"] },
];

// Reserved codes the bundled profile data does not cover, so the profile step
// cannot answer and the picker is genuinely consulted.
const UNPROFILED: Language[] = [
  { code: "qaa", label: "Reserved A", scripts: ["Latin"] },
  { code: "qab", label: "Reserved B", scripts: ["Latin"] },
];

function providerFor(content: (text: string) => string): Provider {
  return {
    complete: vi.fn((_model: string, request: unknown) =>
      Promise.resolve({
        ok: true,
        model: _model,
        content: content(JSON.stringify(request)),
        finishReason: "stop",
      }),
    ),
  } as unknown as Provider;
}

describe("createLanguagePicker contract", () => {
  it("the picker with an explicit roster is a rotation that never locks onto the first model", async () => {
    const provider = providerFor(() => "vi");
    const picker: LanguagePicker = createLanguagePicker(provider, ["paid-a", "paid-b"]);

    const picked = await picker("một hai ba", LANGUAGES);

    expect(picked).toBe("vi");
    // First usable answer stops the rotation - but the FIRST model is never
    // the only one tried; see the next test where it fails.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(provider.complete).mock.calls.map(([model]) => model);
    expect(calls[0]).toBe("paid-a");
  });

  it("a first-model failure falls back to the next model in the roster", async () => {
    const provider: Provider = {
      complete: vi
        .fn<(model: string) => Promise<unknown>>()
        .mockImplementationOnce(() =>
          Promise.resolve({ ok: false, model: "paid-a", reason: "quota" }),
        )
        .mockImplementationOnce(() =>
          Promise.resolve({ ok: true, model: "paid-b", content: "vi", finishReason: "stop" }),
        ),
    } as unknown as Provider;

    const picker: LanguagePicker = createLanguagePicker(provider, ["paid-a", "paid-b"]);
    const picked = await picker("a b c", LANGUAGES);

    expect(picked).toBe("vi");
    expect(vi.mocked(provider.complete)).toHaveBeenCalledTimes(2);
    const tried = vi.mocked(provider.complete).mock.calls.map(([model]) => model);
    expect(tried).toEqual(["paid-a", "paid-b"]);
  });

  it("an exhausted full roster returns null — a detection nobody reached, not a guessed language", async () => {
    const provider: Provider = {
      complete: vi.fn<(model: string) => Promise<unknown>>().mockResolvedValue({
        ok: false,
        model: "paid-a",
        reason: "quota",
      }),
    } as unknown as Provider;

    const picker: LanguagePicker = createLanguagePicker(provider, ["paid-a", "paid-b"]);
    const picked = await picker("a b c", LANGUAGES);

    expect(picked).toBeNull();
    expect(vi.mocked(provider.complete).mock.calls.map(([model]) => model)).toEqual([
      "paid-a",
      "paid-b",
    ]);
  });

  it("detectLanguage with a picker that answers nothing yields language:null, by:none", async () => {
    const picker: LanguagePicker = () => Promise.resolve(null);
    // Unprofiled candidates force the picker to be consulted; a picker that
    // declines must land on "none", never a guessed language.
    const detection = await detectLanguage("some text", UNPROFILED, picker);

    expect(detection.language).toBeNull();
    expect(detection.by).toBe("none");
  });
});
