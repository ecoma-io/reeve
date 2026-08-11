import { getOctokit } from "@actions/github";
import { describe, expect, it } from "vitest";

import type { GitHubApi, TrackerApi } from "./forge.js";

// Both ports are declared structurally rather than imported from Octokit, so
// nothing but an assignment proves the real client fits them. A mismatch here
// is a compile error in this repository rather than a run that fails in
// somebody else's workflow, which is the only place the shape would otherwise
// be checked. `getOctokit` builds a client without contacting anything.

describe("the client @actions/github builds", () => {
  it("satisfies the narrow port a duty writing a body is handed", () => {
    const real: GitHubApi = getOctokit("not-a-real-token");

    expect(real.rest.issues.get).toBeTypeOf("function");
    expect(real.rest.issues.update).toBeTypeOf("function");
  });

  it("satisfies the wider port a duty deciding about a thread is handed", () => {
    const real: TrackerApi = getOctokit("not-a-real-token");

    expect(real.rest.issues.addLabels).toBeTypeOf("function");
    expect(real.rest.issues.createComment).toBeTypeOf("function");
    expect(real.rest.issues.addAssignees).toBeTypeOf("function");
    expect(real.rest.issues.listLabelsForRepo).toBeTypeOf("function");
  });
});
