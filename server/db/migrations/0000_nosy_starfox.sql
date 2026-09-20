CREATE TABLE `adati` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`name_hi` text NOT NULL,
	`name_hinglish` text NOT NULL,
	`name_hinglish_locked` integer DEFAULT false NOT NULL,
	`firm_suffix` text,
	`village` text,
	`village_hi` text,
	`phone` text,
	`account_no` text,
	`ifsc` text,
	`opening_balance_paise` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `adati_biz_idx` ON `adati` (`business_id`);--> statement-breakpoint
CREATE INDEX `adati_hi_idx` ON `adati` (`business_id`,`name_hi`);--> statement-breakpoint
CREATE TABLE `adati_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`adati_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`norm_key` text NOT NULL,
	`source` text DEFAULT 'correction' NOT NULL,
	`hits` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adati_id`) REFERENCES `adati`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alias_biz_raw_uq` ON `adati_aliases` (`business_id`,`raw_text`);--> statement-breakpoint
CREATE INDEX `alias_norm_idx` ON `adati_aliases` (`business_id`,`norm_key`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text,
	`user_id` text,
	`user_name` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`entity_label` text,
	`before` text,
	`after` text,
	`changed_keys` text,
	`ip` text,
	`user_agent` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_biz_idx` ON `audit_log` (`business_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_user_idx` ON `audit_log` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_hi` text,
	`short_code` text NOT NULL,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`district` text,
	`state` text DEFAULT 'Uttar Pradesh',
	`pincode` text,
	`phone` text,
	`gstin` text,
	`mandi_license` text,
	`pan_no` text,
	`logo_path` text,
	`active` integer DEFAULT true NOT NULL,
	`setup_complete` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jins` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_hi` text,
	`crop` text DEFAULT 'paddy' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jins_biz_code_uq` ON `jins` (`business_id`,`code`);--> statement-breakpoint
CREATE TABLE `loads` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`load_date` text NOT NULL,
	`merchant_id` text NOT NULL,
	`po_id` text,
	`jins_id` text NOT NULL,
	`truck_no` text,
	`transporter` text,
	`driver_phone` text,
	`mill_gross_grams` integer,
	`mill_bardana_grams` integer,
	`mill_net_grams` integer,
	`bags` integer,
	`advance_paise` integer DEFAULT 0 NOT NULL,
	`dara_paise` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`jins_id`) REFERENCES `jins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `load_date_idx` ON `loads` (`business_id`,`load_date`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`business_id` text NOT NULL,
	`role_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_uq` ON `memberships` (`user_id`,`business_id`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_hi` text,
	`name_hinglish` text,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`state` text,
	`pincode` text,
	`contact_person` text,
	`phone` text,
	`gstin` text,
	`charge_config` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_biz_code_uq` ON `merchants` (`business_id`,`code`);--> statement-breakpoint
CREATE TABLE `parchas` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`load_id` text NOT NULL,
	`parcha_no` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`snapshot` text NOT NULL,
	`grand_total_paise` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parcha_no_uq` ON `parchas` (`business_id`,`parcha_no`,`version`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`adati_id` text NOT NULL,
	`pay_date` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`mode` text DEFAULT 'cash' NOT NULL,
	`reference` text,
	`notes` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adati_id`) REFERENCES `adati`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payment_adati_idx` ON `payments` (`adati_id`,`pay_date`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`jins_id` text NOT NULL,
	`po_no` text NOT NULL,
	`po_date` text NOT NULL,
	`qty_grams` integer NOT NULL,
	`rate_paise_per_qtl` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`jins_id`) REFERENCES `jins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `po_uq` ON `purchase_orders` (`business_id`,`merchant_id`,`po_no`);--> statement-breakpoint
CREATE TABLE `purchase_slips` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`slip_date` text NOT NULL,
	`rst_no` text NOT NULL,
	`adati_id` text NOT NULL,
	`jins_id` text NOT NULL,
	`merchant_id` text,
	`load_id` text,
	`gross_grams` integer NOT NULL,
	`bags` integer NOT NULL,
	`net_grams` integer NOT NULL,
	`rate_paise_per_qtl` integer NOT NULL,
	`amount_paise` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`scan_batch_id` text,
	`ocr_confidence` real,
	`entered_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adati_id`) REFERENCES `adati`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`jins_id`) REFERENCES `jins`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slip_rst_uq` ON `purchase_slips` (`business_id`,`slip_date`,`rst_no`);--> statement-breakpoint
CREATE INDEX `slip_date_idx` ON `purchase_slips` (`business_id`,`slip_date`);--> statement-breakpoint
CREATE INDEX `slip_load_idx` ON `purchase_slips` (`load_id`);--> statement-breakpoint
CREATE INDEX `slip_adati_idx` ON `purchase_slips` (`adati_id`,`slip_date`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_perm_uq` ON `role_permissions` (`role_id`,`permission`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`label_hi` text,
	`is_system` integer DEFAULT false NOT NULL,
	`rank` integer DEFAULT 100 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_biz_key_uq` ON `roles` (`business_id`,`key`);--> statement-breakpoint
CREATE TABLE `scan_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`source_kind` text DEFAULT 'upload' NOT NULL,
	`file_paths` text NOT NULL,
	`slip_date` text,
	`merchant_id` text,
	`jins_id` text,
	`model` text,
	`raw_response` text,
	`parsed_rows` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_paise` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_text` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`jins_id`) REFERENCES `jins`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scan_biz_idx` ON `scan_batches` (`business_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`active_business_id` text,
	`user_agent` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text,
	`key` text NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_uq` ON `settings` (`business_id`,`key`);--> statement-breakpoint
CREATE TABLE `sync_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`op` text NOT NULL,
	`payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`pushed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `sync_outbox` (`pushed_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_permission_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`membership_id` text NOT NULL,
	`permission` text NOT NULL,
	`effect` text NOT NULL,
	FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upo_uq` ON `user_permission_overrides` (`membership_id`,`permission`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_hi` text,
	`phone` text,
	`pin_hash` text NOT NULL,
	`pin_salt` text NOT NULL,
	`is_root` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`lang` text DEFAULT 'en' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `users_phone_idx` ON `users` (`phone`);