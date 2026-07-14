/**
 * Integration store — CRUD + at-rest encryption for the `integrations` table
 * (Settings → Integrations). The first consumer is the GoHire ATS.
 *
 * API keys are encrypted with AES-256-GCM. The master key is derived with
 * scrypt from `AGENTIC_KEY_VAULT_SECRET` (the same secret the provider-key
 * vault uses, so an operator only manages one secret) and a PER-ROW salt, so
 * two rows never share key material. Only ciphertext + IV + tag + salt land
 * in the DB; the plaintext exists in memory just long enough to encrypt on
 * write or to hand to a tool on read.
 *
 * `resolveCredsByTenantSlug` is the sync seam apps/api injects into
 * `@agentic/tools` (`setIntegrationResolver`) so the GoHire tool family can
 * read a tenant's decrypted base-URL + key at dispatch time without the tools
 * package ever importing the DB. scrypt derivations are cached by salt so the
 * hot path is a single indexed read + a cheap GCM decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";

import { getDb, integrations, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import type { IntegrationCreds } from "@agentic/tools";
import type { IntegrationPublic, IntegrationStatus } from "@agentic/contracts";
import { INTEGRATION_PROVIDERS } from "@agentic/contracts";

interface KeyMaterial {
  keyCipher: string;
  keyIv: string;
  keyTag: string;
  keySalt: string;
}

const derivedKeyCache = new Map<string, Buffer>();

function masterSecret(): string {
  return process.env.AGENTIC_KEY_VAULT_SECRET ?? `dev-vault::${hostname()}`;
}

function deriveKey(saltHex: string): Buffer {
  const cached = derivedKeyCache.get(saltHex);
  if (cached) return cached;
  const key = scryptSync(masterSecret(), Buffer.from(saltHex, "hex"), 32);
  derivedKeyCache.set(saltHex, key);
  return key;
}

function encryptKey(plain: string): KeyMaterial {
  const saltHex = randomBytes(16).toString("hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(saltHex), iv);
  const cipherBuf = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    keyCipher: cipherBuf.toString("hex"),
    keyIv: iv.toString("hex"),
    keyTag: cipher.getAuthTag().toString("hex"),
    keySalt: saltHex,
  };
}

function decryptKey(m: {
  keyCipher: string | null;
  keyIv: string | null;
  keyTag: string | null;
  keySalt: string | null;
}): string | null {
  if (!m.keyCipher || !m.keyIv || !m.keyTag || !m.keySalt) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(m.keySalt),
      Buffer.from(m.keyIv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(m.keyTag, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(m.keyCipher, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    // Wrong master secret / corrupted row — treat as "no key" rather than
    // throwing into a tool call or the Settings list.
    return null;
  }
}

function maskKey(plain: string): string {
  const t = plain.trim();
  if (t.length <= 8) return "***";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

type IntegrationRow = typeof integrations.$inferSelect;

/** Map a DB row to the secret-free public contract shape. */
export function toPublic(row: IntegrationRow): IntegrationPublic {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    baseUrl: row.baseUrl ?? null,
    keyMasked: row.keyMasked ?? null,
    hasKey: Boolean(row.keyCipher),
    status: (row.status as IntegrationStatus) ?? "unconfigured",
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.getTime() : null,
    lastError: row.lastError ?? null,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt ? row.createdAt.getTime() : 0,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : 0,
  };
}

export function listIntegrations(tenantId: string): IntegrationPublic[] {
  const db = getDb();
  const rows = db
    .select()
    .from(integrations)
    .where(eq(integrations.tenantId, tenantId))
    .all();
  return rows.map(toPublic);
}

export function getIntegrationRow(
  tenantId: string,
  provider: string,
): IntegrationRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.provider, provider)))
    .all()[0];
}

export interface UpsertInput {
  tenantId: string;
  provider: string;
  name?: string;
  baseUrl?: string;
  /** Omit to leave the stored key untouched; "" to clear it. */
  apiKey?: string;
  enabled?: boolean;
  createdBy?: string | null;
}

export function upsertIntegration(input: UpsertInput): IntegrationPublic {
  const db = getDb();
  const existing = getIntegrationRow(input.tenantId, input.provider);
  const catalogName =
    INTEGRATION_PROVIDERS.find((p) => p.id === input.provider)?.name ?? input.provider;
  const now = new Date();

  // Key handling: undefined → keep; "" → clear; non-empty → (re)encrypt.
  let keyFields: Partial<KeyMaterial> & { keyMasked?: string | null } = {};
  let keyChanged = false;
  if (typeof input.apiKey === "string") {
    keyChanged = true;
    const trimmed = input.apiKey.trim();
    if (trimmed.length === 0) {
      keyFields = {
        keyCipher: null as unknown as string,
        keyIv: null as unknown as string,
        keyTag: null as unknown as string,
        keySalt: null as unknown as string,
        keyMasked: null,
      };
    } else {
      keyFields = { ...encryptKey(trimmed), keyMasked: maskKey(trimmed) };
    }
  }

  if (existing) {
    const update: Record<string, unknown> = { updatedAt: now };
    if (input.name !== undefined) update.name = input.name;
    if (input.baseUrl !== undefined) update.baseUrl = input.baseUrl;
    if (input.enabled !== undefined) update.enabled = input.enabled;
    if (keyChanged) {
      Object.assign(update, keyFields);
      // A credential change invalidates the cached health result.
      update.status = "unconfigured";
      update.lastError = null;
      update.lastCheckedAt = null;
    }
    db.update(integrations).set(update).where(eq(integrations.id, existing.id)).run();
    return toPublic(getIntegrationRow(input.tenantId, input.provider)!);
  }

  const id = makeId("intg");
  db.insert(integrations)
    .values({
      id,
      tenantId: input.tenantId,
      provider: input.provider,
      name: input.name ?? catalogName,
      baseUrl: input.baseUrl ?? null,
      keyCipher: keyFields.keyCipher ?? null,
      keyIv: keyFields.keyIv ?? null,
      keyTag: keyFields.keyTag ?? null,
      keySalt: keyFields.keySalt ?? null,
      keyMasked: keyFields.keyMasked ?? null,
      status: "unconfigured",
      enabled: input.enabled ?? true,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return toPublic(getIntegrationRow(input.tenantId, input.provider)!);
}

export function deleteIntegration(tenantId: string, provider: string): boolean {
  const db = getDb();
  const existing = getIntegrationRow(tenantId, provider);
  if (!existing) return false;
  db.delete(integrations).where(eq(integrations.id, existing.id)).run();
  return true;
}

export function setIntegrationHealth(
  tenantId: string,
  provider: string,
  status: IntegrationStatus,
  error: string | null,
): void {
  const db = getDb();
  db.update(integrations)
    .set({ status, lastError: error, lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.provider, provider)))
    .run();
}

/** Decrypted creds for a (tenantId, provider). Null when not configured. */
export function getDecryptedCreds(
  tenantId: string,
  provider: string,
): IntegrationCreds | null {
  const row = getIntegrationRow(tenantId, provider);
  if (!row || !row.enabled) return null;
  const api_key = decryptKey(row) ?? undefined;
  const base_url = row.baseUrl ?? undefined;
  if (!api_key && !base_url) return null;
  return { base_url, api_key };
}

/**
 * The sync resolver injected into @agentic/tools at boot. Looks up the
 * tenant by slug, then returns decrypted creds for the provider. Returns
 * null on any miss so the tool falls back to env defaults.
 */
export function resolveCredsByTenantSlug(
  tenantSlug: string,
  provider: string,
): IntegrationCreds | null {
  const db = getDb();
  const tenant = db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!tenant) return null;
  return getDecryptedCreds(tenant.id, provider);
}
