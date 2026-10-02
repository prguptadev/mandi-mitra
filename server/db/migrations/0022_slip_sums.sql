-- the sums the screens add up over a whole business (each mill's purchase days, each supplier's
-- account) read from the first two instead of the slips' wide rows, and a scanned sheet finds the
-- slips it put on the list from the third; indexes only: nothing is changed or moved
CREATE INDEX IF NOT EXISTS `slip_day_sums_idx` ON `purchase_slips` (`business_id`,`merchant_id`,`jins_id`,`slip_date`,`rate_paise_per_qtl`,`net_grams`,`gross_grams`,`amount_paise`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slip_supplier_sums_idx` ON `purchase_slips` (`business_id`,`adati_id`,`slip_date`,`rate_paise_per_qtl`,`net_grams`,`amount_paise`,`commission_paise`,`gaushala_paise`,`payable_paise`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slip_scan_idx` ON `purchase_slips` (`scan_batch_id`) WHERE "purchase_slips"."scan_batch_id" is not null;
