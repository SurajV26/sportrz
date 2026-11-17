-- Privacy-preserving CPC click deduplication across incognito/private windows.
-- Stores only a keyed HMAC fingerprint; raw IP addresses are never persisted.
-- Safe to re-run on MariaDB 10.4+ / MySQL 8.

ALTER TABLE affiliate_clicks
  ADD COLUMN IF NOT EXISTS network_key CHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS risk_reason VARCHAR(80) DEFAULT NULL;

SET @affiliate_click_network_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'affiliate_clicks'
     AND INDEX_NAME = 'uq_affiliate_clicks_network_key'
);
SET @affiliate_click_network_index_sql = IF(
  @affiliate_click_network_index_exists = 0,
  'ALTER TABLE affiliate_clicks ADD UNIQUE KEY uq_affiliate_clicks_network_key (network_key)',
  'SELECT 1'
);
PREPARE affiliate_click_network_index_stmt FROM @affiliate_click_network_index_sql;
EXECUTE affiliate_click_network_index_stmt;
DEALLOCATE PREPARE affiliate_click_network_index_stmt;
