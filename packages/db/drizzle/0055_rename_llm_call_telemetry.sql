-- D3 reconciliation (Kenny-merge 2026-07-20): the name `llm_calls` now belongs to
-- the per-attempt usage/billing ledger (created next in 0058_llm_usage_ledger).
-- Our factory brain/stream telemetry table (migration 0024, run/domain/conversation
-- keyed) moves aside to `llm_call_telemetry` with its indexes renamed so the
-- ledger's `llm_calls_*` index names stay free. Data is preserved verbatim.
ALTER TABLE `llm_calls` RENAME TO `llm_call_telemetry`;--> statement-breakpoint
DROP INDEX IF EXISTS `llm_calls_run_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `llm_calls_domain_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `llm_calls_conversation_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `llm_calls_served_model_idx`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_call_telemetry_run_idx` ON `llm_call_telemetry` (`run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_call_telemetry_domain_idx` ON `llm_call_telemetry` (`domain`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_call_telemetry_conversation_idx` ON `llm_call_telemetry` (`conversation_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_call_telemetry_served_model_idx` ON `llm_call_telemetry` (`served_model`);
