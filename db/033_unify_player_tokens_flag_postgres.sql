-- Migration 033 (Postgres): unify legacy player_tokens feature flag into player_tokens_enabled (#1515)
-- Renames any legacy 'player_tokens' row to 'player_tokens_enabled' or preserves its enabled
-- state if both rows exist, then deletes any leftover 'player_tokens' row.

UPDATE feature_flags
SET enabled = (SELECT enabled FROM feature_flags WHERE name = 'player_tokens'),
    updated_at = (SELECT updated_at FROM feature_flags WHERE name = 'player_tokens'),
    updated_by = (SELECT updated_by FROM feature_flags WHERE name = 'player_tokens')
WHERE name = 'player_tokens_enabled'
  AND EXISTS (SELECT 1 FROM feature_flags WHERE name = 'player_tokens' AND enabled = 1);

UPDATE feature_flags
SET name = 'player_tokens_enabled'
WHERE name = 'player_tokens'
  AND NOT EXISTS (SELECT 1 FROM feature_flags WHERE name = 'player_tokens_enabled');

DELETE FROM feature_flags WHERE name = 'player_tokens';
