-- P3-RT-04 — per-tenant webhook subscriptions.
--
-- One row per (tenant, source). The `source` is a URL-safe slug taken from
-- the `:source` segment of `POST /v1/webhooks/:source`; the runtime resolves
-- it against this table to pick the tenant + per-tenant secret.
--
-- Anti-replay: the request id (a header-supplied idempotency token, or the
-- signature digest as a fallback) is checked against a small dedupe TTL
-- window inside the route handler; we don't persist replay state in this
-- table — keep the row clean for ops introspection.
--
-- `secret_encrypted` stores a versioned AES-256-GCM envelope. The ciphertext
-- is authenticated against tenant_id + source and cannot be used directly as
-- an HMAC key. Plaintext/legacy values fail closed at ingestion.
--
-- A partial unique constraint on (tenant_id, source) WHERE enabled = 1 keeps
-- a single live subscription per source per tenant; disabled rows are kept
-- around for audit + future re-enable.
CREATE TABLE `webhook_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `source` text NOT NULL,
  `secret_encrypted` text NOT NULL,
  `signing_algo` text DEFAULT 'hmac-sha256' NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_sub_tenant_source_uq` ON `webhook_subscriptions` (`tenant_id`, `source`) WHERE `enabled` = 1;
--> statement-breakpoint
CREATE INDEX `webhook_sub_source_idx` ON `webhook_subscriptions` (`source`) WHERE `enabled` = 1;
--> statement-breakpoint
UPDATE `_meta` SET `value` = '7', `updated_at` = (unixepoch() * 1000) WHERE `key` = 'schema_version';
