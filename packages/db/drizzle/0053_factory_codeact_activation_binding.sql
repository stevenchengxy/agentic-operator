-- Separate immutable evidence provenance from each live-deployment activation.
-- Existing rows intentionally receive empty manifest hashes and therefore fail
-- closed until the agent is re-promoted under the full-manifest contract.
ALTER TABLE `factory_codeact_authorizations` ADD `agent_manifest_sha256` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_codeact_authorizations` ADD `workflow_manifest_sha256` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_codeact_authorizations` ADD `activation_promotion_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_codeact_authorizations` ADD `activation_domain_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_codeact_authorizations` ADD `activation_version_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_codeact_authorizations` ADD `activation_review_receipt_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_codeact_authorizations` ADD `activation_review_selection_hash` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_codeact_authorizations` ADD `activation_promotion_record_hash` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `factory_codeact_authorizations`
SET `activation_promotion_id` = `promotion_id`,
    `activation_domain_id` = `domain_id`,
    `activation_version_id` = `promotion_version_id`,
    `activation_review_receipt_id` = `review_receipt_id`,
    `activation_review_selection_hash` = `review_selection_hash`,
    `activation_promotion_record_hash` = `promotion_record_hash`;
--> statement-breakpoint
DROP INDEX `factory_codeact_authorizations_promotion_agent_uq`;
--> statement-breakpoint
DROP INDEX `factory_codeact_authorizations_identity_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_codeact_authorizations_deployment_agent_uq`
ON `factory_codeact_authorizations` (`deployment_id`,`agent_slug`);
