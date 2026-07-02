CREATE TABLE `exact_master_data_caches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`exact_connection_id` text,
	`division_code` text NOT NULL,
	`payload_json` text NOT NULL,
	`last_synced_at` integer NOT NULL,
	`stale_after` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exact_connection_id`) REFERENCES `exact_online_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exact_master_data_caches_user_division_idx` ON `exact_master_data_caches` (`user_id`,`division_code`);--> statement-breakpoint
CREATE INDEX `exact_master_data_caches_freshness_idx` ON `exact_master_data_caches` (`stale_after`);