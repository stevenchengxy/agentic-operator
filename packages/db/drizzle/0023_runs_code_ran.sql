-- #REDESIGN P1 — execution receipt on runs: did the agent's GENERATED CODE actually run (1) vs
-- fall back to the declarative/prompt path (0)? NULL = declarative agent (no code to run). The
-- finish gate requires every codeExecuted agent to have a run with code_ran=1.
ALTER TABLE `runs` ADD `code_ran` integer;
