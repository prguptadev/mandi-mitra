-- the Audit screen's filter lists (records, actions, people) read from this index alone instead of
-- the trail's wide rows; an index only (IF NOT EXISTS): nothing is changed or moved
CREATE INDEX IF NOT EXISTS `audit_facets_idx` ON `audit_log` (`business_id`,`action`,`entity`,`user_id`,`user_name`);
