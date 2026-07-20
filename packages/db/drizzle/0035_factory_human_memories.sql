CREATE TABLE `factory_human_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain` text NOT NULL,
	`question_key` text NOT NULL,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`context` text,
	`source` text DEFAULT 'human' NOT NULL,
	`conversation_id` text,
	`confirmed` integer DEFAULT true NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_human_memories_tenant_domain_question_uq` ON `factory_human_memories` (`tenant_id`,`domain`,`question_key`);
--> statement-breakpoint
CREATE INDEX `factory_human_memories_tenant_domain_idx` ON `factory_human_memories` (`tenant_id`,`domain`);
--> statement-breakpoint
CREATE INDEX `factory_human_memories_conversation_idx` ON `factory_human_memories` (`conversation_id`);
