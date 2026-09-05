DROP INDEX `provider_key_provider_uidx`;--> statement-breakpoint
ALTER TABLE `provider_key` ADD `organization_id` text REFERENCES organization(id);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_key_org_provider_uidx` ON `provider_key` (`organization_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_key_instance_provider_uidx` ON `provider_key` (`provider`) WHERE organization_id is null;--> statement-breakpoint
CREATE INDEX `provider_key_organizationId_idx` ON `provider_key` (`organization_id`);--> statement-breakpoint
ALTER TABLE `chat_message` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `chat_message` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_message` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_job` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_job` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `generation_job_organizationId_idx` ON `generation_job` (`organization_id`);