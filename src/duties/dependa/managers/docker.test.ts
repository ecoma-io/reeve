/**
 * Tests for the Docker manager — dependency discovery from Dockerfiles.
 *
 * Deterministic: same Dockerfile content produces the same Dependency list.
 * Tests cover Dockerfile detection, FROM line parsing (including platform
 * flags, AS aliases, scratch, digest references), and applyUpdate.
 *
 * NOTE: The current parseImageRef treats all-digit tag suffixes (e.g. "20"
 * in `node:20`) as registry ports rather than tags. This is a known
 * limitation — tags like `node:20-slim` (not all digits) parse correctly,
 * but `node:20` is parsed as image "node:20" with no tag.
 */
import { describe, expect, it } from "vitest";

import { createDockerManager, isDockerfile } from "./docker.js";

const manager = createDockerManager();

// ── isDockerfile ─────────────────────────────────────────────────────────

describe("isDockerfile", () => {
  it("matches exact Dockerfile", () => {
    expect(isDockerfile("Dockerfile")).toBe("Dockerfile");
  });

  it("matches Dockerfile in a directory", () => {
    expect(isDockerfile("docker/Dockerfile")).toBe("docker/Dockerfile");
  });

  it("matches Dockerfile with suffix", () => {
    expect(isDockerfile("Dockerfile.alpine")).toBe("Dockerfile.alpine");
    expect(isDockerfile("docker/Dockerfile.prod")).toBe("docker/Dockerfile.prod");
  });

  it("matches .Dockerfile extension", () => {
    expect(isDockerfile("dev.Dockerfile")).toBe("dev.Dockerfile");
  });

  it("rejects non-Dockerfile paths", () => {
    expect(isDockerfile("main.go")).toBeNull();
    expect(isDockerfile("README.md")).toBeNull();
  });
});

// ── parse: basic FROM parsing ────────────────────────────────────────────

describe("docker parse", () => {
  it("discovers FROM with a non-numeric tag (e.g. node:20-slim)", () => {
    const content = "FROM node:20-slim\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("node");
    expect(result.dependencies[0]?.constraint).toBe("20-slim");
    expect(result.dependencies[0]?.currentVersion).toBe("20-slim");
    expect(result.dependencies[0]?.dev).toBe(false);
  });

  it("parses all-digit tag correctly (tag colon after last slash)", () => {
    // node:20 — "20" is a tag because the colon is after the last slash
    const content = "FROM node:20\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("node");
    expect(result.dependencies[0]?.constraint).toBe("20");
    expect(result.dependencies[0]?.currentVersion).toBe("20");
  });

  it("parses registry-qualified image with numeric tag", () => {
    // ghcr.io/owner/image:20 — colon after last slash is a tag separator
    const content = "FROM ghcr.io/owner/image:20\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("ghcr.io/owner/image");
    expect(result.dependencies[0]?.constraint).toBe("20");
    expect(result.dependencies[0]?.currentVersion).toBe("20");
  });

  it("treats colon before last slash as registry port", () => {
    // localhost:5000/myimage:tag — first colon is port, second is tag
    const content = "FROM localhost:5000/myimage:latest\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("localhost:5000/myimage");
    expect(result.dependencies[0]?.constraint).toBe("latest");
    expect(result.dependencies[0]?.currentVersion).toBe("latest");
  });

  it("parses registry-qualified image with non-numeric tag", () => {
    const content = "FROM ghcr.io/owner/image:v1.2.3\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("ghcr.io/owner/image");
    expect(result.dependencies[0]?.constraint).toBe("v1.2.3");
  });

  it("parses FROM with a non-numeric tag", () => {
    const content = "FROM node:lts\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("node");
    expect(result.dependencies[0]?.constraint).toBe("lts");
    expect(result.dependencies[0]?.currentVersion).toBe("lts");
  });

  it("parses digest reference", () => {
    const content = "FROM node@sha256:abc123def456\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBeNull();
    expect(result.dependencies[0]?.currentVersion).toBe("sha256:abc123def456");
  });

  it("parses tag+digest reference (non-numeric tag)", () => {
    const content = "FROM node:lts-slim@sha256:abc123\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.constraint).toBe("lts-slim");
    expect(result.dependencies[0]?.currentVersion).toBe("sha256:abc123");
  });

  it("skips FROM scratch", () => {
    const content = "FROM scratch\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(0);
  });

  it("handles --platform flag", () => {
    const content = "FROM --platform=linux/amd64 node:20-slim\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("node");
    expect(result.dependencies[0]?.constraint).toBe("20-slim");
  });

  it("handles AS alias", () => {
    const content = "FROM node:20-slim AS builder\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("node");
    expect(result.dependencies[0]?.constraint).toBe("20-slim");
  });

  it("deduplicates same image:tag", () => {
    const content = `
FROM node:20-slim AS builder
RUN npm install
FROM node:20-slim AS runtime
CMD ["node"]
`;
    const result = manager.parse("Dockerfile", content, null);
    const nodes = result.dependencies.filter((d) => d.name === "node");
    expect(nodes).toHaveLength(1);
  });

  it("handles multi-stage with different tags", () => {
    const content = `
FROM node:20-slim AS builder
FROM node:18-slim AS runtime
`;
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(2);
  });

  it("handles registry-prefixed images", () => {
    const content = "FROM ghcr.io/owner/image:v1\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]?.name).toBe("ghcr.io/owner/image");
    expect(result.dependencies[0]?.constraint).toBe("v1");
  });

  it("is case-insensitive for FROM keyword", () => {
    const content = "from node:lts\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
  });

  it("skips non-FROM lines", () => {
    const content = "RUN echo hello\nCOPY . .\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(0);
  });

  it("returns empty for a Dockerfile with no FROM lines", () => {
    const content = "# Empty Dockerfile\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(0);
  });
});

// ── applyUpdate ──────────────────────────────────────────────────────────

describe("docker applyUpdate", () => {
  const baseProposal = {
    releases: [] as const,
    securityAdvisory: null,
    risk: {
      facts: {
        updateType: "patch" as const,
        majorDistance: 0,
        minorDistance: 0,
        patchDistance: 1,
        daysBetweenReleases: null,
        currentVersionStale: null,
        isSecurity: false,
        hasChangelog: false,
        isDev: false,
      },
      interpretation: null,
    },
    evidence: [] as const,
    edits: [] as const,
    groupName: null,
  };

  it("updates a non-numeric tag reference", () => {
    const content = "FROM node:20-slim\nRUN npm install\n";

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "docker",
        name: "node",
        constraint: "20-slim",
        currentVersion: "20-slim",
        manifestPath: "Dockerfile",
        dev: false,
        manager: "docker",
      },
      currentVersion: "20-slim",
      targetVersion: "22-slim",
      updateType: "major",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("FROM node:22-slim");
    expect(result).not.toContain("FROM node:20-slim");
  });

  it("updates a digest reference", () => {
    const content = "FROM node@sha256:abc123\n";

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "docker",
        name: "node",
        constraint: null,
        currentVersion: "sha256:abc123",
        manifestPath: "Dockerfile",
        dev: false,
        manager: "docker",
      },
      currentVersion: "sha256:abc123",
      targetVersion: "sha256:def456",
      updateType: "digest",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("node@sha256:def456");
  });

  it("returns null when old reference not found", () => {
    const content = "FROM alpine:3.18-slim\n";

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "docker",
        name: "node",
        constraint: "20-slim",
        currentVersion: "20-slim",
        manifestPath: "Dockerfile",
        dev: false,
        manager: "docker",
      },
      currentVersion: "20-slim",
      targetVersion: "22-slim",
      updateType: "major",
    });

    expect(result).toBeNull();
  });

  it("preserves non-FROM lines", () => {
    const content = 'FROM node:20-slim\nRUN npm install\nCMD ["node"]\n';

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "docker",
        name: "node",
        constraint: "20-slim",
        currentVersion: "20-slim",
        manifestPath: "Dockerfile",
        dev: false,
        manager: "docker",
      },
      currentVersion: "20-slim",
      targetVersion: "22-slim",
      updateType: "major",
    });

    expect(result).toContain("RUN npm install");
    expect(result).toContain('CMD ["node"]');
  });

  it("does not corrupt multi-stage Dockerfiles with substring tag matching", () => {
    // node:20 should NOT match node:20-slim
    const content = "FROM node:20 AS builder\nFROM node:20-slim AS runtime\n";

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "docker",
        name: "node",
        constraint: "20",
        currentVersion: "20",
        manifestPath: "Dockerfile",
        dev: false,
        manager: "docker",
      },
      currentVersion: "20",
      targetVersion: "22",
      updateType: "major",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("FROM node:22 AS builder");
    // The -slim variant must NOT be changed
    expect(result).toContain("FROM node:20-slim AS runtime");
    expect(result).not.toContain("node:22-slim");
  });

  it("does not corrupt when updating a variant tag", () => {
    // Updating node:20-slim should NOT affect node:20
    const content = "FROM node:20 AS builder\nFROM node:20-slim AS runtime\n";

    const result = manager.applyUpdate(content, {
      ...baseProposal,
      dependency: {
        ecosystem: "docker",
        name: "node",
        constraint: "20-slim",
        currentVersion: "20-slim",
        manifestPath: "Dockerfile",
        dev: false,
        manager: "docker",
      },
      currentVersion: "20-slim",
      targetVersion: "22-slim",
      updateType: "major",
    });

    expect(result).not.toBeNull();
    // The base image must NOT be changed
    expect(result).toContain("FROM node:20 AS builder");
    expect(result).toContain("FROM node:22-slim AS runtime");
  });
});

// ── parse: no-tag FROM line ─────────────────────────────────────────────

describe("docker parse: no-tag FROM line", () => {
  it("sets constraint to 'latest' when no tag is specified", () => {
    const content = "FROM node\n";
    const result = manager.parse("Dockerfile", content, null);
    expect(result.dependencies).toHaveLength(1);
    // When no tag is specified, both constraint and currentVersion should be "latest"
    // (not constraint=null, which would break pin detection and semver classification)
    expect(result.dependencies[0]?.constraint).toBe("latest");
    expect(result.dependencies[0]?.currentVersion).toBe("latest");
  });
});
