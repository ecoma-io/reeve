import { describe, expect, it } from "vitest";

import { diffEvidence, ruleEvidence } from "./providers.js";

const FILE = {
  path: "src/app.ts",
  lines: new Map<number, string>([
    [1, 'export const VERSION = "1.0.0";'],
    [2, "  console.log(value);"],
  ]),
};

describe("diffEvidence", () => {
  it("proves a matching claimed snippet at the proven line", () => {
    const got = diffEvidence(FILE, 1, 'export const VERSION = "1.0.0";', "abc");
    expect(got).not.toBeNull();
    expect(got?.kind).toBe("diff");
    expect(got?.weight).toBe(1);
    expect(got?.detail).toBe("diff-proven line 1");
    expect(got?.provenance.ruleId).toBe("diff-evidence");
    expect(got?.provenance.ref.sha).toBe("abc");
    expect(got?.provenance.ref.path).toBe("src/app.ts");
  });

  it("returns null when the claimed snippet does not match the proven text", () => {
    expect(diffEvidence(FILE, 1, "export function save(): void {", "abc")).toBeNull();
  });

  it("matches significant text across whitespace, trimmed on both sides", () => {
    expect(diffEvidence(FILE, 2, "console.log(value);", "abc")).not.toBeNull();
    expect(diffEvidence(FILE, 1, `  export const VERSION = "1.0.0";  `, "abc")).not.toBeNull();
  });

  it("accepts either side as a substring of the other — agreement on significant text", () => {
    expect(diffEvidence(FILE, 2, "console.log(value); // careful", "abc")).not.toBeNull();
    expect(diffEvidence(FILE, 2, "value", "abc")).not.toBeNull();
  });

  it("returns null with no line or no claim", () => {
    expect(diffEvidence(FILE, null, "anything", "abc")).toBeNull();
    expect(diffEvidence(FILE, 1, null, "abc")).toBeNull();
    expect(diffEvidence(FILE, 1, "   ", "abc")).toBeNull();
  });
});

describe("ruleEvidence", () => {
  const RULES = {
    rules: [{ id: "dedup" }],
    raw: "version: 1\nrules:\n  - id: dedup\n",
  };

  it("proves a rule the repository's snapshot contains", () => {
    const got = ruleEvidence(RULES, "dedup");
    expect(got).not.toBeNull();
    expect(got?.kind).toBe("rules");
    expect(got?.weight).toBe(0.6);
    expect(got?.detail).toBe("cites a repository rule");
    expect(got?.provenance.ruleId).toBe("dedup");
    expect(got?.provenance.ref.sha).toBe("");
  });

  it("returns null when the rules snapshot has no such rule", () => {
    expect(ruleEvidence(RULES, "nope")).toBeNull();
  });
});
