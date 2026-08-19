/**
 * Two properties of remediation's envelope read that nothing observed.
 *
 * Both were found by an auditor mutating the module and watching all 51
 * remediation tests stay green.
 *
 * ## 1. The resolved filter
 *
 * `readEnvelope` splits the payload into `findings` — what is still standing —
 * and `previous`, the full memory. The split is one `filter` at
 * `envelope.ts:167`, and it is what stops a finding a review already resolved
 * coming back as an actionable proposal. Nothing asserted it, so a run could
 * have started proposing fixes for work already done and no test would have
 * said so.
 *
 * ## 2. Two codecs for one wire format, one of them unguarded
 *
 * `review/publish.ts` writes the envelope and reads it back through a codec
 * that is versioned and checksummed: a v2 payload whose `checksum` does not
 * match is `corrupt` and is refused loudly (`publish.ts:244`). Remediation
 * RE-DECLARED the decoder in `envelope.ts:119-173` — deliberately, for the
 * structural-directionality reason the duty is a separate directory at all —
 * but re-declared it WITHOUT the integrity half: no checksum recomputation,
 * no version check, and `severity` is `as`-cast after only a `typeof` test.
 *
 * So a payload review would reject as damaged or forged, remediation accepts.
 * These cases pin that divergence rather than closing it: unifying the codecs
 * is a Round 2 refactor, and the safe half of the boundary already holds —
 * `envelope.adversarial.test.ts` proves the payload can only arrive from a
 * bot-authored comment carrying nothing but the marker, and that nothing in it
 * reaches a capability, a path, a command or a write. What it buys an attacker
 * who has already got past that is a wrong proposal in a report, not an
 * action. **Round 2: one codec, or remediation adopts the checksum check.**
 */
import { describe, expect, it } from "vitest";

import { markerFor } from "../../core/marker.js";
import { envelopeChecksum } from "../review/findings.js";
import type { Previous } from "../review/findings.js";
import { encodeEnvelope as reviewEncodeEnvelope } from "../review/publish.js";

import { readEnvelope, type CommentApi } from "./envelope.js";

const AT = { owner: "acme", repo: "widgets", number: 42 };
const REVIEW_MARKER = markerFor("review");

function finding(over: Partial<Previous["findings"][number]> = {}): Previous["findings"][number] {
  return {
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
    ...over,
  };
}

/** A comment carrying the payload, authored the way review authors one. */
function commentsApi(payload: string): CommentApi {
  return {
    rest: {
      issues: {
        listComments: () =>
          Promise.resolve({
            data: [
              {
                id: 1,
                body: REVIEW_MARKER.render(payload),
                user: { login: "reeve[bot]", type: "Bot" },
              },
            ],
          }),
      },
    },
  };
}

/** The payload half exactly as review writes it. */
function payloadFor(previous: Previous): string {
  return `fingerprint ${reviewEncodeEnvelope(previous)}`;
}

describe("the resolved filter", () => {
  it("keeps a finding that is still standing in the actionable list", async () => {
    const previous: Previous = { findings: [finding()], reviewedShas: [] };

    const envelope = await readEnvelope(commentsApi(payloadFor(previous)), AT);

    expect(envelope?.findings.map((entry) => entry.id)).toEqual(["f1"]);
  });

  it("keeps a resolved finding OUT of the actionable list", async () => {
    // The invariant: a fix already made must not come back as a proposal.
    const previous: Previous = {
      findings: [finding({ id: "done", wasResolved: true })],
      reviewedShas: [],
    };

    const envelope = await readEnvelope(commentsApi(payloadFor(previous)), AT);

    expect(envelope?.findings).toEqual([]);
  });

  it("still remembers the resolved finding in `previous`, which standings are decided against", async () => {
    // Filtered out of the actionable list, NOT forgotten: `reopened` is only
    // meaningful because the record of the resolution survives.
    const previous: Previous = {
      findings: [finding({ id: "done", wasResolved: true })],
      reviewedShas: [],
    };

    const envelope = await readEnvelope(commentsApi(payloadFor(previous)), AT);

    expect(envelope?.previous.map((entry) => entry.id)).toEqual(["done"]);
    expect(envelope?.previous[0]?.wasResolved).toBe(true);
  });

  it("splits a mixed memory into the standing half and the whole", async () => {
    const previous: Previous = {
      findings: [finding({ id: "open" }), finding({ id: "done", wasResolved: true })],
      reviewedShas: [],
    };

    const envelope = await readEnvelope(commentsApi(payloadFor(previous)), AT);

    expect(envelope?.findings.map((entry) => entry.id)).toEqual(["open"]);
    expect(envelope?.previous.map((entry) => entry.id)).toEqual(["open", "done"]);
  });

  it("carries `resolvedAtSha` through when the record has one", async () => {
    // The field that ties a resolution claim to a real revision. Losing it
    // would leave `reopened` unable to tell a genuine regression from a
    // rewritten history.
    const previous: Previous = {
      findings: [finding({ id: "done", wasResolved: true, resolvedAtSha: "abc123" })],
      reviewedShas: [],
    };

    const envelope = await readEnvelope(commentsApi(payloadFor(previous)), AT);

    expect(envelope?.previous[0]?.resolvedAtSha).toBe("abc123");
  });
});

describe("the codec divergence — pinned, not closed", () => {
  it("review REFUSES a v2 payload whose checksum does not match", async () => {
    // The control: this is what the writing side does with the same bytes.
    const { decodeEnvelope: reviewDecode } = await import("../review/publish.js");
    const previous: Previous = { findings: [finding()], reviewedShas: [] };
    const tampered = {
      ...previous,
      version: 2,
      checksum: envelopeChecksum(previous),
      findings: [finding({ body: "a different claim entirely" })],
    };

    // Review's decoder reads the WHOLE marker payload — fingerprint, a space,
    // then the base64 — so it is handed the same string remediation is.
    const decoded = reviewDecode(payloadFor(tampered as unknown as Previous));

    expect(decoded.kind).toBe("corrupt");
  });

  it("remediation ACCEPTS the same payload, because its decoder has no checksum check", async () => {
    // ADJUDICATE / Round 2. Two decoders for one wire format, and only one of
    // them verifies integrity. Pinned to the source's current behaviour so the
    // divergence is visible and a change to either side has to come here.
    const previous: Previous = { findings: [finding()], reviewedShas: [] };
    const tampered = {
      ...previous,
      version: 2,
      checksum: envelopeChecksum(previous),
      findings: [finding({ body: "a different claim entirely" })],
    };

    const envelope = await readEnvelope(
      commentsApi(payloadFor(tampered as unknown as Previous)),
      AT,
    );

    expect(envelope?.findings[0]?.body).toBe("a different claim entirely");
  });

  it("remediation accepts a payload carrying no version at all", async () => {
    const previous: Previous = { findings: [finding()], reviewedShas: [] };

    const envelope = await readEnvelope(commentsApi(payloadFor(previous)), AT);

    expect(envelope?.findings).toHaveLength(1);
  });

  it("remediation accepts any string as a severity, where review checks the union", async () => {
    // `envelope.ts:159` casts after a bare `typeof === "string"`. The value
    // reaches a report and a summary cell, never a decision — see
    // `envelope.adversarial.test.ts` — which is why this is pinned rather than
    // treated as a break.
    const previous = {
      findings: [{ ...finding(), severity: "catastrophic" }],
      reviewedShas: [],
    };

    const envelope = await readEnvelope(
      commentsApi(payloadFor(previous as unknown as Previous)),
      AT,
    );

    expect(envelope?.findings[0]?.severity).toBe("catastrophic");
  });

  it("still refuses a payload that is not readable at all, whichever codec is asked", async () => {
    // The one guard both codecs share, and the one that matters most: a
    // payload that does not decode is absent input, never a partial claim.
    expect(await readEnvelope(commentsApi("fingerprint not-base64"), AT)).toBeNull();
    expect(await readEnvelope(commentsApi("fingerprint "), AT)).toBeNull();
  });
});
