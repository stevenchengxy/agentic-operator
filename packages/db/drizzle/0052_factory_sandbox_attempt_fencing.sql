ALTER TABLE `factory_sandbox_attempts` ADD `lease_token` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factory_sandbox_attempts` ADD `fence_generation` integer NOT NULL DEFAULT 1 CHECK (`fence_generation` >= 1);
--> statement-breakpoint
UPDATE `factory_sandbox_attempts`
SET `lease_token` = lower(hex(randomblob(32)))
WHERE `lease_token` = '';
--> statement-breakpoint
CREATE INDEX `factory_sandbox_attempts_owner_fence_idx`
ON `factory_sandbox_attempts` (`id`,`lease_owner`,`lease_token`,`fence_generation`);
