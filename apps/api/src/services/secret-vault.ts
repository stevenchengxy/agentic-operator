import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const ENVELOPE_PREFIX = "agentic-secret-v1";
const HEX = /^[0-9a-f]+$/i;

export class SecretVaultError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SecretVaultError";
    this.cause = cause;
  }
}

/** One canonical master-secret resolver for every local encrypted-secret store. */
export function resolveVaultMasterSecret(): string {
  const secret =
    process.env.AGENTIC_KEY_VAULT_SECRET?.trim() ||
    process.env.AUTH_SESSION_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    (process.env.NODE_ENV === "test" ? "test-only-provider-vault-secret" : "");
  if (!secret) {
    throw new SecretVaultError(
      "AGENTIC_KEY_VAULT_SECRET (or AUTH_SESSION_SECRET) is required for encrypted secrets",
    );
  }
  return secret;
}

/** Shared KDF used by the provider-key file and versioned inline envelopes. */
export function deriveVaultKey(
  salt: Buffer,
  masterSecret = resolveVaultMasterSecret(),
): Buffer {
  if (salt.length < 16) {
    throw new SecretVaultError("encrypted secret salt is invalid");
  }
  return scryptSync(masterSecret, salt, 32);
}

function assertPurpose(purpose: string): void {
  if (!purpose || !purpose.trim()) {
    throw new SecretVaultError("encrypted secret purpose is required");
  }
}

/** AES-256-GCM envelope bound to a caller-supplied purpose through AAD. */
export function encryptSecretEnvelope(
  plaintext: string,
  purpose: string,
): string {
  assertPurpose(purpose);
  if (!plaintext) throw new SecretVaultError("secret must not be empty");

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveVaultKey(salt), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    salt.toString("hex"),
    iv.toString("hex"),
    tag.toString("hex"),
    encrypted.toString("hex"),
  ].join(".");
}

/**
 * Decrypt a versioned envelope. Plaintext, malformed, tampered, wrong-purpose,
 * and wrong-master-key inputs all fail closed with a non-sensitive error.
 */
export function decryptSecretEnvelope(
  envelope: string,
  purpose: string,
): string {
  assertPurpose(purpose);
  try {
    const [prefix, saltHex, ivHex, tagHex, cipherHex, ...extra] =
      envelope.split(".");
    if (
      extra.length > 0 ||
      prefix !== ENVELOPE_PREFIX ||
      saltHex?.length !== 32 ||
      ivHex?.length !== 24 ||
      tagHex?.length !== 32 ||
      !cipherHex ||
      cipherHex.length % 2 !== 0 ||
      ![saltHex, ivHex, tagHex, cipherHex].every((part) => HEX.test(part))
    ) {
      throw new Error("invalid envelope structure");
    }

    const salt = Buffer.from(saltHex, "hex");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveVaultKey(salt),
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof SecretVaultError) throw error;
    throw new SecretVaultError(
      "encrypted secret cannot be decrypted or authenticated",
      error,
    );
  }
}
