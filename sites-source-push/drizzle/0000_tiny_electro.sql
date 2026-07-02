CREATE TABLE `booking_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`exact_connection_id` text,
	`status` text NOT NULL,
	`request_payload` text,
	`response_payload` text,
	`error_message` text,
	`exact_booking_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exact_connection_id`) REFERENCES `exact_online_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_attempts_invoice_idx` ON `booking_attempts` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `exact_online_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`division_code` text,
	`access_token_ciphertext` text NOT NULL,
	`refresh_token_ciphertext` text NOT NULL,
	`expires_at` integer NOT NULL,
	`scopes` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exact_online_connections_user_idx` ON `exact_online_connections` (`user_id`);--> statement-breakpoint
CREATE TABLE `extracted_invoice_data` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`supplier_name` text,
	`supplier_vat_number` text,
	`invoice_number` text,
	`invoice_date` text,
	`due_date` text,
	`currency` text,
	`net_amount` real,
	`vat_amount` real,
	`gross_amount` real,
	`iban` text,
	`raw_text` text,
	`confidence` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extracted_invoice_data_invoice_idx` ON `extracted_invoice_data` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `extracted_invoice_data_duplicate_idx` ON `extracted_invoice_data` (`supplier_name`,`invoice_number`);--> statement-breakpoint
CREATE TABLE `invoice_line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`extracted_data_id` text NOT NULL,
	`description` text NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real NOT NULL,
	`net_amount` real NOT NULL,
	`vat_rate` real NOT NULL,
	`vat_amount` real NOT NULL,
	`gross_amount` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extracted_data_id`) REFERENCES `extracted_invoice_data`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_line_items_data_idx` ON `invoice_line_items` (`extracted_data_id`);--> statement-breakpoint
CREATE TABLE `outlook_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_address` text NOT NULL,
	`access_token_ciphertext` text NOT NULL,
	`refresh_token_ciphertext` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outlook_connections_user_idx` ON `outlook_connections` (`user_id`);--> statement-breakpoint
CREATE TABLE `outlook_email_ingestions` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`message_id` text NOT NULL,
	`subject` text NOT NULL,
	`sender` text NOT NULL,
	`category` text NOT NULL,
	`detected_attachment_count` integer NOT NULL,
	`processed_invoice_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `outlook_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`processed_invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outlook_email_ingestions_message_idx` ON `outlook_email_ingestions` (`message_id`);--> statement-breakpoint
CREATE INDEX `outlook_email_ingestions_connection_idx` ON `outlook_email_ingestions` (`connection_id`);--> statement-breakpoint
CREATE TABLE `uploaded_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`file_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`storage_key` text NOT NULL,
	`outlook_message_id` text,
	`status` text NOT NULL,
	`last_error` text,
	`exact_booking_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `uploaded_invoices_user_status_idx` ON `uploaded_invoices` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `uploaded_invoices_source_idx` ON `uploaded_invoices` (`source`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `validation_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`field` text NOT NULL,
	`message` text NOT NULL,
	`severity` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `validation_errors_invoice_idx` ON `validation_errors` (`invoice_id`);