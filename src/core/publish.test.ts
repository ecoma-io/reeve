import { describe, expect, it, vi } from "vitest";

import { createReply, type GitHubApi, type Thread } from "./forge.js";
import { markerFor } from "./marker.js";
import { assemble, publish, type Publication } from "./publish.js";

// Nothing is mocked: the marker is a value this module is handed, and the
// thread is a port that arrives injected.

const translate = markerFor("translate");
const triage = markerFor("triage");

const OFFICIAL = "Ứng dụng bị lỗi khi tôi bấm nút.";

function publication(over: Partial<Publication> = {}): Publication {
  return { fingerprint: "abc123", sections: ["A section."], ...over };
}

/**
 * A thread whose body is whatever the case put on it, recording every write
 * and answering `read` from whatever it last wrote — a genuine mutable stub,
 * because `publish`'s re-read-after-write only means anything against a
 * thread whose reads reflect its writes, the way a real one does.
 */
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

describe("assemble", () => {
  it("keeps the author's text first and byte-for-byte", () => {
    // Everything GitHub reads out of a body — `Fixes #42`, a task list, a
    // trailer — survives only because this half is never rewritten.
    const author = "Fixes #42\n\n- [x] reproduced\n\nCo-authored-by: Ai <ai@example.com>";
    const body = assemble(author, translate, publication());

    expect(body.startsWith(author)).toBe(true);
  });

  it("puts the marker between the author's text and the duty's sections", () => {
    const body = assemble(OFFICIAL, translate, publication({ fingerprint: "deadbeef" }));

    expect(body.indexOf(OFFICIAL)).toBeLessThan(body.indexOf(translate.render("deadbeef")));
    expect(body.indexOf(translate.render("deadbeef"))).toBeLessThan(body.indexOf("A section."));
  });

  it("separates every part by a blank line, so each renders as Markdown", () => {
    const body = assemble(OFFICIAL, translate, publication({ sections: ["one", "two"] }));

    expect(body).toBe(`${OFFICIAL}\n\n${translate.render("abc123")}\n\none\n\ntwo`);
  });

  it("renders the same author text and publication to the same bytes", () => {
    // What lets `publish` recognise a run that changed nothing, which is what
    // makes an edit-triggered rerun free.
    expect(assemble(OFFICIAL, translate, publication())).toBe(
      assemble(OFFICIAL, translate, publication()),
    );
  });

  it("renders a body ending in whitespace the same as one that does not", () => {
    expect(assemble(`${OFFICIAL}\n\n  `, translate, publication())).toBe(
      assemble(OFFICIAL, translate, publication()),
    );
  });

  it("round-trips through the marker, so the next run reads back what it wrote", () => {
    const body = assemble(OFFICIAL, translate, publication({ fingerprint: "cafe1234" }));

    expect(translate.split(body)).toEqual({ official: OFFICIAL, fingerprint: "cafe1234" });
  });

  it("writes the marker of the duty it was given and no other", () => {
    const body = assemble(OFFICIAL, triage, publication());

    expect(triage.split(body).fingerprint).toBe("abc123");
    expect(translate.split(body).fingerprint).toBeNull();
  });
});

describe("publish", () => {
  it("appends the block to a thread never published to before", async () => {
    const thread = threadOf(OFFICIAL);

    await expect(publish(thread, translate, publication())).resolves.toEqual({
      action: "published",
      mismatched: false,
    });
    expect(thread.written[0]).toBe(assemble(OFFICIAL, translate, publication()));
  });

  it("replaces the block it already owns rather than appending a second one", async () => {
    const stale = assemble(OFFICIAL, translate, publication({ fingerprint: "stale" }));
    const thread = threadOf(stale);

    await expect(
      publish(thread, translate, publication({ fingerprint: "fresh" })),
    ).resolves.toEqual({ action: "published", mismatched: false });
    expect(thread.written[0]).toBe(
      assemble(OFFICIAL, translate, publication({ fingerprint: "fresh" })),
    );
    expect(thread.written[0]?.split("reeve:translate")).toHaveLength(2);
  });

  it("leaves a body that already says this alone", async () => {
    // Writing identical text would mark the thread edited, fire the event the
    // workflow listens for, and spend a rate limit for nothing a reader sees.
    const thread = threadOf(assemble(OFFICIAL, translate, publication()));

    await expect(publish(thread, translate, publication())).resolves.toEqual({
      action: "unchanged",
    });
    expect(thread.write).not.toHaveBeenCalled();
  });

  it("writes nothing when the run produced no sections", async () => {
    const thread = threadOf(OFFICIAL);

    await expect(publish(thread, translate, publication({ sections: [] }))).resolves.toEqual({
      action: "none",
      reason: "the run produced nothing to publish",
    });
    expect(thread.write).not.toHaveBeenCalled();
  });

  it("keeps the block already published when this run produced nothing", async () => {
    // A provider out of quota this morning must not cost the thread the good
    // output it already has.
    const thread = threadOf(assemble(OFFICIAL, translate, publication()));

    await publish(thread, translate, publication({ sections: [] }));

    expect(thread.write).not.toHaveBeenCalled();
  });

  it("does not read the thread when it has nothing to publish", async () => {
    const thread = threadOf(OFFICIAL);

    await publish(thread, translate, publication({ sections: [] }));

    expect(thread.read).not.toHaveBeenCalled();
  });

  it("writes a reply through the same port as a thread", async () => {
    // The point of the port: this stage never learns whether it is editing a
    // body or a comment.
    let commentBody = OFFICIAL;
    const updateComment = vi.fn((params: { body: string }) => {
      commentBody = params.body;
      return Promise.resolve({});
    });
    const api = {
      rest: {
        issues: {
          get: vi.fn(() => Promise.resolve({ data: { body: "" } })),
          update: vi.fn(() => Promise.resolve({})),
          listComments: vi.fn(() => Promise.resolve({ data: [] })),
          updateComment,
          getComment: vi.fn(() => Promise.resolve({ data: { body: commentBody } })),
        },
      },
    } as GitHubApi;
    const at = { owner: "ecoma-io", repo: "reeve", number: 42 };

    const outcome = await publish(
      createReply(api, at, { id: 991, body: OFFICIAL, login: "someone", isBot: false }),
      translate,
      publication(),
    );

    expect(outcome).toEqual({ action: "published", mismatched: false });
    expect(updateComment.mock.calls[0]?.[0].body).toContain(OFFICIAL);
    expect(updateComment.mock.calls[0]?.[0].body).toContain(translate.render("abc123"));
  });
});
