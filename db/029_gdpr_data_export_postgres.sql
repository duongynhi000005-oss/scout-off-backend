-- Migration 029: GDPR data-export jobs (#1330, #1591) (PostgreSQL)
--
-- PostgreSQL counterpart for db/029_gdpr_data_export.sql.
-- Adds asynchronous data-export jobs and single-use download tokens.

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id              BIGSERIAL PRIMARY KEY,
  request_type    TEXT      NOT NULL,  -- 'player' or 'scout'
  requester_id    TEXT      NOT NULL,  -- player_id or scout wallet
  requester_ip    TEXT,
  status          TEXT      NOT NULL DEFAULT 'pending',  -- pending, processing, completed, failed
  archive_path    TEXT,                -- path to stored archive (local volume or object store)
  archive_hash    TEXT,                -- SHA256 of encrypted archive for verification
  error_reason    TEXT,
  created_at      BIGINT    NOT NULL,
  started_at      BIGINT,
  completed_at    BIGINT,
  expires_at      BIGINT               -- archive auto-delete deadline (24-72h)
);

CREATE TABLE IF NOT EXISTS export_download_tokens (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT    NOT NULL REFERENCES data_export_jobs(id) ON DELETE CASCADE,
  token           TEXT      NOT NULL UNIQUE,  -- random single-use token
  used_at         BIGINT,                     -- timestamp of first/only download
  expires_at      BIGINT    NOT NULL,         -- token expiry (short-lived, e.g. 24h)
  created_at      BIGINT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_export_jobs_requester_id ON data_export_jobs (requester_id);
CREATE INDEX IF NOT EXISTS idx_data_export_jobs_status ON data_export_jobs (status);
CREATE INDEX IF NOT EXISTS idx_data_export_jobs_created_at ON data_export_jobs (created_at);
CREATE INDEX IF NOT EXISTS idx_export_download_tokens_token ON export_download_tokens (token);
CREATE INDEX IF NOT EXISTS idx_export_download_tokens_job_id ON export_download_tokens (job_id);
