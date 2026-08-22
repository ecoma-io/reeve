import { describe, expect, it } from "vitest";

import {
  dispositionKey,
  isEligibleReply,
  parseDispositionLine,
  readDispositions,
  type ThreadReply,
} from "./disposition.js";
import type { PreviousFinding } from "./findings.js";

function reply(overrides: Partial<ThreadReply> = {}): ThreadReply {
  return {
    id: 7,
    login: "maintainer",
    isBot: false,
    association: "COLLABORATOR",
    createdAt: "2026-01-01T00:00:00Z",
    body: "12: wont-fix",
    ...overrides,
  };
}

function previous(overrides: Partial<PreviousFinding> = {}): PreviousFinding {
  return {
    id: "f1",
    ruleId: "diff-evidence",
    ruleName: "Diff evidence",
    ruleBody: "Evidence is required.",
    path: "src/app.ts",
    line: 12,
    severity: "warning",
    body: "Missing evidence.",
    marker: "",
    wasResolved: false,
    disposition: null,
    ...overrides,
  };
}

const AT = { owner: "ecoma-io", repo: "reeve", number: 42 };

describe("parseDispositionLine", () => {
  it("parses the bare line form", () => {
    expect(parseDispositionLine("12: wont-fix")).toEqual({
      path: null,
      line: 12,
      value: "wont-fix",
    });
  });

  it("parses the path form", () => {
    expect(parseDispositionLine("src/app.ts:3: rejected")).toEqual({
      path: "src/app.ts",
      line: 3,
      value: "rejected",
    });
  });

  it("accepts an @-mention and a line prefix", () => {
    expect(parseDispositionLine("@maintainer line 12: verified")).toEqual({
      path: null,
      line: 12,
      value: "verified",
    });
  });

  it("accepts values case-insensitively", () => {
    expect(parseDispositionLine("12: WONT-FIX")).toEqual({
      path: null,
      line: 12,
      value: "wont-fix",
    });
  });

  it("allows a trailing punctuation tail", () => {
    expect(parseDispositionLine("12: accepted-risk.")).toEqual({
      path: null,
      line: 12,
      value: "accepted-risk",
    });
  });

  it("rejects prose, a bare mention, and an unanchored match", () => {
    expect(parseDispositionLine("I think this is fine")).toBeNull();
    expect(parseDispositionLine("12")).toBeNull();
    expect(parseDispositionLine("wont-fix")).toBeNull();
    expect(parseDispositionLine("the line 12 is a wont-fix")).toBeNull();
    expect(parseDispositionLine("12: nope")).toBeNull();
  });

  it("rejects an empty line", () => {
    expect(parseDispositionLine("")).toBeNull();
  });
});

describe("isEligibleReply", () => {
  const author = "pr-author";

  it("accepts an OWNER/COLLABORATOR/MEMBER non-bot reply that is not the PR author", () => {
    for (const association of ["OWNER", "COLLABORATOR", "MEMBER"]) {
      expect(isEligibleReply(reply({ association }), author)).toBe(true);
    }
  });

  it("rejects a bot reply even with an eligible association", () => {
    expect(isEligibleReply(reply({ isBot: true }), author)).toBe(false);
  });

  it("rejects the PR author's own reply — no self-triage", () => {
    expect(isEligibleReply(reply({ login: author }), author)).toBe(false);
  });

  it("rejects a stranger's association", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
      expect(isEligibleReply(reply({ association }), author)).toBe(false);
    }
  });

  it("rejects an empty login, a non-positive id, and an empty createdAt", () => {
    expect(isEligibleReply(reply({ login: "" }), author)).toBe(false);
    expect(isEligibleReply(reply({ id: 0 }), author)).toBe(false);
    expect(isEligibleReply(reply({ id: -3 }), author)).toBe(false);
    expect(isEligibleReply(reply({ createdAt: "" }), author)).toBe(false);
  });
});

describe("dispositionKey", () => {
  it("is the intention, not the fingerprint — ruleId and path only", () => {
    const key = dispositionKey({ ruleId: "r", path: "src/app.ts" });
    expect(key.startsWith("r")).toBe(true);
    expect(key.endsWith("src/app.ts")).toBe(true);
    expect(key).toBe(dispositionKey({ ruleId: "r", path: "src/app.ts" }));
    expect(key).not.toBe(dispositionKey({ ruleId: "r", path: "src/lib.ts" }));
    expect(key).not.toBe(dispositionKey({ ruleId: "other", path: "src/app.ts" }));
  });
});

describe("readDispositions", () => {
  it("reads every parsed disposition from every eligible reply", () => {
    const replies = [
      reply({ id: 1, body: "12: wont-fix" }),
      reply({ id: 2, login: "owner", body: "src/lib.ts:3: rejected" }),
    ];
    const out = readDispositions(
      replies,
      [previous(), previous({ path: "src/lib.ts", line: 3 })],
      AT,
      "pr-author",
    );
    expect(out.size).toBe(2);
    expect(out.get(dispositionKey(previous()))?.value).toBe("wont-fix");
    expect(out.get(dispositionKey(previous({ path: "src/lib.ts", line: 3 })))?.value).toBe(
      "rejected",
    );
  });

  it("keys by intention and records the reply attribution", () => {
    const out = readDispositions(
      [reply({ id: 1, login: "owner", body: "12: verified" })],
      [previous()],
      AT,
      "pr-author",
    );
    const disposition = out.get(dispositionKey(previous()));
    expect(disposition).toEqual({
      value: "verified",
      by: "owner",
      at: "2026-01-01T00:00:00Z",
      replyId: 1,
      replyUrl: "https://github.com/ecoma-io/reeve/pull/42#issuecomment-1",
    });
  });

  it("ignores ineligible replies entirely, even with a matching grammar", () => {
    const replies = [
      reply({ id: 1, isBot: true, body: "12: wont-fix" }),
      reply({ id: 2, association: "NONE", body: "12: wont-fix" }),
      reply({ id: 3, login: "pr-author", body: "12: wont-fix" }),
    ];
    expect(readDispositions(replies, [previous()], AT, "pr-author").size).toBe(0);
  });

  it("the line form matches only when exactly one finding has the line", () => {
    const ambiguous = [previous(), previous({ id: "f2", line: 12 })];
    expect(
      readDispositions([reply({ body: "12: wont-fix" })], ambiguous, AT, "pr-author").size,
    ).toBe(0);
    expect(
      readDispositions([reply({ body: "12: wont-fix" })], [previous()], AT, "pr-author").size,
    ).toBe(1);
  });

  it("the path form matches path and line together", () => {
    const out = readDispositions(
      [reply({ body: "src/other.ts:12: wont-fix" })],
      [previous(), previous({ path: "src/other.ts", line: 12 })],
      AT,
      "pr-author",
    );
    expect(out.size).toBe(1);
    expect(out.get(dispositionKey(previous({ path: "src/other.ts", line: 12 })))?.value).toBe(
      "wont-fix",
    );
  });

  it("a non-matching line never invents a disposition", () => {
    expect(
      readDispositions([reply({ body: "99: wont-fix" })], [previous({ line: 12 })], AT, "pr-author")
        .size,
    ).toBe(0);
  });
});
