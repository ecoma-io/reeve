/**
 * `readEnvelope` as a trust boundary.
 *
 * The envelope is `review`'s memory of what it found last run, carried in the
 * marker of a comment on the pull request. Remediation reads it and derives
 * proposals from it. Everything in it is therefore an instruction about what
 * to propose — and the comment it rides in sits on a public thread that anybody
 * with a GitHub account can post to.
 *
 * Two guards stand between those two facts, both on one line
 * (`envelope.ts:100-104`): the comment's author must be a bot, and the marker
 * must split with `official === ""` — a body that is nothing but the marker,
 * which is what `review` writes and what a human quoting one does not produce.
 *
 * Neither guard was driven by a test. `envelope.test.ts` exercises
 * `decodeEnvelope` alone and never calls `readEnvelope`; every integration
 * fixture posts as `reeve[bot]`, so the human-author arm was never taken.
 * These cases take it, from the attacker's side: each one supplies an envelope
 * that WOULD decode, and asserts it is refused for who wrote it or how it was
 * wrapped rather than for what it contained.
 */
import { describe, expect, it } from "vitest";

import { markerFor } from "../../core/marker.js";
import type { Previous } from "../review/findings.js";
import { encodeEnvelope as reviewEncodeEnvelope } from "../review/publish.js";

import { readEnvelope, type CommentApi } from "./envelope.js";

const AT = { owner: "acme", repo: "widgets", number: 42 };
const REVIEW_MARKER = markerFor("review");

/** One finding in review's own shape — enough that `decodeEnvelope` accepts it. */
function envelopePayload(): string {
  const previous: Previous = {
    findings: [
      {
        id: "f1",
        ruleId: "r1",
        ruleName: "No secrets",
        ruleBody: "Do not commit secrets.",
        path: "src/app.ts",
        line: 12,
        severity: "critical",
        body: "A token is hardcoded here.",
        marker: "m1",
        wasResolved: false,
        disposition: null,
      },
    ],
    reviewedShas: [],
  };
  return `fingerprint ${reviewEncodeEnvelope(previous)}`;
}

/** A comment body shaped exactly the way `review` writes one. */
function reviewComment(): string {
  return REVIEW_MARKER.render(envelopePayload());
}

/** An API returning one page of comments, exactly as `listComments` would. */
function commentsApi(
  comments: readonly { body?: string | null; user?: { login?: string; type?: string } | null }[],
): CommentApi {
  return {
    rest: {
      issues: {
        listComments: () =>
          Promise.resolve({
            data: comments.map((comment, at) => ({ id: at + 1, ...comment })),
          }),
      },
    },
  };
}

describe("readEnvelope trusts review's own comment", () => {
  it("reads the envelope from a comment the review app wrote", async () => {
    // The control. Everything below differs from this in exactly one way, so
    // a refusal downstream is attributable to that one difference.
    const envelope = await readEnvelope(
      commentsApi([{ body: reviewComment(), user: { login: "reeve[bot]", type: "Bot" } }]),
      AT,
    );

    expect(envelope?.previous.map((finding) => finding.id)).toEqual(["f1"]);
  });

  it("reads it from an author GitHub typed as a Bot without a [bot] suffix", async () => {
    const envelope = await readEnvelope(
      commentsApi([{ body: reviewComment(), user: { login: "reeve-app", type: "Bot" } }]),
      AT,
    );

    expect(envelope?.previous).toHaveLength(1);
  });
  it("reads it from a [bot]-suffixed login even when GitHub typed it as a User", async () => {
    // The suffix arm of `isBotAuthor`, and the reason it exists: GitHub does
    // not always stamp `type: "Bot"` on an App's comment, and no human can
    // register a login containing `[` — so the suffix is the reliable signal
    // when the type is not there.
    const envelope = await readEnvelope(
      commentsApi([{ body: reviewComment(), user: { login: "reeve[bot]", type: "User" } }]),
      AT,
    );

    expect(envelope?.previous).toHaveLength(1);
  });
});

describe("readEnvelope refuses an envelope a human could have planted", () => {
  it("refuses_a_perfectly_valid_envelope_from_a_human_author", async () => {
    // The whole attack in one case: the payload is byte-identical to the one
    // accepted above, and the only thing that changed is who posted it. A
    // contributor who copies review's comment out of one pull request and
    // pastes it into another must not thereby choose what remediation
    // proposes.
    const envelope = await readEnvelope(
      commentsApi([{ body: reviewComment(), user: { login: "contributor", type: "User" } }]),
      AT,
    );

    expect(envelope).toBeNull();
  });

  it("refuses_an_envelope_from_a_login_merely_ending_in_bot", async () => {
    // `isBotAuthor` matches the `[bot]` suffix GitHub reserves, not the word.
    // A human may register `dependabot` or `mybot`; nobody may register a
    // login containing `[`.
    const envelope = await readEnvelope(
      commentsApi([{ body: reviewComment(), user: { login: "helpfulbot", type: "User" } }]),
      AT,
    );

    expect(envelope).toBeNull();
  });

  it("refuses_an_envelope_on_a_comment_with_no_author_at_all", async () => {
    expect(await readEnvelope(commentsApi([{ body: reviewComment(), user: null }]), AT)).toBeNull();
    expect(await readEnvelope(commentsApi([{ body: reviewComment() }]), AT)).toBeNull();
  });

  it("refuses_a_bot_comment_that_quotes_the_marker_under_prose", async () => {
    // The second guard: `official === ""`. A body with anything above the
    // marker is somebody's text carrying a marker, not review's own comment —
    // and another bot on the thread quoting review's summary is the ordinary
    // way that happens.
    const envelope = await readEnvelope(
      commentsApi([
        {
          body: `Here is what the reviewer said last time:\n\n${reviewComment()}`,
          user: { login: "other[bot]", type: "Bot" },
        },
      ]),
      AT,
    );

    expect(envelope).toBeNull();
  });

  it("refuses_a_marker_belonging_to_a_different_duty", async () => {
    // `triage`'s marker is not `review`'s memory, however well-formed its
    // payload is.
    const envelope = await readEnvelope(
      commentsApi([
        {
          body: markerFor("triage").render(envelopePayload()),
          user: { login: "reeve[bot]", type: "Bot" },
        },
      ]),
      AT,
    );

    expect(envelope).toBeNull();
  });

  it("reads_the_bot_comment_and_ignores_the_human_one_that_came_first", async () => {
    // Order must not decide trust. A forged comment posted before review's own
    // must not shadow it.
    const envelope = await readEnvelope(
      commentsApi([
        { body: reviewComment(), user: { login: "attacker", type: "User" } },
        { body: reviewComment(), user: { login: "reeve[bot]", type: "Bot" } },
      ]),
      AT,
    );

    expect(envelope?.previous.map((finding) => finding.id)).toEqual(["f1"]);
  });

  it("returns_null_rather_than_a_partial_read_for_a_corrupt_payload_from_the_right_author", async () => {
    // A corrupt envelope is absent input, never a claim: the run proposes
    // nothing rather than proposing from the half that happened to parse.
    const envelope = await readEnvelope(
      commentsApi([
        {
          body: REVIEW_MARKER.render("fingerprint not-base64-at-all"),
          user: { login: "reeve[bot]", type: "Bot" },
        },
      ]),
      AT,
    );

    expect(envelope).toBeNull();
  });

  it("returns_null_when_the_thread_carries_no_review_comment_at_all", async () => {
    expect(
      await readEnvelope(
        commentsApi([{ body: "Nice work!", user: { login: "someone", type: "User" } }]),
        AT,
      ),
    ).toBeNull();
    expect(await readEnvelope(commentsApi([]), AT)).toBeNull();
  });
});
