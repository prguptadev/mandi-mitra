ALTER TABLE `purchase_slips` ADD `commission_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_slips` ADD `gaushala_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_slips` ADD `payable_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_slips` ADD `supplier_terms` text;--> statement-breakpoint
UPDATE `purchase_slips` SET `supplier_terms` = '{"commissionPct":1,"gaushalaPerQtl":1.25}' WHERE `supplier_terms` IS NULL;--> statement-breakpoint
UPDATE `purchase_slips` SET
  `commission_paise` = CASE WHEN `rate_paise_per_qtl` > 0 THEN (`amount_paise` + 50) / 100 ELSE 0 END,
  `gaushala_paise` = CASE WHEN `rate_paise_per_qtl` > 0 THEN (`net_grams` * 125 + 50000) / 100000 ELSE 0 END;--> statement-breakpoint
UPDATE `purchase_slips` SET `payable_paise` = `amount_paise` + `commission_paise` + `gaushala_paise`;
