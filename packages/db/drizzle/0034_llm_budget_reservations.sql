-- Atomic pre-call reservations for concurrent token/USD budget enforcement.
-- Actual settled totals stay in tenant_budgets; active rows are included in
-- every capacity check and expire after the provider-call lease.
CREATE TABLE `llm_budget_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reserved_tokens` integer NOT NULL,
	`reserved_usd_cents` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`actual_tokens` integer,
	`actual_usd_cents` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`settled_at` integer,
	`outcome` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `llm_budget_reservations_tenant_status_idx` ON `llm_budget_reservations` (`tenant_id`,`status`);
--> statement-breakpoint
CREATE INDEX `llm_budget_reservations_expires_idx` ON `llm_budget_reservations` (`expires_at`);
