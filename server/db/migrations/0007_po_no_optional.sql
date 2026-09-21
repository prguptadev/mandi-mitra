-- Hand-written: drizzle-kit proposed rebuilding purchase_orders, which SQLite
-- refuses inside the migration transaction once loads point at it. Only the
-- uniqueness rule changes: a PO number, when given, is unique per mill;
-- POs without one ('') are told apart by their date.
DROP INDEX `po_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `po_uq` ON `purchase_orders` (`business_id`,`merchant_id`,`po_no`) WHERE "purchase_orders"."po_no" <> '';
