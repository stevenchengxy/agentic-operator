import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  SecretVaultError,
} from "./secret-vault";

function purpose(tenantId: string, source: string): string {
  if (!tenantId.trim() || !source.trim()) {
    throw new SecretVaultError(
      "webhook secret requires a tenant id and source",
    );
  }
  return `webhook-signing-secret\0${tenantId}\0${source}`;
}

export function encryptWebhookSigningSecret(args: {
  tenantId: string;
  source: string;
  secret: string;
}): string {
  if (args.secret.length < 16) {
    throw new SecretVaultError(
      "webhook signing secret must be at least 16 bytes",
    );
  }
  return encryptSecretEnvelope(
    args.secret,
    purpose(args.tenantId, args.source),
  );
}

export function decryptWebhookSigningSecret(args: {
  tenantId: string;
  source: string;
  encrypted: string;
}): string {
  const secret = decryptSecretEnvelope(
    args.encrypted,
    purpose(args.tenantId, args.source),
  );
  if (secret.length < 16) {
    throw new SecretVaultError(
      "decrypted webhook signing secret is below the minimum length",
    );
  }
  return secret;
}
