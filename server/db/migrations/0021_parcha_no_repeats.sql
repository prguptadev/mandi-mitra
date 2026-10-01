-- a parcha number may repeat (a warning, never a refusal), and two computers can each give it
-- version 1 before either sees the other: the old unique index kept one of them off the other computer for good
DROP INDEX IF EXISTS `parcha_no_uq`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `parcha_no_idx` ON `parchas` (`business_id`,`parcha_no`);
