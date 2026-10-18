-- Migration 027: API key per-key rate limits and usage quotas (#1327, #1589) (PostgreSQL)
--
-- PostgreSQL counterpart for db/027_api_key_rate_limits.sql.
-- Adds api_keys.monthly_quota and the api_key_usage monthly rolling usage table.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS monthly_quota INTEGER;

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id        INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  period        TEXT    NOT NULL,  -- YYYY-MM format for monthly rollover
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL,
  PRIMARY KEY (key_id, period)
);

-- Kept for parity with SQLite migration 027_api_key_rate_limits.sql
CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_id ON api_key_usage (key_id);
