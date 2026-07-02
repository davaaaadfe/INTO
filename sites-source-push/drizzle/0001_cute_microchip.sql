CREATE TABLE `account_mapping_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`supplier_account_id` text NOT NULL,
	`description_key` text NOT NULL,
	`gl_account` text NOT NULL,
	`vat_code` text,
	`cost_centre` text,
	`cost_unit` text,
	`accrual_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_mapping_decisions_lookup_idx` ON `account_mapping_decisions` (`user_id`,`supplier_account_id`,`description_key`);--> statement-breakpoint
CREATE TABLE `supplier_resolution_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`supplier_identity` text NOT NULL,
	`exact_supplier_account_id` text NOT NULL,
	`confidence` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `supplier_resolution_decisions_identity_idx` ON `supplier_resolution_decisions` (`user_id`,`supplier_identity`);--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `supplier_chamber_of_commerce_number` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `supplier_address` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `supplier_country` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `reference_code` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `payment_terms` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `expense_description` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `beneficiary` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `service_start_date` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `service_end_date` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `company_vat_number` text;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `reverse_charge_mentioned` integer;--> statement-breakpoint
ALTER TABLE `extracted_invoice_data` ADD `intra_community_mentioned` integer;--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `purchase_journal_json` text;--> statement-breakpoint
ALTER TABLE `uploaded_invoices` ADD `intelligence_approved_at` integer;