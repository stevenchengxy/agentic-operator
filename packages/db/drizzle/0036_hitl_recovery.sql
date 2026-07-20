ALTER TABLE `tasks` ADD `origin_event_id` text REFERENCES events(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `origin_event_name` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `wait_step_id` text REFERENCES steps(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resume_marker` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resume_state` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resume_attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resolution_request_key` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resolution_requested_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resume_dispatched_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resume_acknowledged_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `resume_error` text;
--> statement-breakpoint
UPDATE `tasks`
SET `resume_state` = CASE
  WHEN `status` = 'resolved' THEN 'acknowledged'
  WHEN `status` = 'snoozed' THEN 'failed'
  ELSE 'pending'
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_resume_marker_uq` ON `tasks` (`resume_marker`);
--> statement-breakpoint
CREATE INDEX `tasks_resume_state_idx` ON `tasks` (`resume_state`);
--> statement-breakpoint
CREATE INDEX `tasks_wait_step_idx` ON `tasks` (`wait_step_id`);
