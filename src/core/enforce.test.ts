import { describe, expect, it } from "vitest";

import { enforceLabels, narrow, owners, parseApply } from "./enforce.js";
import { parseWarrant, type Warrant } from "./warrant.js";

// Nothing is mocked, and nothing here can be: every function in this module is
// a decision about a parsed file and a list of strings. That is the point of
// the stage — it is the one place a verdict stops being a suggestion, so it is
// the one place that must be decidable without a network.

const WARRANT = parseWarrant(
  ".github/reeve.yml",
  `
version: 1
labels:
  - name: bug
    description: Released behaviour contradicts its documentation.
    owner: "@maintainer"
  - name: needs reproduction
    description: A plausible defect report without enough to reproduce it.
    exclusive_with: [bug]
  - name: performance
    description: Correct behaviour that is too slow.
    owner: "@ecoma-io/runtime"
  - name: documentation
    description: The docs describe something else.
    owner: "@maintainer"
`,
);

function decide(
  proposed: readonly string[],
  onThread: readonly string[] = [],
  w: Warrant = WARRANT,
) {
  return enforceLabels(w, proposed, onThread);
}

describe("parseApply", () => {
  it("reads a list in the order it was written", () => {
    expect(parseApply("label, comment")).toEqual(["label", "comment"]);
  });

  it("reads a newline-separated list, which is how a workflow file writes a long one", () => {
    expect(parseApply("label\ncomment\n")).toEqual(["label", "comment"]);
  });

  it("reads `none` as granting nothing", () => {
    expect(parseApply("none")).toEqual([]);
  });

  it("ignores case and surrounding space", () => {
    expect(parseApply("  Label ,  CLOSE ")).toEqual(["label", "close"]);
  });

  it("grants a repeated capability once", () => {
    expect(parseApply("label,label")).toEqual(["label"]);
  });

  it("refuses a misspelling rather than silently granting nothing", () => {
    // `GITHUB_TOKEN` cannot express "labels but not comments", so this list is
    // one of the two things standing between a verdict and the tracker. A bug a
    // maintainer discovers as an absence is the hardest kind to notice.
    expect(() => parseApply("coment")).toThrow(/`coment` is not something a duty/);
  });

  it("refuses an empty value, because granting nothing has to be said", () => {
    expect(() => parseApply("  ")).toThrow(/Use `none` to grant nothing, explicitly/);
  });
});

describe("narrow", () => {
  it("keeps only what both authorities allow", () => {
    const result = narrow(["label", "comment"], ["label", "close"]);

    expect(result.permitted).toEqual(["label"]);
  });

  it("reports what the workflow asked for and the file does not grant", () => {
    // Not an error — the file is the authority — but a silence a maintainer
    // would read as a broken action.
    expect(narrow(["label"], ["label", "comment"]).withheld).toEqual(["comment"]);
  });

  it("lets a workflow restrict what the file granted", () => {
    expect(narrow(["label", "comment", "close"], ["label"])).toEqual({
      permitted: ["label"],
      withheld: [],
    });
  });

  it("lets a workflow grant nothing at all", () => {
    expect(narrow(["label", "comment"], []).permitted).toEqual([]);
  });

  it("keeps the file's order, so the report reads the way the authority does", () => {
    expect(narrow(["label", "comment", "close"], ["close", "label"]).permitted).toEqual([
      "label",
      "close",
    ]);
  });
});

describe("enforceLabels", () => {
  it("applies what the warrant names, in the verdict's own order", () => {
    expect(decide(["performance", "bug"]).applied).toEqual(["performance", "bug"]);
  });

  it("drops a label the warrant does not name", () => {
    // The single check that makes injected text unable to invent an outcome.
    // Text can persuade a model; it cannot add a name to a file it is not in.
    const result = decide(["bug", "security"]);

    expect(result.applied).toEqual(["bug"]);
    expect(result.refused).toEqual([
      { what: "security", why: "`.github/reeve.yml` does not name it" },
    ]);
  });

  it("drops a label that differs only in case, because GitHub applies names exactly", () => {
    expect(decide(["Bug"]).applied).toEqual([]);
  });

  it("proposes a repeated label once and says nothing about it", () => {
    expect(decide(["bug", "bug"])).toEqual({ applied: ["bug"], refused: [] });
  });

  it("does not re-apply a label the thread already carries", () => {
    const result = decide(["bug", "performance"], ["bug"]);

    expect(result.applied).toEqual(["performance"]);
    expect(result.refused[0]).toEqual({ what: "bug", why: "the thread already carries it" });
  });

  it("resolves an exclusive conflict between two proposals in the verdict's order", () => {
    // Asking the model to resolve its own conflict is asking the least reliable
    // participant the hardest question.
    expect(decide(["bug", "needs reproduction"]).applied).toEqual(["bug"]);
    expect(decide(["needs reproduction", "bug"]).applied).toEqual(["needs reproduction"]);
  });

  it("enforces exclusivity in both directions, whichever side wrote the rule", () => {
    // A warrant that wrote the rule on one of the pair means the same thing as
    // one that wrote it on both.
    const result = decide(["bug", "needs reproduction"]);

    expect(result.refused[0]?.why).toBe("it cannot be applied alongside `bug`");
  });

  it("resolves an exclusive conflict with a maintainer's label in the maintainer's favour", () => {
    // A label a human applied is a decision, and no input turns overruling it
    // on.
    const result = decide(["needs reproduction"], ["bug"]);

    expect(result.applied).toEqual([]);
    expect(result.refused[0]?.why).toBe("the thread already carries `bug`, which excludes it");
  });

  it("applies nothing when the verdict proposed nothing", () => {
    expect(decide([])).toEqual({ applied: [], refused: [] });
  });

  it("applies nothing against an empty taxonomy, whatever the verdict said", () => {
    const empty = parseWarrant(".github/reeve.yml", "version: 1\n");

    expect(decide(["bug"], [], empty).applied).toEqual([]);
  });
});

describe("owners", () => {
  it("names the handle the taxonomy gave the applied label", () => {
    expect(owners(WARRANT, ["bug"])).toEqual({ users: ["maintainer"], teams: [] });
  });

  it("strips the `@`, which the API does not take", () => {
    expect(owners(WARRANT, ["bug"]).users).toEqual(["maintainer"]);
  });

  it("names one person once, however many of their labels were applied", () => {
    expect(owners(WARRANT, ["bug", "documentation"]).users).toEqual(["maintainer"]);
  });

  it("keeps a team apart, because an issue cannot be assigned to one", () => {
    // GitHub's assignee endpoint takes usernames; team assignment exists only
    // as a review request on a pull request. The warrant is not wrong about who
    // owns the area — the tracker has no field for it.
    expect(owners(WARRANT, ["performance"])).toEqual({ users: [], teams: ["ecoma-io/runtime"] });
  });

  it("says nothing about a label with no owner", () => {
    expect(owners(WARRANT, ["needs reproduction"])).toEqual({ users: [], teams: [] });
  });

  it("says nothing about a label the warrant does not name", () => {
    expect(owners(WARRANT, ["security"])).toEqual({ users: [], teams: [] });
  });
});
