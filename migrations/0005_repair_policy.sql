CREATE TABLE `organization_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`heal_policy` text DEFAULT 'off' NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `generation_job` ADD `source_run_id` text;--> statement-breakpoint
ALTER TABLE `intent` ADD `heal_policy` text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE `intent` ADD `pending_repair_version_id` text;--> statement-breakpoint
ALTER TABLE `project` ADD `heal_policy` text DEFAULT 'inherit' NOT NULL;