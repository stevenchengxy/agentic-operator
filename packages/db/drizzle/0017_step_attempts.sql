-- Step execution attempt counter.
--
-- Inngest retries a failed `step.run` body in place (retries=3). The manifest
-- runtime previously inserted a fresh `steps` row per body execution, so a
-- retried step produced duplicate rows at the same `ord`. The runtime now
-- upserts by (run_id, ord) and bumps `attempts`, so the run viewer can show
-- "attempt 2 of 3" instead of phantom duplicates. Code-agent steps run
-- synchronously and stay at the default of 1.

ALTER TABLE `steps` ADD COLUMN `attempts` integer DEFAULT 1 NOT NULL;
