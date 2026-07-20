-- Durable, per-agent production CodeAct authorization. A manifest flag is
-- only an execution request; the runtime requires one of these rows plus the
-- immutable regression artifact and human-review receipt before execution.
CREATE TABLE `factory_codeact_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`promotion_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`tenant_slug` text NOT NULL,
	`domain_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`promotion_version_id` text NOT NULL,
	`regression_suite_fingerprint` text NOT NULL,
	`code_sha256` text NOT NULL,
	`deployment_id` text NOT NULL,
	`workflow_version_id` text NOT NULL,
	`review_receipt_id` text NOT NULL,
	`review_selection_hash` text NOT NULL,
	`regression_artifact` text NOT NULL,
	`promotion_record_hash` text NOT NULL,
	`status` text DEFAULT 'committed' NOT NULL CHECK (`status` = 'committed'),
	`committed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_codeact_authorizations_promotion_agent_uq` ON `factory_codeact_authorizations` (`promotion_id`,`agent_slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_codeact_authorizations_identity_uq` ON `factory_codeact_authorizations` (`tenant_id`,`domain_id`,`agent_slug`,`promotion_version_id`,`regression_suite_fingerprint`,`code_sha256`);
--> statement-breakpoint
CREATE INDEX `factory_codeact_authorizations_tenant_agent_idx` ON `factory_codeact_authorizations` (`tenant_id`,`agent_slug`);
--> statement-breakpoint
CREATE INDEX `factory_codeact_authorizations_deployment_idx` ON `factory_codeact_authorizations` (`deployment_id`);
