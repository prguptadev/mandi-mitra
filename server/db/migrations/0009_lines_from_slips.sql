-- Hand-written. Trucks were first loaded slip by slip; they are now loaded
-- by weight from a purchase day's stock. Each existing truck's slips become
-- one row per commodity and day (a lone row takes the mill's whole net, as
-- the slips did), then the slips are freed. Approved parchas keep their
-- frozen snapshot, so no bill changes.
INSERT INTO `load_lines` (`id`, `business_id`, `load_id`, `po_id`, `jins_id`, `stock_date`, `net_grams`, `rate_paise_per_qtl`, `sort`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), s.business_id, s.load_id, l.po_id, s.jins_id, s.slip_date,
  CASE WHEN (SELECT count(*) FROM (SELECT 1 FROM purchase_slips x WHERE x.load_id = s.load_id GROUP BY x.jins_id, x.slip_date)) = 1
    THEN NULL ELSE sum(s.net_grams) END,
  NULL, 0, CAST(strftime('%s', 'now') AS integer), CAST(strftime('%s', 'now') AS integer)
FROM purchase_slips s JOIN loads l ON l.id = s.load_id
WHERE s.load_id IS NOT NULL
GROUP BY s.load_id, s.jins_id, s.slip_date;--> statement-breakpoint
UPDATE `purchase_slips` SET `load_id` = NULL, `status` = 'open' WHERE `load_id` IS NOT NULL;
