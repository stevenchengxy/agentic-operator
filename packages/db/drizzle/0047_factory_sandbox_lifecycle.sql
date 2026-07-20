CREATE TABLE `factory_sandbox_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_tenant_id` text NOT NULL,
	`owner_tenant_slug` text NOT NULL,
	`target_domain_id` text NOT NULL,
	`candidate_fingerprint` text NOT NULL,
	`sandbox_tenant_id` text NOT NULL,
	`sandbox_tenant_slug` text NOT NULL,
	`app_id` text NOT NULL,
	`status` text NOT NULL CHECK (`status` IN ('prepared','registering','active','cleanup_pending','cleanup_failed','cleanup_verified')),
	`remote_may_exist` integer DEFAULT false NOT NULL,
	`tool_snapshot_hash` text,
	`tool_snapshot_count` integer DEFAULT 0 NOT NULL,
	`lease_owner` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`cleanup_receipt` text,
	`cleanup_error` text,
	`cleanup_started_at` integer,
	`cleaned_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sandbox_tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_sandbox_attempts_app_uq` ON `factory_sandbox_attempts` (`app_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_sandbox_attempts_slug_uq` ON `factory_sandbox_attempts` (`sandbox_tenant_slug`);
--> statement-breakpoint
CREATE INDEX `factory_sandbox_attempts_status_lease_idx` ON `factory_sandbox_attempts` (`status`,`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `factory_sandbox_attempts_owner_domain_idx` ON `factory_sandbox_attempts` (`owner_tenant_id`,`target_domain_id`);
--> statement-breakpoint
CREATE TABLE `factory_sandbox_tool_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`sandbox_tenant_id` text NOT NULL,
	`sandbox_tool_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`source_tool_id` text NOT NULL,
	`source_scope_key` text NOT NULL,
	`source_definition_hash` text NOT NULL,
	`config_hash` text NOT NULL,
	`domain_hash` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `factory_sandbox_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sandbox_tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sandbox_tool_id`) REFERENCES `factory_tools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_sandbox_tool_snapshots_attempt_tool_uq` ON `factory_sandbox_tool_snapshots` (`attempt_id`,`tool_name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_sandbox_tool_snapshots_sandbox_tool_uq` ON `factory_sandbox_tool_snapshots` (`sandbox_tool_id`);
--> statement-breakpoint
CREATE INDEX `factory_sandbox_tool_snapshots_hash_idx` ON `factory_sandbox_tool_snapshots` (`snapshot_hash`);
