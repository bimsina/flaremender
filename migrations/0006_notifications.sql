CREATE TABLE `notification_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_id` text NOT NULL,
	`event` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text NOT NULL,
	`response_status` integer,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `notification_destination`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_delivery_destination_created_idx` ON `notification_delivery` (`destination_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_destination` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`target` text NOT NULL,
	`encrypted_secret` text,
	`events` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`dashboard_origin` text NOT NULL,
	`last_delivery_at` integer,
	`last_delivery_status` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_destination_projectId_idx` ON `notification_destination` (`project_id`);