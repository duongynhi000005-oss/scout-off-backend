# Feature Flags

The ScoutOff backend uses a database-backed runtime feature-flag system (`src/services/featureFlags.ts`) so operators can enable or disable gated surfaces without redeploying or restarting the service.

---

## Defined Flags

Flags are declared in `FeatureFlags` (`src/services/featureFlags.ts`) and seeded by database migrations (`db/010_feature_flags.sql` and `db/020_feature_flags_seed.sql`):

| Flag Name | Constant | Seed / Fallback Default | Gated Feature / Routes | Where Checked | Notes & Caveats |
| --- | --- | --- | --- | --- | --- |
| `saved_searches` | `FeatureFlags.SAVED_SEARCHES` | `true` (`1` in `010_feature_flags.sql`) | Saved scout search CRUD and execution (`POST /api/scouts/:wallet/saved-searches`, `GET /api/scouts/:wallet/saved-searches`, `PUT /api/scouts/:wallet/saved-searches/:searchId`, `DELETE /api/scouts/:wallet/saved-searches/:searchId`, `GET /api/scouts/:wallet/saved-searches/:searchId/run`) | `requireFeatureFlag(FeatureFlags.SAVED_SEARCHES)` middleware in `src/routes/scout.ts` | Returns `404 Feature not available` (`FEATURE_DISABLED`) when disabled. |
| `graphql_enabled` | `FeatureFlags.GRAPHQL_ENABLED` | `false` (`0` in `020_feature_flags_seed.sql` and `FLAG_DEFAULTS`) | GraphQL endpoint (`POST /graphql`) | Synchronous per-request guard `isEnabled(GRAPHQL_ENABLED)` in `src/graphql/index.ts` | Ships disabled by default (#1126). Returns `404` when disabled. |
| `player_tokens` | `FeatureFlags.PLAYER_TOKENS` | `false` (not seeded; falls back to `false`) | Fractionalized player token issuance, purchase, dividends, and holdings (`POST /api/players/:id/tokens/issue`, `POST /api/players/:id/tokens/buy`, `POST /api/players/:id/tokens/dividend`, `GET /api/players/:id/tokens`) | Direct `isFeatureEnabled(FeatureFlags.PLAYER_TOKENS)` check in `src/controllers/playerTokenController.ts` | See **Known Caveats** below regarding `player_tokens` vs `player_tokens_enabled` and missing `await`. |
| `player_tokens_enabled` | `FeatureFlags.PLAYER_TOKENS_ENABLED` | `false` (`0` in `020_feature_flags_seed.sql`) | Intended seed row for the Player Tokens surface | Seeded in `020_feature_flags_seed.sql`, not yet referenced by `playerTokenController.ts` | Tracked separately: `020_feature_flags_seed.sql` seeds `player_tokens_enabled` while `playerTokenController.ts` checks `player_tokens`. |
| `saved_search_alerts_enabled` | `FeatureFlags.SAVED_SEARCH_ALERTS_ENABLED` | `false` (`0` in `020_feature_flags_seed.sql`) | Reserved for automated saved-search match alerts | Seeded in `020_feature_flags_seed.sql` | Currently gates no routes or background jobs (tracked separately). |

---

## Known Caveats

1. **`player_tokens` vs `player_tokens_enabled` naming mismatch**:
   - Migration `020_feature_flags_seed.sql` seeds `player_tokens_enabled`, whereas `src/controllers/playerTokenController.ts` checks `FeatureFlags.PLAYER_TOKENS` (`'player_tokens'`).
   - Additionally, `PUT /api/admin/feature-flags/:name` returns `404` if the flag row does not exist yet in `feature_flags`. To create or toggle `player_tokens` before the naming mismatch is unified, use `PUT /api/admin/feature-flags` (which upserts the row).
2. **`saved_search_alerts_enabled` is a placeholder**:
   - The flag is seeded in `020_feature_flags_seed.sql` and can be toggled via the admin API, but no route or worker currently reads it.

---

## Admin API Usage

All feature-flag endpoints require an authenticated `admin` Bearer JWT (`requireRole('admin')`).

### 1. List all feature flags

`GET /api/admin/feature-flags` clears the in-process async cache and returns all rows from `feature_flags`:

```bash
curl -s http://localhost:4000/api/admin/feature-flags \
  -H "Authorization: Bearer <admin-jwt>"
```

Example response:

```json
{
  "success": true,
  "data": [
    {
      "name": "graphql_enabled",
      "enabled": false,
      "updated_at": 0,
      "updated_by": "system"
    },
    {
      "name": "saved_searches",
      "enabled": true,
      "updated_at": 0,
      "updated_by": "system"
    }
  ]
}
```

### 2. Toggle an existing seeded flag by URL parameter

`PUT /api/admin/feature-flags/:name` updates an existing flag row (returns `404` if `:name` is not yet in `feature_flags`):

```bash
curl -s -X PUT http://localhost:4000/api/admin/feature-flags/graphql_enabled \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### 3. Upsert and toggle any flag by body

`PUT /api/admin/feature-flags` creates or updates a flag row (`INSERT ... ON CONFLICT (name) DO UPDATE`):

```bash
curl -s -X PUT http://localhost:4000/api/admin/feature-flags \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "saved_searches", "enabled": false}'
```

---

## Caching and Propagation

`src/services/featureFlags.ts` maintains two in-process caches:

1. **Asynchronous Cache (`isFeatureEnabled(flagName)`)**:
   - Used by `requireFeatureFlag` middleware (`src/middleware/requireFeatureFlag.ts`).
   - Stores resolved boolean values in an in-memory `Map<string, boolean>` (`cache`) with no time-based expiry.
   - Immediately updated on `setFeatureFlag()` and cleared on `GET /api/admin/feature-flags` (`clearFeatureFlagCache()`).
2. **Synchronous TTL Cache (`isEnabled(key)`)**:
   - Used by the per-request `/graphql` mount guard (`src/graphql/index.ts`), which executes synchronously.
   - Caches values in `syncCache` for `FEATURE_FLAG_CACHE_TTL_MS` (default `5000` ms / 5 seconds) and reads directly from SQLite via `getDb()`, falling back to `FLAG_DEFAULTS` if the database is not initialized or when running on the PostgreSQL driver.

### Multi-Replica Caveat (#658)

Because both caches live in-process and there is no cross-instance pub/sub invalidation:
- On a **single instance**, toggles via `PUT /api/admin/feature-flags` update the async cache immediately and propagate to the sync `/graphql` cache within `FEATURE_FLAG_CACHE_TTL_MS` (default 5s).
- On a **multi-replica deployment**, other replicas will continue serving their cached value in `isFeatureEnabled()` until `GET /api/admin/feature-flags` is called on those replicas or the pods are restarted.

---

## Audit Trail

Every call to `setFeatureFlag(flagName, enabled, updatedBy)` records a tamper-evident audit event via `logAuditEvent` (`src/services/audit.ts`):

- **Action**: `feature_flag_toggled`
- **Metadata (`queryParams`)**:
  - `flag_name`: Name of the toggled flag
  - `old_value`: Previous boolean state (`false` if the row did not exist)
  - `new_value`: New boolean state
  - `admin_wallet`: Authenticated admin Stellar address (or `'unknown'`)
