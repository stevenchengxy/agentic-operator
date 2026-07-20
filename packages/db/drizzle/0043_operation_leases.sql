-- Durable cross-process leases for identity-sensitive runtime mutations and
-- detached Agent Factory work. Expiry permits recovery after an API crash;
-- live owners heartbeat the row and release it on completion.
CREATE TABLE IF NOT EXISTS `operation_leases` (
	`resource_key` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`kind` text NOT NULL,
	`work_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operation_leases_tenant_kind_idx`
	ON `operation_leases` (`tenant_id`,`kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operation_leases_expires_at_idx`
	ON `operation_leases` (`expires_at`);
