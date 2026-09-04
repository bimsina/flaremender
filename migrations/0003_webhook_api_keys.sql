CREATE TABLE `api_execution_request` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`execution_kind` text NOT NULL,
	`execution_id` text NOT NULL,
	`dispatch_state` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_execution_request_key_idempotency_uidx` ON `api_execution_request` (`api_key_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `api_execution_request_expiresAt_idx` ON `api_execution_request` (`expires_at`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`prefix` text,
	`key` text NOT NULL,
	`reference_id` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer,
	`rate_limit_max` integer,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_key_uidx` ON `apikey` (`key`);--> statement-breakpoint
ALTER TABLE `run` ADD `webhook_api_key_id` text;--> statement-breakpoint
ALTER TABLE `run` ADD `webhook_api_key_name` text;--> statement-breakpoint
ALTER TABLE `suite_run` ADD `webhook_api_key_id` text;--> statement-breakpoint
ALTER TABLE `suite_run` ADD `webhook_api_key_name` text;