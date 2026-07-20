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

export const SANDBOX_GATEWAY_TOMBSTONE_SCHEMA =
  "agent-factory-sandbox-gateway-tombstone/v1" as const;

const SAFE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$/;
const FACTORY_SANDBOX_SLUG = /^af-sbx-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{12}-sb$/;

export interface SandboxGatewayTombstone {
  schema: typeof SANDBOX_GATEWAY_TOMBSTONE_SCHEMA;
  appId: string;
  sandboxTenantSlug: string;
  fencedAt: string;
  expiresAt: string;
  integrityMac: string;
}

function evidenceMac(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

function exactMac(actual: unknown, expected: string): boolean {
  return typeof actual === "string"
    && /^[a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function tombstoneFile(directory: string, appId: string): string {
  if (!SAFE_APP_ID.test(appId)) throw new Error("invalid sandbox gateway App identity");
  return path.join(directory, `${appId}.json`);
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

function verifiedTombstone(
  value: unknown,
  expectedAppId: string,
  integrityKey: string,
): SandboxGatewayTombstone {
  const tombstone = value as SandboxGatewayTombstone;
  if (
    !tombstone
    || tombstone.schema !== SANDBOX_GATEWAY_TOMBSTONE_SCHEMA
    || tombstone.appId !== expectedAppId
    || !SAFE_APP_ID.test(tombstone.appId)
    || !FACTORY_SANDBOX_SLUG.test(tombstone.sandboxTenantSlug)
    || !Number.isFinite(Date.parse(tombstone.fencedAt))
    || !Number.isFinite(Date.parse(tombstone.expiresAt))
    || Date.parse(tombstone.expiresAt) <= Date.parse(tombstone.fencedAt)
  ) throw new Error("sandbox gateway tombstone identity is invalid");
  const { integrityMac, ...body } = tombstone;
  if (!exactMac(integrityMac, evidenceMac(integrityKey, body))) {
    throw new Error("sandbox gateway tombstone integrity check failed");
  }
  return tombstone;
}

/** Persistent anti-resurrection state owned only by the broker gateway.
 * Capacity exhaustion and corrupt state both fail startup/installation closed;
 * expiry merely makes an entry eligible for evidence-backed pruning. */
export class SandboxGatewayTombstoneStore {
  private readonly tombstones = new Map<string, SandboxGatewayTombstone>();

  constructor(
    private readonly directory: string,
    private readonly integrityKey: string,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("sandbox gateway tombstone capacity must be a positive integer");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
      const appId = name.slice(0, -5);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
      } catch {
        throw new Error(`sandbox gateway tombstone is unreadable: ${name}`);
      }
      this.tombstones.set(appId, verifiedTombstone(parsed, appId, integrityKey));
      if (this.tombstones.size > maxEntries) {
        throw new Error("sandbox gateway tombstone capacity exceeded; verified pruning is required");
      }
    }
  }

  get(appId: string): SandboxGatewayTombstone | undefined {
    return this.tombstones.get(appId);
  }

  fence(input: {
    appId: string;
    sandboxTenantSlug: string;
    expiresAt: string;
  }, now = new Date()): SandboxGatewayTombstone {
    if (
      !SAFE_APP_ID.test(input.appId)
      || !FACTORY_SANDBOX_SLUG.test(input.sandboxTenantSlug)
      || !Number.isFinite(Date.parse(input.expiresAt))
      || Date.parse(input.expiresAt) <= now.getTime()
    ) throw new Error("sandbox gateway tombstone identity/expiry is invalid");
    const existing = this.tombstones.get(input.appId);
    if (existing && existing.sandboxTenantSlug !== input.sandboxTenantSlug) {
      throw new Error("sandbox gateway tombstone App identity collision");
    }
    if (!existing && this.tombstones.size >= this.maxEntries) {
      throw new Error("sandbox gateway tombstone capacity exceeded; verified pruning is required");
    }
    const expiresAt = existing && Date.parse(existing.expiresAt) >= Date.parse(input.expiresAt)
      ? existing.expiresAt
      : input.expiresAt;
    if (existing && expiresAt === existing.expiresAt) return existing;
    const body: Omit<SandboxGatewayTombstone, "integrityMac"> = {
      schema: SANDBOX_GATEWAY_TOMBSTONE_SCHEMA,
      appId: input.appId,
      sandboxTenantSlug: input.sandboxTenantSlug,
      fencedAt: existing?.fencedAt ?? now.toISOString(),
      expiresAt,
    };
    const tombstone: SandboxGatewayTombstone = {
      ...body,
      integrityMac: evidenceMac(this.integrityKey, body),
    };
    durableWrite(tombstoneFile(this.directory, input.appId), `${JSON.stringify(tombstone)}\n`);
    this.tombstones.set(input.appId, tombstone);
    return tombstone;
  }

  expired(now = new Date(), limit = 64): SandboxGatewayTombstone[] {
    return [...this.tombstones.values()]
      .filter((entry) => Date.parse(entry.expiresAt) <= now.getTime())
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .slice(0, Math.max(0, limit));
  }

  removeVerifiedExpired(appId: string, now = new Date()): boolean {
    const existing = this.tombstones.get(appId);
    if (!existing || Date.parse(existing.expiresAt) > now.getTime()) return false;
    rmSync(tombstoneFile(this.directory, appId), { force: true });
    const parent = openSync(this.directory, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    this.tombstones.delete(appId);
    return true;
  }

  get size(): number {
    return this.tombstones.size;
  }
}
