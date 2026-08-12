import { describe, expect, it, vi } from "vitest";

import type { Listed } from "./forge.js";
import { createWeather } from "./provider.js";
import {
  newAccumulator,
  remainingOf,
  standingFromListing,
  sweepThreads,
  type SweepAccumulator,
} from "./sweep.js";

// Nothing is mocked. The walk's whole contract is which of four checks stops
// it and what each one counts as, and every one of those is decidable from a
// list, a number and a `Weather` — none of it needs a network to be true.

const MODELS = ["gpt-4o-mini"];

/** A listing entry, with only the fields a walk actually reads set apart. */
function listed(number: number, over: Partial<Listed> = {}): Listed {
  return {
    number,
    title: `Thread ${String(number)}`,
    body: "A body.",
    labels: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    isPullRequest: false,
    ...over,
  };
}

/** A row, in the shape the three duties that describe an outcome in words use. */
function row(thread: Listed): { number: number; outcome: string } {
  return { number: thread.number, outcome: "done" };
}

/** Weather with every model on `MODELS` grounded — a roster that has run dry. */
function dryWeather(): ReturnType<typeof createWeather> {
  const weather = createWeather();
  for (const model of MODELS) weather.ground(model);
  return weather;
}

describe("newAccumulator", () => {
  it("starts at nothing done and nothing known", () => {
    expect(newAccumulator()).toEqual({
      results: [],
      skipped: 0,
      starvedRun: false,
      candidates: 0,
      ungranted: null,
    });
  });
});

describe("remainingOf", () => {
  it("is the candidates neither worked nor skipped", () => {
    const acc: SweepAccumulator<string> = {
      results: ["a"],
      skipped: 2,
      starvedRun: false,
      candidates: 10,
      ungranted: null,
    };

    expect(remainingOf(acc)).toBe(7);
  });

  it("never goes negative, whatever the arithmetic says", () => {
    const acc: SweepAccumulator<string> = {
      results: ["a", "b"],
      skipped: 3,
      starvedRun: false,
      candidates: 1,
      ungranted: null,
    };

    expect(remainingOf(acc)).toBe(0);
  });
});

describe("standingFromListing", () => {
  it("carries the fields the listing knows", () => {
    const thread = listed(7, { labels: ["bug"], isPullRequest: true });

    expect(standingFromListing(thread)).toMatchObject({
      title: "Thread 7",
      body: "A body.",
      labels: ["bug"],
      isPullRequest: true,
      createdAt: thread.createdAt,
    });
  });

  it("leaves the fields the listing does not carry at their honest unknown", () => {
    // Not "a plausible author": a placeholder that looked like a real login
    // would be a fact nothing here is entitled to state. Every duty that
    // sweeps ignores all three; the one that reads `author` does not sweep.
    expect(standingFromListing(listed(1))).toMatchObject({
      author: { login: "", isBot: false },
      milestone: null,
      assignees: [],
      closed: false,
    });
  });
});

describe("sweepThreads", () => {
  it("records how many candidates it was given, before working any of them", async () => {
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(acc, [listed(1), listed(2)], { limit: 0, models: MODELS }, createWeather(), {
      processOne: (thread) => Promise.resolve(row(thread)),
    });

    // `limit: 0` stops before the first thread, and `candidates` is still 2:
    // it is what the listing offered, not what the walk got to.
    expect(acc.candidates).toBe(2);
    expect(acc.results).toEqual([]);
  });

  it("works every candidate when nothing stops it", async () => {
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(
      acc,
      [listed(1), listed(2), listed(3)],
      { limit: null, models: MODELS },
      createWeather(),
      { processOne: (thread) => Promise.resolve(row(thread)) },
    );

    expect(acc.results.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(acc.skipped).toBe(0);
  });

  it("counts `limit` against worked threads, not candidates seen", async () => {
    // The distinction a sweep's budget turns on: a run that skipped forty
    // already-decided threads has spent nothing, and stopping it at `limit`
    // would make a repeat sweep over a mostly-done backlog do no work at all.
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(
      acc,
      [listed(1), listed(2), listed(3), listed(4)],
      { limit: 2, models: MODELS },
      createWeather(),
      {
        alreadyDone: (thread) => thread.number <= 2,
        processOne: (thread) => Promise.resolve(row(thread)),
      },
    );

    expect(acc.results.map((entry) => entry.number)).toEqual([3, 4]);
    expect(acc.skipped).toBe(2);
  });

  it("counts an already-done thread as skipped without ever working it", async () => {
    const acc = newAccumulator<{ number: number; outcome: string }>();
    const processOne = vi.fn((thread: Listed) => Promise.resolve(row(thread)));

    await sweepThreads(
      acc,
      [listed(1), listed(2)],
      { limit: null, models: MODELS },
      createWeather(),
      {
        alreadyDone: (thread) => thread.number === 1,
        processOne,
      },
    );

    expect(acc.skipped).toBe(1);
    expect(processOne).toHaveBeenCalledTimes(1);
  });

  it("stops on a dry roster, and says the run was starved", async () => {
    // D12: everything already in `results` is real work that happened, and
    // the rest of the backlog is `remaining` for the next run rather than a
    // failure of this one.
    const weather = createWeather();
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(acc, [listed(1), listed(2)], { limit: null, models: MODELS }, weather, {
      processOne: (thread) => {
        for (const model of MODELS) weather.ground(model);
        return Promise.resolve(row(thread));
      },
    });

    expect(acc.results).toHaveLength(1);
    expect(acc.starvedRun).toBe(true);
    expect(remainingOf(acc)).toBe(1);
  });

  it("checks the roster before the first thread, not only between them", async () => {
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(acc, [listed(1)], { limit: null, models: MODELS }, dryWeather(), {
      processOne: (thread) => Promise.resolve(row(thread)),
    });

    expect(acc.results).toEqual([]);
    expect(acc.starvedRun).toBe(true);
  });

  it("skips a thread before spending anything on it, even with the roster dry", async () => {
    // The order is what makes a repeat sweep cheap: an already-done thread
    // costs nothing to recognise, so a starved run still gets to count it
    // rather than stopping and reporting it as remaining work.
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(acc, [listed(1), listed(2)], { limit: null, models: MODELS }, dryWeather(), {
      alreadyDone: (thread) => thread.number === 1,
      processOne: (thread) => Promise.resolve(row(thread)),
    });

    expect(acc.skipped).toBe(1);
    expect(acc.starvedRun).toBe(true);
  });

  it("stops on a run's own ceiling without calling it starvation", async () => {
    // Translate's request budget: the roster is fine, the run has simply
    // decided it has spent enough, and `starved` would report weather that
    // is not happening.
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(
      acc,
      [listed(1), listed(2)],
      { limit: null, models: MODELS },
      createWeather(),
      {
        exhausted: () => acc.results.length >= 1,
        processOne: (thread) => Promise.resolve(row(thread)),
      },
    );

    expect(acc.results).toHaveLength(1);
    expect(acc.starvedRun).toBe(false);
  });

  it("counts work that turned out to be a skip as skipped, not as a row", async () => {
    // Triage's self-training guard: only the work itself can find out that a
    // thread has nothing to contribute, and the honest report is a skip.
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await sweepThreads(
      acc,
      [listed(1), listed(2)],
      { limit: null, models: MODELS },
      createWeather(),
      { processOne: (thread) => Promise.resolve(thread.number === 1 ? null : row(thread)) },
    );

    expect(acc.skipped).toBe(1);
    expect(acc.results.map((entry) => entry.number)).toEqual([2]);
  });

  it("runs `afterEach` after each worked thread and after none of the skipped ones", async () => {
    const acc = newAccumulator<{ number: number; outcome: string }>();
    const afterEach = vi.fn();

    await sweepThreads(
      acc,
      [listed(1), listed(2), listed(3)],
      { limit: null, models: MODELS },
      createWeather(),
      {
        alreadyDone: (thread) => thread.number === 1,
        processOne: (thread) => Promise.resolve(row(thread)),
        afterEach,
      },
    );

    expect(afterEach).toHaveBeenCalledTimes(2);
  });

  it("leaves everything it did in the accumulator when the work throws", async () => {
    // The whole reason the accumulator is written into rather than returned:
    // `run`'s `finally` still has to report the threads that succeeded.
    const acc = newAccumulator<{ number: number; outcome: string }>();

    await expect(
      sweepThreads(acc, [listed(1), listed(2)], { limit: null, models: MODELS }, createWeather(), {
        processOne: (thread) => {
          if (thread.number === 2) throw new Error("boom");
          return Promise.resolve(row(thread));
        },
      }),
    ).rejects.toThrow("boom");

    expect(acc.results.map((entry) => entry.number)).toEqual([1]);
    expect(acc.candidates).toBe(2);
  });
});
