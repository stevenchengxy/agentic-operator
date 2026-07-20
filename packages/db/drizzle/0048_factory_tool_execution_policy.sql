-- Historical rows intentionally remain NULL. They are quarantined by every
-- query/runtime boundary until an operator explicitly reviews and re-saves
-- operation/effect_scope/sandbox_policy; no side_effect or HTTP-method
-- inference is used as a migration default.
ALTER TABLE `factory_tools` ADD `operation` text CHECK (`operation` IS NULL OR `operation` IN ('read','compute','write','read_write'));
--> statement-breakpoint
ALTER TABLE `factory_tools` ADD `effect_scope` text CHECK (`effect_scope` IS NULL OR `effect_scope` IN ('none','sandbox_local','external'));
--> statement-breakpoint
ALTER TABLE `factory_tools` ADD `sandbox_policy` text CHECK (`sandbox_policy` IS NULL OR `sandbox_policy` IN ('pure','sandbox_local','live_external','requires_attempt_grant'));
