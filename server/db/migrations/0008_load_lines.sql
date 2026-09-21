CREATE TABLE `load_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`load_id` text NOT NULL,
	`po_id` text,
	`jins_id` text NOT NULL,
	`stock_date` text NOT NULL,
	`net_grams` integer,
	`rate_paise_per_qtl` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`jins_id`) REFERENCES `jins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `load_line_load_idx` ON `load_lines` (`load_id`);--> statement-breakpoint
CREATE INDEX `load_line_stock_idx` ON `load_lines` (`business_id`,`stock_date`);