-- P6-AUTH — login + RBAC + multi-tenant access control.
--
-- Adds password + platform-role + lifecycle columns to `users` so the api can
-- own real email/password authentication (apps/api/src/routes/v1/auth.ts) and
-- a cross-tenant `superadmin` can be distinguished from ordinary users. Adds
-- provenance columns to `memberships` (when a role was granted, and by whom)
-- for the Access tab + audit trail.
--
-- SQLite restriction (same as 0003): ALTER TABLE ADD COLUMN with NOT NULL
-- requires a CONSTANT default, so the timestamp column is seeded `0` and then
-- backfilled. `platform_role`/`status` use constant string defaults directly.
-- `password_hash` is nullable — legacy seeded users have no credential until
-- one is set, and a null hash can never satisfy verifyPassword().

ALTER TABLE `users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `platform_role` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memberships` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memberships` ADD `created_by` text;--> statement-breakpoint
UPDATE `users` SET `updated_at` = `created_at` WHERE `updated_at` = 0;--> statement-breakpoint
UPDATE `memberships` SET `created_at` = (unixepoch() * 1000) WHERE `created_at` = 0;
