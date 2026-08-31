CREATE TABLE IF NOT EXISTS `allowed_model` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`provider` text NOT NULL,
	`display_name` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `allowed_model_modelId_uidx` ON `allowed_model` (`model_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `allowed_model_provider_idx` ON `allowed_model` (`provider`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`outcome` text NOT NULL,
	`diagnosis` text,
	`script_version_id` text NOT NULL,
	`script_used` text NOT NULL,
	`heal_applied` text,
	`artifact_keys` text,
	`logs` text,
	`error_message` text,
	`duration_ms` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_version_id`) REFERENCES `script_version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `attempt_run_number_uidx` ON `attempt` (`run_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `attempt_runId_idx` ON `attempt` (`run_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`status` text DEFAULT 'complete' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_message_project_created_idx` ON `chat_message` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `environment` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `environment_project_name_uidx` ON `environment` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `environment_projectId_idx` ON `environment` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `environment_variable` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `environment_variable_env_name_uidx` ON `environment_variable` (`environment_id`,`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `environment_variable_environmentId_idx` ON `environment_variable` (`environment_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `generation_job` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'generate' NOT NULL,
	`intent_id` text,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`model_id` text,
	`script_version_id` text,
	`run_id` text,
	`turns` integer DEFAULT 0 NOT NULL,
	`stuck_reason` text,
	`created_by` text NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`intent_id`) REFERENCES `intent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `generation_job_intentId_idx` ON `generation_job` (`intent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `generation_job_projectId_idx` ON `generation_job` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `instance_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`default_model_id` text,
	`retention_runs_per_intent` integer,
	`setup_completed_at` integer,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `intent` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version_id` text,
	`schedule` text,
	`last_run_id` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `intent_projectId_idx` ON `intent` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `project` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`context` text,
	`model_id` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `project_org_slug_uidx` ON `project` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_organizationId_idx` ON `project` (`organization_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `provider_key` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `provider_key_provider_uidx` ON `provider_key` (`provider`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `run` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`project_id` text NOT NULL,
	`script_version_id` text NOT NULL,
	`suite_run_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`model_id` text,
	`workflow_instance_id` text,
	`artifact_prefix` text,
	`started_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`intent_id`) REFERENCES `intent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_version_id`) REFERENCES `script_version`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suite_run_id`) REFERENCES `suite_run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_intentId_idx` ON `run` (`intent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_projectId_idx` ON `run` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_environmentId_idx` ON `run` (`environment_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_suiteRunId_idx` ON `run` (`suite_run_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `script_version` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`version` integer NOT NULL,
	`code` text NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`created_by` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `intent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `script_version_intent_version_uidx` ON `script_version` (`intent_id`,`version`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `script_version_intentId_idx` ON `script_version` (`intent_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suite_run` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`passed_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`started_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suite_run_projectId_idx` ON `suite_run` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `account` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `account_issuer_accountId_uidx` ON `account` (`issuer`,`account_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invitation_organizationId_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `member_organizationId_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `member_userId_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_organization_id` text,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `verification_identifier_idx` ON `verification` (`identifier`);