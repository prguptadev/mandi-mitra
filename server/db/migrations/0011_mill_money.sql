CREATE TABLE `mill_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`load_id` text,
	`receipt_date` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`deduction_paise` integer DEFAULT 0 NOT NULL,
	`deduction_note` text,
	`mode` text DEFAULT 'bank' NOT NULL,
	`reference` text,
	`notes` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`voided_at` integer,
	`voided_by` text,
	`void_reason` text,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mill_receipt_mill_idx` ON `mill_receipts` (`merchant_id`,`receipt_date`);--> statement-breakpoint
CREATE INDEX `mill_receipt_load_idx` ON `mill_receipts` (`load_id`);--> statement-breakpoint
ALTER TABLE `merchants` ADD `opening_balance_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `voided_at` integer;--> statement-breakpoint
ALTER TABLE `payments` ADD `voided_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `payments` ADD `void_reason` text;