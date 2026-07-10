-- #W0 — raw per-turn LLM capture for DEPLOYED manifest-agent runs. One row per
-- tool-use-loop turn: the model's response text + extracted reasoning + which
-- tools it requested, tied to run_id + step_id. Powers the run-detail reasoning
-- surface + the 推理审计 (reasoning/audit) page. run_id FK cascades so a run
-- delete/purge cleans these up; step_id is a plain column (the step row is
-- written immediately before). Capture is gated by AGENTIC_CAPTURE_LLM_TURNS
-- (default on) with per-field size caps applied in the runtime.
CREATE TABLE `llm_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text,
	`ord` integer NOT NULL,
	`prompt_preview` text,
	`response_text` text,
	`reasoning` text,
	`tool_calls_json` text,
	`provider` text,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`finish_reason` text,
	`latency_ms` integer,
	`correlation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `llm_turns_run_idx` ON `llm_turns` (`run_id`,`ord`);--> statement-breakpoint
CREATE INDEX `llm_turns_tenant_created_idx` ON `llm_turns` (`tenant_id`,`created_at`);
