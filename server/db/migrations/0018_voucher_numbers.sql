ALTER TABLE `mill_receipts` ADD `voucher_no` integer;--> statement-breakpoint
CREATE INDEX `mill_receipt_voucher_idx` ON `mill_receipts` (`business_id`,`voucher_no`);--> statement-breakpoint
ALTER TABLE `payments` ADD `voucher_no` integer;--> statement-breakpoint
CREATE INDEX `payment_voucher_idx` ON `payments` (`business_id`,`voucher_no`);--> statement-breakpoint
UPDATE `payments` SET `voucher_no` = (
  SELECT rn FROM (
    SELECT id, row_number() OVER (
      PARTITION BY business_id, CASE WHEN CAST(substr(pay_date, 6, 2) AS INTEGER) >= 4 THEN CAST(substr(pay_date, 1, 4) AS INTEGER) ELSE CAST(substr(pay_date, 1, 4) AS INTEGER) - 1 END
      ORDER BY pay_date, created_at, id) AS rn
    FROM `payments`) AS x WHERE x.id = `payments`.id)
WHERE `voucher_no` IS NULL;--> statement-breakpoint
UPDATE `mill_receipts` SET `voucher_no` = (
  SELECT rn FROM (
    SELECT id, row_number() OVER (
      PARTITION BY business_id, CASE WHEN CAST(substr(receipt_date, 6, 2) AS INTEGER) >= 4 THEN CAST(substr(receipt_date, 1, 4) AS INTEGER) ELSE CAST(substr(receipt_date, 1, 4) AS INTEGER) - 1 END
      ORDER BY receipt_date, created_at, id) AS rn
    FROM `mill_receipts`) AS x WHERE x.id = `mill_receipts`.id)
WHERE `voucher_no` IS NULL;
