import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type {
  CodeActDockerAdmin,
  CodeActOrphanCandidate,
} from "@agentic/runtime";

import { SandboxCodeActCandidateReaper } from "../src/services/agent-factory/sandbox-codeact-reaper";

function hash(attemptId: string): string {
  return `sha256:${createHash("sha256").update(attemptId).digest("hex")}`;
}

function candidate(id: string, createdAtMs: number, attemptId?: string): CodeActOrphanCandidate {
  return {
    id: id.repeat(64).slice(0, 64),
    createdAtMs,
    state: "exited",
    labels: {
      "io.agentic.role": "codeact-candidate",
      "io.agentic.execution-plane": "factory-sandbox",
      ...(attemptId ? { "io.agentic.attempt-id-hash": hash(attemptId) } : {}),
    },
  };
}

function admin(initial: CodeActOrphanCandidate[], failRemove = false) {
  let rows = [...initial];
  const removed: string[] = [];
  const value: CodeActDockerAdmin = {
    async ping() {},
    async inspectImage() { return { Id: `sha256:${"f".repeat(64)}` }; },
    async listCandidates(plane) {
      return plane === "factory-sandbox" ? [...rows] : [];
    },
    async inspectContainer(id) { return rows.some((row) => row.id === id) ? {} as never : null; },
    async removeContainer(id) {
      if (failRemove) throw new Error("docker remove denied");
      removed.push(id);
      rows = rows.filter((row) => row.id !== id);
    },
  };
  return { value, removed, rows: () => [...rows] };
}

describe("factory sandbox CodeAct candidate reaper", () => {
  it("removes every non-active leftover on startup and verifies absence", async () => {
    const docker = admin([
      candidate("a", Date.parse("2026-07-16T00:00:00Z")),
      candidate("b", Date.parse("2026-07-16T00:00:01Z"), "crashed-attempt"),
    ]);
    const reaper = new SandboxCodeActCandidateReaper({
      admin: docker.value,
      now: () => new Date("2026-07-16T00:01:00Z"),
      intervalMs: 5_000,
      orphanGraceMs: 30_000,
    });
    await expect(reaper.reconcile({ startup: true, activeAttemptIds: new Set() }))
      .resolves.toMatchObject({
        candidateCleanupReady: true,
        orphanCandidates: 0,
        removedCandidates: 2,
        candidateReaperFailure: null,
      });
    expect(docker.removed).toHaveLength(2);
    expect(docker.rows()).toEqual([]);
  });

  it("never reaps an active attempt, then cleans it after it becomes an old orphan", async () => {
    const attemptId = "attempt-active-1";
    const docker = admin([candidate("c", Date.parse("2026-07-16T00:00:00Z"), attemptId)]);
    const reaper = new SandboxCodeActCandidateReaper({
      admin: docker.value,
      now: () => new Date("2026-07-16T00:02:00Z"),
      intervalMs: 5_000,
      orphanGraceMs: 30_000,
    });
    await reaper.reconcile({ activeAttemptIds: new Set([attemptId]) });
    expect(docker.removed).toEqual([]);
    expect(reaper.telemetry()).toMatchObject({ candidateCleanupReady: true, orphanCandidates: 0 });

    await reaper.reconcile({ activeAttemptIds: new Set() });
    expect(docker.removed).toHaveLength(1);
    expect(reaper.telemetry()).toMatchObject({ candidateCleanupReady: true, orphanCandidates: 0 });
  });

  it("keeps cleanup readiness red when Docker removal fails", async () => {
    const docker = admin([candidate("d", 0)], true);
    const reaper = new SandboxCodeActCandidateReaper({
      admin: docker.value,
      now: () => new Date("2026-07-16T00:02:00Z"),
      intervalMs: 5_000,
      orphanGraceMs: 30_000,
    });
    await expect(reaper.reconcile({ startup: true, activeAttemptIds: new Set() }))
      .resolves.toMatchObject({
        candidateCleanupReady: false,
        candidateReaperFailure: expect.stringContaining("docker remove denied"),
      });
    expect(docker.rows()).toHaveLength(1);
  });
});
