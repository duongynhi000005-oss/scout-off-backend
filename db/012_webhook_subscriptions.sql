-- Migration 012: webhook subscriptions (#470)
--
-- Each row is a subscriber that receives outbound event webhooks. `secret` is a
-- per-subscriber random string used as the HMAC-SHA256 key when signing outbound
-- payloads (see docs/webhooks.md).

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL UNIQUE,
  secret     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_subscriptions_url ON webhook_subscriptions (url);

