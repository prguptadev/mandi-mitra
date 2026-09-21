ALTER TABLE `purchase_slips` ADD `katauti_terms` text;--> statement-breakpoint
CREATE INDEX `slip_mill_date_idx` ON `purchase_slips` (`merchant_id`,`slip_date`);--> statement-breakpoint
CREATE INDEX `load_mill_date_idx` ON `loads` (`merchant_id`,`load_date`);--> statement-breakpoint
CREATE INDEX `membership_biz_idx` ON `memberships` (`business_id`);--> statement-breakpoint
CREATE INDEX `mill_receipt_biz_date_idx` ON `mill_receipts` (`business_id`,`receipt_date`);--> statement-breakpoint
CREATE INDEX `parcha_biz_date_idx` ON `parchas` (`business_id`,`invoice_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `parcha_one_approved_uq` ON `parchas` (`load_id`) WHERE "parchas"."status" = 'approved';--> statement-breakpoint
CREATE INDEX `payment_biz_date_idx` ON `payments` (`business_id`,`pay_date`);--> statement-breakpoint
CREATE INDEX `po_biz_mill_idx` ON `purchase_orders` (`business_id`,`merchant_id`);--> statement-breakpoint
UPDATE `purchase_slips` SET `katauti_terms` = (SELECT json_extract(m.charge_config, '$.katauti') FROM `merchants` m WHERE m.id = `purchase_slips`.`merchant_id`) WHERE `merchant_id` IS NOT NULL AND `katauti_terms` IS NULL;
