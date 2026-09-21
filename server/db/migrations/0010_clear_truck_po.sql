-- Hand-written. POs moved from the truck to its rows (0009); the old
-- truck-level po_id was still set on trucks made before that, where it
-- blocked changing the truck's mill and deleting the PO. Rows keep the PO.
UPDATE `loads` SET `po_id` = NULL WHERE `po_id` IS NOT NULL;
