-- reasoningAgent and reportGenerator are platform runtime utilities, not
-- tenant-domain catalog agents. Earlier direct invocations materialized a
-- __code_agents__ copy inside the caller tenant. Re-home every historical
-- version beneath the canonical __system/__system agent while preserving the
-- original version manifests and timestamps. Runs and deployments are mapped
-- one-for-one to those historical canonical versions; no unrelated tenant
-- workflow or deployment history is pruned.

-- Abort instead of silently skipping repair when a stale copy has no single,
-- unambiguous canonical agent. Migrations run before application bootstrap, so
-- relying on later startup code to create the canonical row would strand the
-- stale catalog entry permanently.
CREATE TEMP TABLE `_system_agent_scope_guard` (
	`ok` integer NOT NULL CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `_system_agent_scope_guard` (`ok`)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM `agents` stale_agent
	INNER JOIN `workflows` stale_workflow
		ON stale_workflow.`id` = stale_agent.`workflow_id`
	INNER JOIN `tenants` stale_tenant
		ON stale_tenant.`id` = stale_workflow.`tenant_id`
	WHERE stale_tenant.`slug` <> '__system'
		AND stale_workflow.`slug` = '__code_agents__'
		AND stale_agent.`kind` = 'code'
		AND stale_agent.`name` IN ('reasoningAgent', 'reportGenerator')
		AND (
			SELECT COUNT(*)
			FROM `agents` canonical_agent
			INNER JOIN `workflows` canonical_workflow
				ON canonical_workflow.`id` = canonical_agent.`workflow_id`
			INNER JOIN `tenants` canonical_tenant
				ON canonical_tenant.`id` = canonical_workflow.`tenant_id`
			WHERE canonical_tenant.`slug` = '__system'
				AND canonical_workflow.`slug` = '__system'
				AND canonical_agent.`kind` = 'code'
				AND canonical_agent.`kebab_id` = stale_agent.`kebab_id`
				AND canonical_agent.`name` = stale_agent.`name`
		) <> 1
) THEN 0 ELSE 1 END;
--> statement-breakpoint

CREATE TEMP TABLE `_system_agent_scope_agent_repair` (
	`stale_agent_id` text PRIMARY KEY NOT NULL,
	`stale_workflow_id` text NOT NULL,
	`canonical_agent_id` text NOT NULL,
	`canonical_workflow_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `_system_agent_scope_agent_repair` (
	`stale_agent_id`,
	`stale_workflow_id`,
	`canonical_agent_id`,
	`canonical_workflow_id`
)
SELECT
	stale_agent.`id`,
	stale_workflow.`id`,
	canonical_agent.`id`,
	canonical_workflow.`id`
FROM `agents` stale_agent
INNER JOIN `workflows` stale_workflow
	ON stale_workflow.`id` = stale_agent.`workflow_id`
INNER JOIN `tenants` stale_tenant
	ON stale_tenant.`id` = stale_workflow.`tenant_id`
INNER JOIN `agents` canonical_agent
	ON canonical_agent.`kebab_id` = stale_agent.`kebab_id`
	AND canonical_agent.`name` = stale_agent.`name`
	AND canonical_agent.`kind` = 'code'
INNER JOIN `workflows` canonical_workflow
	ON canonical_workflow.`id` = canonical_agent.`workflow_id`
	AND canonical_workflow.`slug` = '__system'
INNER JOIN `tenants` canonical_tenant
	ON canonical_tenant.`id` = canonical_workflow.`tenant_id`
	AND canonical_tenant.`slug` = '__system'
WHERE stale_tenant.`slug` <> '__system'
	AND stale_workflow.`slug` = '__code_agents__'
	AND stale_agent.`kind` = 'code'
	AND stale_agent.`name` IN ('reasoningAgent', 'reportGenerator');
--> statement-breakpoint

-- One deterministic canonical workflow/agent version per historical tenant
-- agent_version. The old id remains in the mapping until every reference has
-- moved; the new rows copy both manifest layers and all available timestamps.
CREATE TEMP TABLE `_system_agent_scope_version_repair` (
	`stale_agent_version_id` text PRIMARY KEY NOT NULL,
	`stale_workflow_version_id` text NOT NULL,
	`canonical_agent_version_id` text UNIQUE NOT NULL,
	`canonical_workflow_version_id` text UNIQUE NOT NULL,
	`canonical_agent_id` text NOT NULL,
	`canonical_workflow_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `_system_agent_scope_version_repair` (
	`stale_agent_version_id`,
	`stale_workflow_version_id`,
	`canonical_agent_version_id`,
	`canonical_workflow_version_id`,
	`canonical_agent_id`,
	`canonical_workflow_id`
)
SELECT
	stale_version.`id`,
	stale_version.`workflow_version_id`,
	'agv-scope-history-' || stale_version.`id`,
	'wfv-scope-history-' || stale_version.`id`,
	repair.`canonical_agent_id`,
	repair.`canonical_workflow_id`
FROM `agent_versions` stale_version
INNER JOIN `_system_agent_scope_agent_repair` repair
	ON repair.`stale_agent_id` = stale_version.`agent_id`;
--> statement-breakpoint

INSERT INTO `workflow_versions` (
	`id`,
	`workflow_id`,
	`version`,
	`manifest_json`,
	`actions_json`,
	`created_at`,
	`created_by`
)
SELECT
	repair.`canonical_workflow_version_id`,
	repair.`canonical_workflow_id`,
	'historical-scope-repair-' || repair.`stale_agent_version_id`,
	stale_workflow_version.`manifest_json`,
	stale_workflow_version.`actions_json`,
	stale_workflow_version.`created_at`,
	stale_workflow_version.`created_by`
FROM `_system_agent_scope_version_repair` repair
INNER JOIN `workflow_versions` stale_workflow_version
	ON stale_workflow_version.`id` = repair.`stale_workflow_version_id`;
--> statement-breakpoint

INSERT INTO `agent_versions` (
	`id`,
	`agent_id`,
	`workflow_version_id`,
	`manifest_json`,
	`created_at`,
	`updated_at`
)
SELECT
	repair.`canonical_agent_version_id`,
	repair.`canonical_agent_id`,
	repair.`canonical_workflow_version_id`,
	stale_version.`manifest_json`,
	stale_version.`created_at`,
	stale_version.`updated_at`
FROM `_system_agent_scope_version_repair` repair
INNER JOIN `agent_versions` stale_version
	ON stale_version.`id` = repair.`stale_agent_version_id`;
--> statement-breakpoint

-- Preserve every deployment audit row. It continues to belong to the tenant
-- that originally deployed the copy, but now references the canonical
-- historical version and is terminal rather than advertising a live utility.
UPDATE `deployments`
SET `version_id` = (
		SELECT repair.`canonical_agent_version_id`
		FROM `_system_agent_scope_version_repair` repair
		WHERE repair.`stale_agent_version_id` = `deployments`.`version_id`
	),
	`status` = 'rolled_back'
WHERE `version_id` IN (
	SELECT `stale_agent_version_id`
	FROM `_system_agent_scope_version_repair`
);
--> statement-breakpoint

-- Map each run to the canonical copy of the exact version it executed. A
-- legacy run with no version evidence remains NULL rather than being falsely
-- attributed to the newest system version.
UPDATE `runs`
SET `agent_version_id` = (
	SELECT repair.`canonical_agent_version_id`
	FROM `_system_agent_scope_version_repair` repair
	WHERE repair.`stale_agent_version_id` = `runs`.`agent_version_id`
)
WHERE `agent_id` IN (
	SELECT `stale_agent_id`
	FROM `_system_agent_scope_agent_repair`
);
--> statement-breakpoint
UPDATE `runs`
SET `agent_id` = (
	SELECT repair.`canonical_agent_id`
	FROM `_system_agent_scope_agent_repair` repair
	WHERE repair.`stale_agent_id` = `runs`.`agent_id`
)
WHERE `agent_id` IN (
	SELECT `stale_agent_id`
	FROM `_system_agent_scope_agent_repair`
);
--> statement-breakpoint

UPDATE `events`
SET `source_agent_id` = (
	SELECT repair.`canonical_agent_id`
	FROM `_system_agent_scope_agent_repair` repair
	WHERE repair.`stale_agent_id` = `events`.`source_agent_id`
)
WHERE `source_agent_id` IN (
	SELECT `stale_agent_id`
	FROM `_system_agent_scope_agent_repair`
);
--> statement-breakpoint

-- Deleting only mapped stale agents cascades their obsolete agent_versions and
-- event listeners. Historical copies now live under the canonical agent.
DELETE FROM `agents`
WHERE `id` IN (
	SELECT `stale_agent_id`
	FROM `_system_agent_scope_agent_repair`
);
--> statement-breakpoint

-- Cleanup is deliberately limited to workflow versions that actually backed a
-- mapped stale agent version. Keep any version still referenced by another
-- agent or a workflow-level deployment audit record.
DELETE FROM `workflow_versions`
WHERE `id` IN (
		SELECT DISTINCT `stale_workflow_version_id`
		FROM `_system_agent_scope_version_repair`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `agent_versions` remaining_version
		WHERE remaining_version.`workflow_version_id` = `workflow_versions`.`id`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `deployments` historical_deployment
		WHERE historical_deployment.`version_id` = `workflow_versions`.`id`
	);
--> statement-breakpoint

DELETE FROM `workflows`
WHERE `id` IN (
		SELECT DISTINCT `stale_workflow_id`
		FROM `_system_agent_scope_agent_repair`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `agents` remaining_agent
		WHERE remaining_agent.`workflow_id` = `workflows`.`id`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `workflow_versions` remaining_workflow_version
		WHERE remaining_workflow_version.`workflow_id` = `workflows`.`id`
	);
--> statement-breakpoint

DROP TABLE `_system_agent_scope_version_repair`;
--> statement-breakpoint
DROP TABLE `_system_agent_scope_agent_repair`;
--> statement-breakpoint
DROP TABLE `_system_agent_scope_guard`;
