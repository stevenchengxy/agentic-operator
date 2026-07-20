-- External-service integrations configured per tenant in Settings →
-- Integrations (first consumer: the GoHire ATS). One row per (tenant,
-- provider). The API key is encrypted at rest with AES-256-GCM — only the
-- ciphertext + IV + auth tag + per-row KDF salt are stored, never the
-- plaintext. `key_masked` is a display-safe fragment for the UI. The decrypt
-- path lives in apps/api (services/integration-store.ts); the GoHire tool
-- family reads the decrypted creds through the injected
-- `resolveIntegrationCreds` seam in @agentic/tools.
--
-- `base_url` + key columns are nullable so a row can be half-configured
-- (base URL saved, key pending). `status` caches the last connection-test
-- result so the Settings list shows a health pill without re-probing.

CREATE TABLE IF NOT EXISTS `integrations` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `provider` text NOT NULL,
  `name` text NOT NULL,
  `base_url` text,
  `key_cipher` text,
  `key_iv` text,
  `key_tag` text,
  `key_salt` text,
  `key_masked` text,
  `status` text NOT NULL DEFAULT 'unconfigured',
  `last_checked_at` integer,
  `last_error` text,
  `enabled` integer NOT NULL DEFAULT 1,
  `created_by` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `integration_tenant_provider_uq`
  ON `integrations` (`tenant_id`, `provider`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_tenant_idx`
  ON `integrations` (`tenant_id`);
