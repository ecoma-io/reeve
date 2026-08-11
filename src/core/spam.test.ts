import { describe, expect, it, vi } from "vitest";

import type { Completion, Provider } from "./provider.js";

import { sift, type SiftRequest } from "./spam.js";

// Every case below is about the asymmetry this stage is built on: passing junk
// through costs one expensive request, and dropping a real report costs a
// contributor the answer they came for. So the interesting tests are the ones
// where something went wrong, and all of them expect the run to carry on.

function answering(answers: Record<string, string>): Provider {
  return {
    complete: vi.fn((model: string): Promise<Completion> => {
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({
          ok: false,
          model,
          reason: "not configured in this case",
          kind: "protocol",
        });
      }
      return Promise.resolve({ ok: true, model, content: answer, finishReason: "stop" });
    }),
  };
}

function request(over: Partial<SiftRequest> = {}): SiftRequest {
  return {
    provider: answering({}),
    models: ["cheap"],
    title: "Crash on save",
    body: "It throws when I press save.",
    about: "",
    ...over,
  };
}

describe("sift", () => {
  it("drops a thread the cheap pass read as spam", async () => {
    const sifted = await sift(request({ provider: answering({ cheap: "spam" }) }));

    expect(sifted.dropped?.reason).toBe("spam");
  });

  it("drops a thread that is about something else entirely", async () => {
    const sifted = await sift(request({ provider: answering({ cheap: "off-topic" }) }));

    expect(sifted.dropped?.reason).toBe("off-topic");
  });

  it("carries on when the answer is keep", async () => {
    const sifted = await sift(request({ provider: answering({ cheap: "keep" }) }));

    expect(sifted.dropped).toBeNull();
  });

  it("is off when no cheap roster was configured, without asking anything", async () => {
    const provider = answering({ cheap: "spam" });
    const sifted = await sift(request({ provider, models: [] }));

    expect(sifted.dropped).toBeNull();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("carries on when every cheap model failed, and reports them", async () => {
    // Which is the run this stage was added to, before it existed. Every cheap
    // model failing is a reason to spend the expensive one, not to skip a
    // thread.
    const sifted = await sift(request({ models: ["a", "b"], provider: answering({}) }));

    expect(sifted.dropped).toBeNull();
    expect(sifted.failures.map((failure) => failure.model)).toEqual(["a", "b"]);
  });

  it("carries on when the answer is a sentence rather than a word", async () => {
    const sifted = await sift(
      request({
        provider: answering({ cheap: "I am not sure what this issue is about, honestly." }),
      }),
    );

    expect(sifted.dropped).toBeNull();
  });

  it("carries on when the answer names both, which is an answer that did not decide", async () => {
    const sifted = await sift(
      request({ provider: answering({ cheap: "spam or off-topic, hard to say" }) }),
    );

    expect(sifted.dropped).toBeNull();
  });

  it("reads the verdict as a word and not as a substring", async () => {
    // `spam` inside `spammer` is a model writing prose about spam, and a
    // rationale nobody asked for is not a verdict.
    const sifted = await sift(
      request({ provider: answering({ cheap: "This is not from a spammer." }) }),
    );

    expect(sifted.dropped).toBeNull();
  });

  it("rotates past a cheap model that failed rather than retrying it", async () => {
    const provider = answering({ second: "keep" });
    await sift(request({ provider, models: ["first", "second"] }));

    expect(vi.mocked(provider.complete).mock.calls.map((call) => call[0])).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("the prompt sift sends", () => {
  /** The two messages the cheap model was sent. */
  async function messagesOf(over: Partial<SiftRequest> = {}): Promise<string[]> {
    const provider = answering({ cheap: "keep" });
    await sift(request({ ...over, provider }));
    const [call] = vi.mocked(provider.complete).mock.calls;
    return (call?.[1] ?? []).map((message) => message.content);
  }

  it("puts the thread behind a boundary the system message names", async () => {
    const [system, user] = await messagesOf({ title: "Buy followers", body: "Cheap!" });
    const opened = /<untrusted-thread id="([a-f0-9]+)">/.exec(user ?? "");

    expect(opened?.[1]).toBeDefined();
    expect(system).toContain(opened?.[1] ?? "no id was found");
    expect(user).toContain("TITLE: Buy followers");
  });

  it("tells the model what the repository is about when somebody said", async () => {
    const [system] = await messagesOf({ about: "A GitHub Action that triages issues." });

    expect(system).toContain("This repository is: A GitHub Action that triages issues.");
  });

  it("says nothing about the repository when nobody said", async () => {
    // Rather than an empty sentence, which reads as a project about nothing.
    expect((await messagesOf({ about: "" }))[0]).not.toContain("This repository is:");
  });

  it("says that a short or blunt report is worth attention", async () => {
    // The screen this replaced was a quality judgment, and that is the failure
    // this one is built to avoid.
    expect((await messagesOf())[0]).toContain("worth attention");
    expect((await messagesOf())[0]).toContain("When you are not sure, answer keep.");
  });
});
