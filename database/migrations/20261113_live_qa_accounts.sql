-- Live/staging QA accounts. Additive only; existing customer rows remain unchanged.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_test_account TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS live_test_login_attempts (
  network_hash CHAR(64) NOT NULL,
  identifier_hash CHAR(64) NOT NULL,
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  blocked_until DATETIME DEFAULT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (network_hash, identifier_hash),
  KEY idx_live_test_login_blocked (blocked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
