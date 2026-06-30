CREATE TABLE `duplicate_decision_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text,
	`duplicate_invoice_id` text,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`checksum` text,
	`detection_outcome` text NOT NULL,
	`decision` text NOT NULL,
	`message` text NOT NULL,
	`exact_booking_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `duplicate_decision_logs_invoice_idx` ON `duplicate_decision_logs` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `duplicate_decision_logs_duplicate_idx` ON `duplicate_decision_logs` (`duplicate_invoice_id`);--> statement-breakpoint
CREATE INDEX `duplicate_decision_logs_checksum_idx` ON `duplicate_decision_logs` (`checksum`);--> statement-breakpoint
CREATE TABLE `extraction_version_histories` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`version` integer NOT NULL,
	`reason` text NOT NULL,
	`decision` text,
	`extracted_data_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `uploaded_invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `extraction_version_histories_invoice_idx` ON `extraction_version_histories` (`invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_version_histories_invoice_version_idx` ON `extraction_version_histories` (`invoice_id`,`version`);--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `exact_booking_status` text;--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `duplicate_detection_json` text;--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `duplicate_resolution_decision` text;