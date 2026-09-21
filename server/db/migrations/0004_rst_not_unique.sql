DROP INDEX `slip_rst_uq`;--> statement-breakpoint
CREATE INDEX `slip_rst_idx` ON `purchase_slips` (`business_id`,`slip_date`,`rst_no`);