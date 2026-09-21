PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_parchas` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`load_id` text NOT NULL,
	`parcha_no` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`invoice_date` text,
	`snapshot` text NOT NULL,
	`grand_total_paise` integer NOT NULL,
	`status` text DEFAULT 'approved' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`voided_by` text,
	`voided_at` integer,
	`void_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_parchas`("id", "business_id", "load_id", "parcha_no", "version", "snapshot", "grand_total_paise", "status", "approved_by", "approved_at", "created_at") SELECT "id", "business_id", "load_id", "parcha_no", "version", "snapshot", "grand_total_paise", "status", "approved_by", "approved_at", "created_at" FROM `parchas`;--> statement-breakpoint
DROP TABLE `parchas`;--> statement-breakpoint
ALTER TABLE `__new_parchas` RENAME TO `parchas`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `parcha_no_uq` ON `parchas` (`business_id`,`parcha_no`,`version`);--> statement-breakpoint
CREATE INDEX `parcha_load_idx` ON `parchas` (`load_id`);--> statement-breakpoint
ALTER TABLE `loads` ADD `katte_count` integer;--> statement-breakpoint
ALTER TABLE `loads` ADD `bore_count` integer;--> statement-breakpoint
ALTER TABLE `loads` ADD `katte_bardana_grams` integer;--> statement-breakpoint
ALTER TABLE `loads` ADD `bore_bardana_grams` integer;--> statement-breakpoint
ALTER TABLE `loads` ADD `invoice_no` text;--> statement-breakpoint
ALTER TABLE `loads` ADD `invoice_date` text;--> statement-breakpoint
ALTER TABLE `loads` ADD `eway_bill_no` text;--> statement-breakpoint
ALTER TABLE `loads` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `load_po_idx` ON `loads` (`po_id`);--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `valid_till` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `created_by` text REFERENCES users(id);