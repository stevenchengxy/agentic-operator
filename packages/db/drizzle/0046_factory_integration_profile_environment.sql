ALTER TABLE `factory_integration_profiles` ADD `environment` text DEFAULT 'production' NOT NULL CHECK (`environment` IN ('sandbox','production'));
--> statement-breakpoint
-- v3 binds every human confirmation to one explicit environment. Existing
-- v1/v2 confirmations did not review that boundary and must remain audit-only.
UPDATE `factory_integration_profiles` SET `authorization_protocol_version` = 0;
--> statement-breakpoint
DROP INDEX IF EXISTS `factory_integration_profiles_scope_key_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_integration_profiles_scope_key_uq`
	ON `factory_integration_profiles` (`tenant_id`,`domain_key`,`tool_name`,`profile_key`,`environment`);
