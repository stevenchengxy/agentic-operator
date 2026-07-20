ALTER TABLE `factory_sandbox_attempts` ADD `run_drain_status` text DEFAULT 'not_started' NOT NULL CHECK (`run_drain_status` IN ('not_started','cancelling','verified','failed'));
--> statement-breakpoint
ALTER TABLE `factory_sandbox_attempts` ADD `run_drain_receipt` text;
--> statement-breakpoint
ALTER TABLE `factory_sandbox_attempts` ADD `run_drain_error` text;
--> statement-breakpoint
ALTER TABLE `factory_sandbox_attempts` ADD `run_drain_started_at` integer;
--> statement-breakpoint
ALTER TABLE `factory_sandbox_attempts` ADD `run_drain_completed_at` integer;
--> statement-breakpoint
CREATE TRIGGER `factory_sandbox_runs_lifecycle_guard`
BEFORE INSERT ON `runs`
WHEN EXISTS (
	SELECT 1 FROM `factory_sandbox_attempts`
	WHERE `sandbox_tenant_id` = NEW.`tenant_id`
	  AND `status` <> 'active'
)
BEGIN
	SELECT RAISE(ABORT, 'factory sandbox dispatch blocked by lifecycle ledger');
END;
