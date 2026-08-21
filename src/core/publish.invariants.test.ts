/**
 * The two promises the publish stage makes about a body it did not write all
 * of: that it replaces only the block it owns, and that a race is reported
 * rather than corrected.
 *
 * `marker.test.ts` proves each duty finds its own marker in a body carrying
 * two, and says in as many words that keeping the halves apart is the publish
 * stage's job rather than the marker's. This is that job, asserted where it
 * lives. The race half is here for the opposite reason: `publish.test.ts`
 * already reads `mismatched: true` off the outcome, and the thing that would
 * make that outcome a lie — a second, corrective write — is invisible in the
 * outcome itself.
 *
 * Nothing is mocked. The thread is a port that arrives injected and the marker
 * is a value this module is handed, so a stub of either would be a stub of the
 * argument rather than of a collaborator.
 */
import type * as core from "@actions/core";
import { describe, expect, it, vi } from "vitest";

import { markerFor } from "./marker.js";
import { assemble, publish, type Publication } from "./publish.js";
import type { Thread } from "./forge.js";

// The one exception to "nothing is mocked": `core.warning` is an effect on the
// runner, and an unmocked one writes a real `::warning::` annotation onto the
// job that ran the suite.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  warning: vi.fn(),
}));

const translate = markerFor("translate");
const triage = markerFor("triage");

const OFFICIAL = "Ứng dụng bị lỗi khi tôi bấm nút.";

function publication(over: Partial<Publication> = {}): Publication {
  return { fingerprint: "abc123", sections: ["A section."], ...over };
}

/** A thread whose reads reflect its writes, the way a real one does. */
function threadOf(body: string): Thread & { written: string[] } {
  const written: string[] = [];
  let current = body;
  return {
    written,
    read: vi.fn(() => Promise.resolve(current)),
    write: vi.fn((next: string) => {
      written.push(next);
      current = next;
      return Promise.resolve();
    }),
  };
}

describe("a body that carries more than this duty's block", () => {
  const shared = [
    OFFICIAL,
    "",
    triage.render("aaaaaaaaaaaaaaaa"),
    "",
    "The labels this thread was sorted into.",
    "",
    translate.render("bbbbbbbbbbbbbbbb"),
    "",
    "Bản dịch cũ.",
  ].join("\n");

  it("replaces its own block and leaves another duty's standing above it", async () => {
    // A thread can carry a translation and a triage note at once. Neither may
    // read the other's block as its own, and — the half only this stage can
    // keep — neither may lose the other's block by rewriting the body around
    // its own.
    const thread = threadOf(shared);

    await publish(thread, translate, publication({ fingerprint: "cccccccccccccccc" }));

    const written = thread.written[0] ?? "";
    expect(written).toContain(triage.render("aaaaaaaaaaaaaaaa"));
    expect(written).toContain("The labels this thread was sorted into.");
    expect(written).toContain(translate.render("cccccccccccccccc"));
    expect(written).not.toContain("Bản dịch cũ.");
  });

  it("still keeps the author's own text first and byte for byte", async () => {
    const thread = threadOf(shared);

    await publish(thread, translate, publication({ fingerprint: "cccccccccccccccc" }));

    expect(thread.written[0]?.startsWith(OFFICIAL)).toBe(true);
  });

  it("writes one block of its own, never a second one beside the first", async () => {
    const thread = threadOf(shared);

    await publish(thread, translate, publication({ fingerprint: "cccccccccccccccc" }));

    expect(thread.written[0]?.split("reeve:translate")).toHaveLength(2);
  });
});

describe("the verification read is a report, not a correction", () => {
  it("writes exactly once when another run moved the body out from under it", async () => {
    // There is no compare-and-swap on an issue body, so this stage cannot win
    // the race — and a stage that answered a losing race with a second write
    // would take the other run's body away and start a loop between two
    // workflows. `mismatched` is the whole response.
    const raced = "A body a racing run already wrote.";
    const write = vi.fn(() => Promise.resolve());
    const thread: Thread = {
      read: vi.fn().mockResolvedValueOnce(OFFICIAL).mockResolvedValue(raced),
      write,
    };

    const outcome = await publish(thread, translate, publication());

    expect(outcome).toEqual({ action: "published", mismatched: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reads once before the write and once after it, never more", async () => {
    // One re-read, after the write and never before it. A second attempt would
    // be a retry this stage has deliberately not got.
    const thread = threadOf(OFFICIAL);

    await publish(thread, translate, publication());

    expect(thread.read).toHaveBeenCalledTimes(2);
    expect(thread.write).toHaveBeenCalledTimes(1);
  });

  it("does not write again when the verification read itself fails", async () => {
    const write = vi.fn(() => Promise.resolve());
    const thread: Thread = {
      read: vi
        .fn()
        .mockResolvedValueOnce(OFFICIAL)
        .mockRejectedValueOnce(new Error("503 Service Unavailable")),
      write,
    };

    await publish(thread, translate, publication());

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(assemble(OFFICIAL, translate, publication()));
  });
});
