CREATE TABLE `day_closes` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`day` text NOT NULL,
	`summary` text NOT NULL,
	`note` text,
	`closed_by` text,
	`closed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `day_close_uq` ON `day_closes` (`business_id`,`day`);--> statement-breakpoint
CREATE TABLE `mill_followups` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`note` text,
	`promised_paise` integer,
	`next_date` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mill_followup_mill_idx` ON `mill_followups` (`merchant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mill_followup_biz_idx` ON `mill_followups` (`business_id`,`created_at`);