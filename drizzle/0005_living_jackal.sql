CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text,
	`user_id` text NOT NULL,
	`user_name` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`field` text,
	`old_value_json` text,
	`new_value_json` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_events_invoice_idx` ON `audit_events` (`invoice_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_user_idx` ON `audit_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_type_idx` ON `audit_events` (`type`);--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `uploaded_by_user_id` text NOT NULL REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `uploaded_by_name` text NOT NULL;--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `deleted_by_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `uploaded_invoices_uploader_idx` ON `uploaded_invoices` (`uploaded_by_user_id`);--> statement-breakpoint
CREATE INDEX `uploaded_invoices_archive_status_idx` ON `uploaded_invoices` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'Viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;