ALTER TABLE `uploaded_invoices` ADD `checksum` text;--> statement-breakpoint
CREATE INDEX `uploaded_invoices_duplicate_file_idx` ON `uploaded_invoices` (`file_name`,`file_size`,`checksum`);