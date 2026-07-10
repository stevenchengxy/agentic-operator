-- #P0-3 — raw LLM telemetry. One row per LLM call from the factory brain + its review/design tools,
-- so per-call model / routing (requested vs served + fallback) / latency / size / cost are auditable
-- (they were ephemeral in-memory streaming only). Closes the biggest observability gap in the audit.
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`domain` text,
	`conversation_id` text,
	`purpose` text,
	`requested_model` text,
	`served_model` text,
	`provider` text,
	`fallback` integer,
	`prompt_chars` integer,
	`completion_chars` integer,
	`approx_tokens_in` integer,
	`approx_tokens_out` integer,
	`latency_ms` integer,
	`ok` integer,
	`failure_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `llm_calls_domain_idx` ON `llm_calls` (`domain`);--> statement-breakpoint
CREATE INDEX `llm_calls_conversation_idx` ON `llm_calls` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `llm_calls_served_model_idx` ON `llm_calls` (`served_model`);
