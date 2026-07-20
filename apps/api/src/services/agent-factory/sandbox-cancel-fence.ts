import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalEvidenceJson } from "@agentic/agent-factory";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
export const SANDBOX_CANCEL_FENCE_SCHEMA =
  "agent-factory-sandbox-cancel-fence/v1" as const;
export const SANDBOX_CANCEL_FENCE_ACK_SCHEMA =
  "agent-factory-sandbox-cancel-fence-ack/v1" as const;

export interface SandboxCancelFence {
  schema: typeof SANDBOX_CANCEL_FENCE_SCHEMA;
  attemptId: string;
  bundleHash: string;
  sandboxTenantSlug: string;
  appId: string;
  fencedAt: string;
  expiresAt: string;
  integrityMac: string;
}

export interface SandboxCancelFenceAckBody {
  schema: typeof SANDBOX_CANCEL_FENCE_ACK_SCHEMA;
  attemptId: string;
  bundleHash: string;
  sandboxTenantSlug: string;
  appId: string;
  status: "cancel_fenced" | "terminal";
  fencedAt: string;
  expiresAt: string;
  terminalStatus?: "completed" | "cancelled" | "failed";
  terminalCompletedAt?: string;
}

export interface SandboxCancelFenceAck extends SandboxCancelFenceAckBody {
  integrityMac: string;
}

function mac(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

function exactMac(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function fenceFile(directory: string, attemptId: string): string {
  if (!SAFE_ID.test(attemptId)) throw new Error("invalid sandbox cancel-fence attempt id");
  return path.join(directory, `${attemptId}.json`);
}

function durableWrite(destination: string, content: string): void {
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let file = -1;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, content, { encoding: "utf8" });
    fsyncSync(file);
  } finally {
    if (file >= 0) closeSync(file);
  }
  renameSync(temporary, destination);
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function verifiedFence(value: unknown, expectedAttemptId: string, secret: string): SandboxCancelFence {
  const fence = value as SandboxCancelFence;
  if (
    !fence
    || fence.schema !== SANDBOX_CANCEL_FENCE_SCHEMA
    || fence.attemptId !== expectedAttemptId
    || !SAFE_ID.test(fence.attemptId)
    || typeof fence.bundleHash !== "string"
    || !fence.bundleHash.trim()
    || !SAFE_ID.test(fence.sandboxTenantSlug)
    || !SAFE_ID.test(fence.appId)
    || !Number.isFinite(Date.parse(fence.fencedAt))
    || !Number.isFinite(Date.parse(fence.expiresAt))
    || Date.parse(fence.expiresAt) <= Date.parse(fence.fencedAt)
  ) throw new Error("sandbox cancel-fence identity is invalid");
  const { integrityMac, ...body } = fence;
  if (!exactMac(integrityMac, mac(secret, body))) {
    throw new Error("sandbox cancel-fence integrity check failed");
  }
  return fence;
}

/** Durable, exact attempt+bundle tombstones on the workload volume. Once an
 * attempt is fenced, the same attempt id can never execute another bundle. */
export class SandboxCancelFenceStore {
  private readonly fences = new Map<string, SandboxCancelFence>();

  constructor(
    private readonly directory: string,
    private readonly integrityKey: string,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("sandbox cancel-fence capacity must be a positive integer");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
      const attemptId = name.slice(0, -5);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
      } catch {
        throw new Error(`sandbox cancel-fence is unreadable: ${name}`);
      }
      const fence = verifiedFence(parsed, attemptId, integrityKey);
      this.fences.set(attemptId, fence);
      if (this.fences.size > maxEntries) {
        throw new Error("sandbox cancel-fence capacity exceeded; verified pruning is required");
      }
    }
  }

  get(attemptId: string): SandboxCancelFence | undefined {
    return this.fences.get(attemptId);
  }

  fence(input: {
    attemptId: string;
    bundleHash: string;
    sandboxTenantSlug: string;
    appId: string;
    expiresAt: string;
  }, now = new Date()): SandboxCancelFence {
    if (
      !SAFE_ID.test(input.attemptId)
      || !input.bundleHash.trim()
      || input.bundleHash.length > 512
      || !SAFE_ID.test(input.sandboxTenantSlug)
      || !SAFE_ID.test(input.appId)
      || !Number.isFinite(Date.parse(input.expiresAt))
      || Date.parse(input.expiresAt) <= now.getTime()
    ) {
      throw new Error("sandbox cancel-fence identity is invalid");
    }
    const existing = this.fences.get(input.attemptId);
    if (existing) {
      if (
        existing.bundleHash !== input.bundleHash
        || existing.sandboxTenantSlug !== input.sandboxTenantSlug
        || existing.appId !== input.appId
      ) {
        throw new Error("sandbox cancel-fence attempt is bound to another bundle");
      }
      return existing;
    }
    if (this.fences.size >= this.maxEntries) {
      throw new Error("sandbox cancel-fence capacity exceeded; verified pruning is required");
    }
    const body: Omit<SandboxCancelFence, "integrityMac"> = {
      schema: SANDBOX_CANCEL_FENCE_SCHEMA,
      attemptId: input.attemptId,
      bundleHash: input.bundleHash,
      sandboxTenantSlug: input.sandboxTenantSlug,
      appId: input.appId,
      fencedAt: now.toISOString(),
      expiresAt: input.expiresAt,
    };
    const fence: SandboxCancelFence = {
      ...body,
      integrityMac: mac(this.integrityKey, body),
    };
    durableWrite(fenceFile(this.directory, input.attemptId), `${JSON.stringify(fence)}\n`);
    this.fences.set(input.attemptId, fence);
    return fence;
  }

  expired(now = new Date(), limit = 64): SandboxCancelFence[] {
    return [...this.fences.values()]
      .filter((fence) => Date.parse(fence.expiresAt) <= now.getTime())
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .slice(0, Math.max(0, limit));
  }

  /** Caller must first prove this exact App absent and that no active/candidate
   * execution owns the attempt. Deletion and directory fsync make pruning a
   * durable compaction, not an in-memory eviction. */
  removeVerifiedExpired(attemptId: string, now = new Date()): boolean {
    const fence = this.fences.get(attemptId);
    if (!fence || Date.parse(fence.expiresAt) > now.getTime()) return false;
    rmSync(fenceFile(this.directory, attemptId), { force: true });
    const parent = openSync(this.directory, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    this.fences.delete(attemptId);
    return true;
  }

  get size(): number {
    return this.fences.size;
  }
}

export function signSandboxCancelFenceAck(
  secret: string,
  body: SandboxCancelFenceAckBody,
): SandboxCancelFenceAck {
  return { ...body, integrityMac: mac(secret, body) };
}

export function verifySandboxCancelFenceAck(
  value: unknown,
  expected: {
    attemptId: string;
    bundleHash: string;
    sandboxTenantSlug: string;
    appId: string;
  },
  secret: string,
): SandboxCancelFenceAck {
  const ack = value as SandboxCancelFenceAck;
  if (
    !ack
    || ack.schema !== SANDBOX_CANCEL_FENCE_ACK_SCHEMA
    || ack.attemptId !== expected.attemptId
    || ack.bundleHash !== expected.bundleHash
    || ack.sandboxTenantSlug !== expected.sandboxTenantSlug
    || ack.appId !== expected.appId
    || !["cancel_fenced", "terminal"].includes(ack.status)
    || !Number.isFinite(Date.parse(ack.fencedAt))
    || !Number.isFinite(Date.parse(ack.expiresAt))
    || (ack.terminalCompletedAt !== undefined
      && !Number.isFinite(Date.parse(ack.terminalCompletedAt)))
  ) throw new Error("sandbox cancel-fence acknowledgement identity is invalid");
  const { integrityMac, ...body } = ack;
  if (!exactMac(integrityMac, mac(secret, body))) {
    throw new Error("sandbox cancel-fence acknowledgement integrity check failed");
  }
  return ack;
}
