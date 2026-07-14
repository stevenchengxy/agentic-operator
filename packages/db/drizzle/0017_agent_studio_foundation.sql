-- Agent Studio shared persistence foundation.
--
-- Adds stable agent ownership/lifecycle, server-backed drafts and immutable
-- draft revisions, version metadata, Studio run sessions/messages, durable
-- structured traces, richer artifacts, and one-to-many emitted-event links.
-- Existing v1 write paths remain valid: new columns either accept NULL, have
-- compatibility defaults, or are populated by an AFTER INSERT trigger.

ALTER TABLE `agents` ADD `tenant_id` text REFERENCES `tenants`(`id`) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `agents` ADD `lifecycle` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
UPDATE `agents`
SET `tenant_id` = (
  SELECT `workflows`.`tenant_id`
  FROM `workflows`
  WHERE `workflows`.`id` = `agents`.`workflow_id`
)
WHERE `tenant_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agents_tenant_idx`
  ON `agents` (`tenant_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agents_tenant_lifecycle_idx`
  ON `agents` (`tenant_id`, `lifecycle`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agents_derive_tenant_after_insert`
AFTER INSERT ON `agents`
WHEN NEW.`tenant_id` IS NULL
BEGIN
  UPDATE `agents`
  SET `tenant_id` = (
    SELECT `workflows`.`tenant_id`
    FROM `workflows`
    WHERE `workflows`.`id` = NEW.`workflow_id`
  )
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agents_sync_tenant_after_workflow_update`
AFTER UPDATE OF `workflow_id` ON `agents`
BEGIN
  UPDATE `agents`
  SET `tenant_id` = (
    SELECT `workflows`.`tenant_id`
    FROM `workflows`
    WHERE `workflows`.`id` = NEW.`workflow_id`
  )
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agents_tenant_workflow_insert_guard`
BEFORE INSERT ON `agents`
WHEN NEW.`tenant_id` IS NOT NULL
  AND NEW.`tenant_id` <> (
    SELECT `workflows`.`tenant_id`
    FROM `workflows`
    WHERE `workflows`.`id` = NEW.`workflow_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'agent tenant_id must match workflow tenant_id');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agents_tenant_workflow_update_guard`
BEFORE UPDATE OF `tenant_id`, `workflow_id` ON `agents`
WHEN NEW.`tenant_id` IS NOT NULL
  AND NEW.`tenant_id` <> (
    SELECT `workflows`.`tenant_id`
    FROM `workflows`
    WHERE `workflows`.`id` = NEW.`workflow_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'agent tenant_id must match workflow tenant_id');
END;
--> statement-breakpoint

-- 0003 created the temporal columns, but schema.ts omitted them and the SQL
-- default remained 0. Repair existing rows and ensure legacy inserts that omit
-- the columns receive real timestamps.
UPDATE `agent_versions`
SET
  `created_at` = CASE
    WHEN `created_at` = 0 THEN unixepoch() * 1000
    ELSE `created_at`
  END,
  `updated_at` = CASE
    WHEN `updated_at` = 0 THEN unixepoch() * 1000
    ELSE `updated_at`
  END;
--> statement-breakpoint
ALTER TABLE `agent_versions` ADD `definition_schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_versions` ADD `content_hash` text;
--> statement-breakpoint
ALTER TABLE `agent_versions` ADD `created_by` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `agent_versions` ADD `published_at` integer;
--> statement-breakpoint
ALTER TABLE `agent_versions` ADD `change_note` text;
--> statement-breakpoint
UPDATE `agent_versions`
SET `published_at` = `created_at`
WHERE `published_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_versions_created_at_idx`
  ON `agent_versions` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_versions_content_hash_idx`
  ON `agent_versions` (`content_hash`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agent_versions_temporal_after_insert`
AFTER INSERT ON `agent_versions`
WHEN NEW.`created_at` = 0 OR NEW.`updated_at` = 0
BEGIN
  UPDATE `agent_versions`
  SET
    `created_at` = CASE
      WHEN NEW.`created_at` = 0 THEN unixepoch() * 1000
      ELSE NEW.`created_at`
    END,
    `updated_at` = CASE
      WHEN NEW.`updated_at` = 0 THEN unixepoch() * 1000
      ELSE NEW.`updated_at`
    END,
    `published_at` = COALESCE(NEW.`published_at`, unixepoch() * 1000)
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_drafts` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `base_agent_version_id` text,
  `base_workflow_version_id` text,
  `definition_json` text NOT NULL,
  `schema_version` integer DEFAULT 2 NOT NULL,
  `content_hash` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `validation_status` text DEFAULT 'unvalidated' NOT NULL,
  `validation_json` text,
  `validated_hash` text,
  `created_by` text,
  `updated_by` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`base_agent_version_id`) REFERENCES `agent_versions`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`base_workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`),
  FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_drafts_tenant_updated_idx`
  ON `agent_drafts` (`tenant_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_drafts_agent_updated_idx`
  ON `agent_drafts` (`agent_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_drafts_workflow_idx`
  ON `agent_drafts` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_drafts_deleted_at_idx`
  ON `agent_drafts` (`deleted_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_draft_revisions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `draft_id` text NOT NULL,
  `revision` integer NOT NULL,
  `definition_json` text NOT NULL,
  `schema_version` integer DEFAULT 2 NOT NULL,
  `content_hash` text NOT NULL,
  `reason` text NOT NULL,
  `created_by` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`draft_id`) REFERENCES `agent_drafts`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_draft_revisions_draft_revision_uq`
  ON `agent_draft_revisions` (`draft_id`, `revision`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_draft_revisions_tenant_created_idx`
  ON `agent_draft_revisions` (`tenant_id`, `created_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_run_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `created_by` text,
  `title` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `last_run_at` integer,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_run_sessions_tenant_updated_idx`
  ON `agent_run_sessions` (`tenant_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_run_sessions_agent_updated_idx`
  ON `agent_run_sessions` (`agent_id`, `updated_at`);
--> statement-breakpoint

ALTER TABLE `runs` ADD `draft_revision_id` text REFERENCES `agent_draft_revisions`(`id`);
--> statement-breakpoint
ALTER TABLE `runs` ADD `session_id` text REFERENCES `agent_run_sessions`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `queued_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `runs`
SET `queued_at` = COALESCE(`started_at`, unixepoch() * 1000)
WHERE `queued_at` = 0;
--> statement-breakpoint
ALTER TABLE `runs` ADD `invocation_source` text DEFAULT 'event' NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `requested_by` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `runs` ADD `definition_hash` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `output_valid` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD `side_effect_mode` text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_session_idx`
  ON `runs` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_tenant_queued_idx`
  ON `runs` (`tenant_id`, `queued_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_draft_revision_idx`
  ON `runs` (`draft_revision_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_agent_source_started_idx`
  ON `runs` (`agent_id`, `invocation_source`, `started_at`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `runs_definition_target_insert_guard`
BEFORE INSERT ON `runs`
WHEN NEW.`agent_version_id` IS NOT NULL AND NEW.`draft_revision_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'run cannot target both an agent version and a draft revision');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `runs_queued_at_after_insert`
AFTER INSERT ON `runs`
WHEN NEW.`queued_at` = 0
BEGIN
  UPDATE `runs`
  SET `queued_at` = unixepoch() * 1000
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `runs_definition_target_update_guard`
BEFORE UPDATE OF `agent_version_id`, `draft_revision_id` ON `runs`
WHEN NEW.`agent_version_id` IS NOT NULL AND NEW.`draft_revision_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'run cannot target both an agent version and a draft revision');
END;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `run_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `session_id` text NOT NULL,
  `run_id` text,
  `ord` integer NOT NULL,
  `role` text NOT NULL,
  `content_json` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`session_id`) REFERENCES `agent_run_sessions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `run_messages_session_ord_uq`
  ON `run_messages` (`session_id`, `ord`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_messages_tenant_created_idx`
  ON `run_messages` (`tenant_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_messages_run_idx`
  ON `run_messages` (`run_id`);
--> statement-breakpoint

ALTER TABLE `artifacts` ADD `step_id` text REFERENCES `steps`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `role` text DEFAULT 'other' NOT NULL;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `logical_name` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `content_type` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `sha256` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `schema_id` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `metadata_json` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `redacted` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `retention_until` integer;
--> statement-breakpoint
WITH RECURSIVE `artifact_path_parts`(`id`, `rest`) AS (
  SELECT `id`, replace(`path`, '\', '/')
  FROM `artifacts`
  UNION ALL
  SELECT `id`, substr(`rest`, instr(`rest`, '/') + 1)
  FROM `artifact_path_parts`
  WHERE instr(`rest`, '/') > 0
),
`artifact_leaf_names`(`id`, `leaf`) AS (
  SELECT `id`, `rest`
  FROM `artifact_path_parts`
  WHERE instr(`rest`, '/') = 0 AND length(`rest`) > 0
)
UPDATE `artifacts`
SET `logical_name` = COALESCE(
  (
    SELECT `leaf`
    FROM `artifact_leaf_names`
    WHERE `artifact_leaf_names`.`id` = `artifacts`.`id`
    LIMIT 1
  ),
  `artifacts`.`id`
)
WHERE `logical_name` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `art_run_role_idx`
  ON `artifacts` (`run_id`, `role`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `art_step_idx`
  ON `artifacts` (`step_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `art_sha256_idx`
  ON `artifacts` (`sha256`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `art_retention_until_idx`
  ON `artifacts` (`retention_until`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `run_trace_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `run_id` text NOT NULL,
  `step_id` text,
  `parent_id` text,
  `seq` integer NOT NULL,
  `kind` text NOT NULL,
  `level` text DEFAULT 'standard' NOT NULL,
  `name` text NOT NULL,
  `status` text NOT NULL,
  `started_at` integer,
  `ended_at` integer,
  `duration_ms` integer,
  `summary` text,
  `data_json` text,
  `artifact_id` text,
  `visibility` text DEFAULT 'user' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `run_trace_events_run_seq_uq`
  ON `run_trace_events` (`run_id`, `seq`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_trace_events_tenant_created_idx`
  ON `run_trace_events` (`tenant_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_trace_events_step_idx`
  ON `run_trace_events` (`step_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_trace_events_parent_idx`
  ON `run_trace_events` (`parent_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `run_emitted_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `run_id` text NOT NULL,
  `event_id` text NOT NULL,
  `output_port_id` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `run_emitted_events_run_event_port_uq`
  ON `run_emitted_events` (`run_id`, `event_id`, `output_port_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_emitted_events_tenant_created_idx`
  ON `run_emitted_events` (`tenant_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_emitted_events_event_idx`
  ON `run_emitted_events` (`event_id`);
