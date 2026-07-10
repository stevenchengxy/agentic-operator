-- #RECORDS — durable business entities (candidate / resume / job_posting /
-- candidate_match_result / communication_log). New-arch-native replacement for
-- the old AO's Neo4j / RAAS-Postgres instance write-back. run_id is a plain
-- column (NOT a FK) so records outlive run GC / soft-delete.
CREATE TABLE `business_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`record_type` text NOT NULL,
	`record_key` text NOT NULL,
	`subject` text,
	`candidate_id` text,
	`correlation_id` text,
	`run_id` text,
	`source_agent` text,
	`data_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_records_identity_uq` ON `business_records` (`tenant_id`,`record_type`,`record_key`);
--> statement-breakpoint
CREATE INDEX `business_records_type_idx` ON `business_records` (`tenant_id`,`record_type`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `business_records_candidate_idx` ON `business_records` (`tenant_id`,`candidate_id`);
--> statement-breakpoint
CREATE INDEX `business_records_correlation_idx` ON `business_records` (`correlation_id`);
