import { createHash } from "node:crypto";

import {
  DockerSocketCodeActTransport,
  type CodeActDockerAdmin,
  type CodeActOrphanCandidate,
} from "@agentic/runtime";

export interface SandboxCodeActReaperTelemetry {
  lastCandidateReaperAt: string | null;
  candidateReaperFailure: string | null;
  orphanCandidates: number;
  oldestCandidateOrphanAgeMs: number | null;
  candidateCleanupReady: boolean;
  removedCandidates: number;
}

export interface SandboxCodeActCandidateReaperLike {
  reconcile(input: {
    startup?: boolean;
    activeAttemptIds: ReadonlySet<string>;
  }): Promise<SandboxCodeActReaperTelemetry>;
  telemetry(): SandboxCodeActReaperTelemetry;
  start(activeAttemptIds: () => ReadonlySet<string>): void;
  stop(): void;
}

function boundedMs(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be ${minimum}-${maximum}`);
  }
  return value;
}

function attemptHash(attemptId: string): string {
  return `sha256:${createHash("sha256").update(attemptId, "utf8").digest("hex")}`;
}

export class SandboxCodeActCandidateReaper implements SandboxCodeActCandidateReaperLike {
  private readonly admin: CodeActDockerAdmin;
  private readonly intervalMs: number;
  private readonly orphanGraceMs: number;
  private readonly now: () => Date;
  private current: SandboxCodeActReaperTelemetry = {
    lastCandidateReaperAt: null,
    candidateReaperFailure: "candidate reaper has not completed",
    orphanCandidates: 0,
    oldestCandidateOrphanAgeMs: null,
    candidateCleanupReady: false,
    removedCandidates: 0,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<SandboxCodeActReaperTelemetry> | null = null;

  constructor(input: {
    admin?: CodeActDockerAdmin;
    intervalMs?: number;
    orphanGraceMs?: number;
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
  } = {}) {
    const env = input.env ?? process.env;
    this.admin = input.admin ?? new DockerSocketCodeActTransport();
    this.intervalMs = input.intervalMs ?? boundedMs(
      env.FACTORY_SANDBOX_REAPER_MS,
      60_000,
      5_000,
      10 * 60_000,
      "FACTORY_SANDBOX_REAPER_MS",
    );
    this.orphanGraceMs = input.orphanGraceMs ?? boundedMs(
      env.FACTORY_SANDBOX_CODEACT_ORPHAN_GRACE_MS,
      120_000,
      30_000,
      20 * 60_000,
      "FACTORY_SANDBOX_CODEACT_ORPHAN_GRACE_MS",
    );
    this.now = input.now ?? (() => new Date());
  }

  telemetry(): SandboxCodeActReaperTelemetry {
    return { ...this.current };
  }

  async reconcile(input: {
    startup?: boolean;
    activeAttemptIds: ReadonlySet<string>;
  }): Promise<SandboxCodeActReaperTelemetry> {
    if (this.running) return this.running;
    this.running = this.reconcileOnce(input).finally(() => { this.running = null; });
    return this.running;
  }

  private async reconcileOnce(input: {
    startup?: boolean;
    activeAttemptIds: ReadonlySet<string>;
  }): Promise<SandboxCodeActReaperTelemetry> {
    try {
      await this.admin.ping();
      const nowMs = this.now().getTime();
      const activeHashes = new Set([...input.activeAttemptIds].map(attemptHash));
      const isActive = (candidate: CodeActOrphanCandidate): boolean => {
        const hash = candidate.labels["io.agentic.attempt-id-hash"];
        return Boolean(hash) && activeHashes.has(hash!);
      };
      const candidates = await this.admin.listCandidates("factory-sandbox");
      let removed = 0;
      for (const candidate of candidates) {
        if (isActive(candidate)) continue;
        const ageMs = candidate.createdAtMs > 0
          ? Math.max(0, nowMs - candidate.createdAtMs)
          : Number.POSITIVE_INFINITY;
        if (!input.startup && ageMs < this.orphanGraceMs) continue;
        await this.admin.removeContainer(candidate.id);
        if (await this.admin.inspectContainer(candidate.id)) {
          throw new Error(`factory sandbox candidate ${candidate.id.slice(0, 12)} remains after removal`);
        }
        removed += 1;
      }
      const remaining = (await this.admin.listCandidates("factory-sandbox"))
        .filter((candidate) => !isActive(candidate));
      const ages = remaining.map((candidate) => candidate.createdAtMs > 0
        ? Math.max(0, nowMs - candidate.createdAtMs)
        : 0);
      this.current = {
        lastCandidateReaperAt: this.now().toISOString(),
        candidateReaperFailure: null,
        orphanCandidates: remaining.length,
        oldestCandidateOrphanAgeMs: ages.length ? Math.max(...ages) : null,
        candidateCleanupReady: remaining.length === 0,
        removedCandidates: this.current.removedCandidates + removed,
      };
      return this.telemetry();
    } catch (error) {
      this.current = {
        ...this.current,
        candidateReaperFailure: String((error as Error)?.message ?? error).slice(0, 800),
        candidateCleanupReady: false,
      };
      return this.telemetry();
    }
  }

  start(activeAttemptIds: () => ReadonlySet<string>): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcile({ activeAttemptIds: activeAttemptIds() });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
