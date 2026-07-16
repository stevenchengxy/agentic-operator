/**
 * Provider key vault — persists per-provider API keys outside of `.env`.
 *
 * Keys live at `data/provider-keys.json` (gitignored) encrypted with
 * AES-256-GCM. A master key is derived from `AGENTIC_KEY_VAULT_SECRET`; in
 * dev a stable hostname-based fallback is used so the file decrypts across
 * restarts. Production deployments MUST set the env var.
 *
 * `getProviderKeyOverlay()` returns an env-shaped map so the existing
 * `resolveConfig()` in `@agentic/llm-gateway` continues to be the single
 * place that knows how to read provider env. This way the rest of the
 * gateway is untouched.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROVIDER_IDS, type ProviderId } from "@agentic/contracts";

function defaultVaultPath(): string {
  if (process.env.AGENTIC_KEY_VAULT_PATH) return process.env.AGENTIC_KEY_VAULT_PATH;
  // Co-locate with the SQLite db. `DATABASE_URL` is `file:<path>` per
  // packages/db/client.ts; strip the prefix and use the same directory so
  // logs/db/vault all live under one `data/` tree regardless of cwd.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && dbUrl.startsWith("file:")) {
    return join(dirname(dbUrl.slice(5)), "provider-keys.json");
  }
  return join(process.cwd(), "data", "provider-keys.json");
}

const VAULT_PATH = defaultVaultPath();

const ENV_VAR_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  zai: "ZAI_API_KEY",
  qwen: "QWEN_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  custom: "CUSTOM_LLM_API_KEY",
};

export type KeyScope = "workspace" | "tenant";

export interface ProviderKeyRecord {
  provider: ProviderId;
  scope: KeyScope;
  tenantId?: string;
  setBy: string | null;
  setAt: number;
  keyMasked: string;
  /** AES-256-GCM ciphertext. Stored as hex. */
  cipherHex: string;
  /** 12-byte IV. Stored as hex. */
  ivHex: string;
  /** 16-byte auth tag. Stored as hex. */
  tagHex: string;
}

interface VaultFile {
  /** 16-byte salt for scrypt KDF. Generated on first write. */
  saltHex: string;
  records: ProviderKeyRecord[];
}

let cache: VaultFile | null = null;
let masterKey: Buffer | null = null;

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

function deriveMasterKey(salt: Buffer): Buffer {
  const secret =
    process.env.AGENTIC_KEY_VAULT_SECRET ??
    `dev-vault::${hostname()}`;
  return scryptSync(secret, salt, 32);
}

function loadVault(): VaultFile {
  if (cache) return cache;
  if (!existsSync(VAULT_PATH)) {
    const v: VaultFile = { saltHex: randomBytes(16).toString("hex"), records: [] };
    cache = v;
    return v;
  }
  try {
    const raw = readFileSync(VAULT_PATH, "utf8");
    const parsed = JSON.parse(raw) as VaultFile;
    if (!parsed.saltHex || !Array.isArray(parsed.records)) {
      throw new Error("malformed vault file");
    }
    cache = parsed;
    return parsed;
  } catch (err) {
    throw new Error(
      `provider-keys vault at ${VAULT_PATH} is unreadable: ${(err as Error).message}`,
    );
  }
}

function getMasterKey(vault: VaultFile): Buffer {
  if (masterKey) return masterKey;
  masterKey = deriveMasterKey(Buffer.from(vault.saltHex, "hex"));
  return masterKey;
}

function persist(vault: VaultFile): void {
  mkdirSync(dirname(VAULT_PATH), { recursive: true });
  writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 });
  cache = vault;
}

function encrypt(plain: string, vault: VaultFile): Pick<ProviderKeyRecord, "cipherHex" | "ivHex" | "tagHex"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(vault), iv);
  const cipherBuf = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipherHex: cipherBuf.toString("hex"),
    ivHex: iv.toString("hex"),
    tagHex: tag.toString("hex"),
  };
}

function decrypt(rec: ProviderKeyRecord, vault: VaultFile): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getMasterKey(vault),
    Buffer.from(rec.ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(rec.tagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(rec.cipherHex, "hex")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

function maskKey(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/**
 * Returns the plaintext key for a provider, preferring the vault over env.
 *
 * P5-TEN-01 — tenant-aware lookup. Precedence:
 *   1. vault record with `scope='tenant'` AND matching `tenantId`
 *   2. vault record with `scope='workspace'` (platform-wide override)
 *   3. environment variable
 *
 * Prior implementation returned the FIRST record matching `provider`, which
 * silently let a tenant-scoped record from tenant A become the de-facto
 * workspace default — a cross-tenant credentials bleed. The new precedence
 * requires an explicit tenant match before tenant-scoped records apply, and
 * never falls through to a different tenant's key.
 */
export function getProviderKey(
  id: ProviderId,
  tenantId?: string,
): string | null {
  const vault = loadVault();

  // 1. Tenant-scoped exact match (only when a tenantId is supplied)
  if (tenantId) {
    const tenantRec = vault.records.find(
      (r) => r.provider === id && r.scope === "tenant" && r.tenantId === tenantId,
    );
    if (tenantRec) {
      try {
        return decrypt(tenantRec, vault);
      } catch {
        return null;
      }
    }
  }

  // 2. Workspace-scoped record (platform default)
  const workspaceRec = vault.records.find(
    (r) => r.provider === id && r.scope === "workspace",
  );
  if (workspaceRec) {
    try {
      return decrypt(workspaceRec, vault);
    } catch {
      return null;
    }
  }

  // 3. Fallback: a tenant-scoped record IGNORING tenant id should NOT be
  // used (that's the bleed we are closing). Skip to env.

  const envVar = ENV_VAR_BY_PROVIDER[id];
  if (envVar) {
    const v = process.env[envVar];
    if (v && v.trim().length > 0) return v;
  }
  return null;
}

/** Public-safe view: masked key + metadata, no plaintext. */
export interface ProviderKeyMeta {
  provider: ProviderId;
  hasKey: boolean;
  source: "vault" | "env" | "none";
  keyMasked: string | null;
  scope: KeyScope | null;
  setBy: string | null;
  setAt: number | null;
}

export function getProviderKeyMeta(id: ProviderId): ProviderKeyMeta {
  const vault = loadVault();
  const rec = vault.records.find((r) => r.provider === id);
  if (rec) {
    return {
      provider: id,
      hasKey: true,
      source: "vault",
      keyMasked: rec.keyMasked,
      scope: rec.scope,
      setBy: rec.setBy,
      setAt: rec.setAt,
    };
  }
  const envVar = ENV_VAR_BY_PROVIDER[id];
  if (envVar) {
    const v = process.env[envVar];
    if (v && v.trim().length > 0) {
      return {
        provider: id,
        hasKey: true,
        source: "env",
        keyMasked: maskKey(v),
        scope: "workspace",
        setBy: null,
        setAt: null,
      };
    }
  }
  return {
    provider: id,
    hasKey: false,
    source: "none",
    keyMasked: null,
    scope: null,
    setBy: null,
    setAt: null,
  };
}

export function listProviderKeyMeta(): ProviderKeyMeta[] {
  return PROVIDER_IDS.map((id) => getProviderKeyMeta(id));
}

export interface SetProviderKeyInput {
  apiKey: string;
  scope: KeyScope;
  tenantId?: string;
  setBy: string | null;
}

export function setProviderKey(
  id: ProviderId,
  input: SetProviderKeyInput,
): ProviderKeyMeta {
  if (!isProviderId(id)) {
    throw new Error(`unknown provider: ${id}`);
  }
  const key = (input.apiKey ?? "").trim();
  if (key.length < 8) {
    throw new Error("API key is too short");
  }
  const vault = loadVault();
  const enc = encrypt(key, vault);
  const next: ProviderKeyRecord = {
    provider: id,
    scope: input.scope,
    tenantId: input.tenantId,
    setBy: input.setBy,
    setAt: Date.now(),
    keyMasked: maskKey(key),
    ...enc,
  };
  const others = vault.records.filter((r) => r.provider !== id);
  persist({ saltHex: vault.saltHex, records: [...others, next] });
  return {
    provider: id,
    hasKey: true,
    source: "vault",
    keyMasked: next.keyMasked,
    scope: next.scope,
    setBy: next.setBy,
    setAt: next.setAt,
  };
}

export function deleteProviderKey(id: ProviderId): boolean {
  const vault = loadVault();
  const before = vault.records.length;
  const after = vault.records.filter((r) => r.provider !== id);
  if (after.length === before) return false;
  persist({ saltHex: vault.saltHex, records: after });
  return true;
}

/**
 * Env-shaped overlay merging vault contents on top of `process.env`. Pass
 * to `resolveConfig()` so the gateway sees vault keys without us mutating
 * `process.env` (which would leak across tests).
 */
export function getProviderKeyEnvOverlay(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const id of PROVIDER_IDS) {
    const envVar = ENV_VAR_BY_PROVIDER[id];
    if (!envVar) continue;
    const key = getProviderKey(id);
    if (key) out[envVar] = key;
  }
  return out;
}

/** Test-only — drop the in-memory cache so the next read re-loads from disk. */
export function _resetProviderKeyVaultCache(): void {
  cache = null;
  masterKey = null;
}
