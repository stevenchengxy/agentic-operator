-- #SCALE-MEM — pre-computed embeddings (search stops re-embedding static values on every query) +
-- TTL eviction (long-running tenants no longer accumulate unbounded memory rows).
ALTER TABLE `agent_memory_long` ADD `embedding_json` text;--> statement-breakpoint
ALTER TABLE `agent_memory_long` ADD `expires_at` integer;
