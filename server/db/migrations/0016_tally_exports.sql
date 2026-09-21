CREATE TABLE `tally_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`exported_by` text,
	`exported_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tally_export_uq` ON `tally_exports` (`business_id`,`kind`,`entity_id`);