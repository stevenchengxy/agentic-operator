-- Runtime-authored CodeAct receipts. NULL means no CodeAct execution result
-- exists (for example a declarative step); 0 is a real rejection/failure.
ALTER TABLE `runs` ADD `code_executed` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD `code_isolation` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `code_sha256` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `code_attestation_status` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `code_execution_failure` text;
--> statement-breakpoint
ALTER TABLE `steps` ADD `code_ran` integer;
--> statement-breakpoint
ALTER TABLE `steps` ADD `code_executed` integer;
--> statement-breakpoint
ALTER TABLE `steps` ADD `code_isolation` text;
--> statement-breakpoint
ALTER TABLE `steps` ADD `code_sha256` text;
--> statement-breakpoint
ALTER TABLE `steps` ADD `code_attestation_status` text;
--> statement-breakpoint
ALTER TABLE `steps` ADD `code_execution_failure` text;
