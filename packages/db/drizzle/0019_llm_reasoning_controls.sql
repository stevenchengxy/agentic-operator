ALTER TABLE `llm_calls` ADD `reasoning_mode` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `reasoning_effort` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `reasoning_summary` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `reasoning_context` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `text_verbosity` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `store_response` integer;
