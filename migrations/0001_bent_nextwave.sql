ALTER TABLE `attempt` ADD `result` text;--> statement-breakpoint
ALTER TABLE `attempt` ADD `artifact_warnings` text;--> statement-breakpoint
ALTER TABLE `intent` ADD `readiness` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `run` ADD `purpose` text DEFAULT 'regression' NOT NULL;--> statement-breakpoint
ALTER TABLE `run` ADD `environment_name` text;--> statement-breakpoint
ALTER TABLE `run` ADD `base_url` text;--> statement-breakpoint
ALTER TABLE `run` ADD `error_message` text;
--> statement-breakpoint
-- Historical verification is identified from recorded generation metadata, never today's status.
UPDATE run SET purpose = 'generation-verification'
WHERE trigger = 'regenerate' OR id IN (SELECT run_id FROM generation_job WHERE run_id IS NOT NULL);
--> statement-breakpoint
UPDATE intent SET readiness = 'ready' WHERE current_version_id IS NOT NULL
AND status IN ('ready', 'passing', 'failing')
AND NOT EXISTS (SELECT 1 FROM generation_job g WHERE g.script_version_id = intent.current_version_id AND g.stuck_reason IS NOT NULL);
--> statement-breakpoint
UPDATE intent SET last_run_id = NULL WHERE NOT EXISTS
(SELECT 1 FROM run r WHERE r.id = intent.last_run_id AND r.script_version_id = intent.current_version_id AND r.purpose = 'regression');
--> statement-breakpoint
UPDATE intent SET status = CASE WHEN readiness = 'ready' THEN 'ready' ELSE 'draft' END
WHERE status IN ('passing', 'failing') AND last_run_id IS NULL;
