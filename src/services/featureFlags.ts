import { getFeatureFlag, getAllFeatureFlags, upsertFeatureFlag } from '../db';
import { logAuditEvent } from './audit';

/** Named feature flags. Add new constants here as features are gated. */
export const FeatureFlags = {
  SAVED_SEARCHES: 'saved_searches',
  /** Fractionalized player-sponsorship via Player Tokens (scaffold stage). */
  PLAYER_TOKENS: 'player_tokens',
  PLAYER_TOKENS_ENABLED: 'player_tokens_enabled',
  SAVED_SEARCH_ALERTS_ENABLED: 'saved_search_alerts_enabled',
  GRAPHQL_ENABLED: 'graphql_enabled',
} as const;

/** Controls whether the /graphql endpoint is served. Off by default (#1126). */
export const GRAPHQL_ENABLED = FeatureFlags.GRAPHQL_ENABLED;

/** Default values used when a flag has no row and the DB is unreachable. */
const FLAG_DEFAULTS: Record<string, boolean> = {
  [FeatureFlags.GRAPHQL_ENABLED]: false,
};

export type FeatureFlagName = (typeof FeatureFlags)[keyof typeof FeatureFlags];

export interface FeatureFlagContext {
  /** Authenticated account (e.g. scout wallet). Reserved for future rollout rules. */
  account?: string;
}

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheTtlMs(): number {
  const ttl = parseInt(process.env.FEATURE_FLAG_CACHE_TTL_MS ?? '5000', 10);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 5000;
}

/** Clear the in-memory cache (used in tests). */
export function clearFeatureFlagCache(): void {
  cache.clear();
}

/** No-op bootstrap kept for backwards compatibility — the feature_flags table
 *  is created and seeded by the SQL migrations (db/010_feature_flags.sql). */
export function bootstrapFeatureFlags(): void {
  /* table + seed rows are owned by the migrations */
}

/**
 * Synchronously read a cached feature flag snapshot without touching getDb().
 * Prefer {@link isFeatureEnabled} on request paths that can await (#1516).
 */
export function isEnabled(key: string): boolean {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  return cached?.value ?? FLAG_DEFAULTS[key] ?? false;
}

/** Flush the flag cache. Used in tests. */
export function clearFlagCache(): void {
  cache.clear();
}

/**
 * Returns whether a named feature flag is enabled.
 * Reads through the driver-agnostic DB helpers (works on SQLite and Postgres)
 * and caches the result in-process with TTL.
 */
export async function isFeatureEnabled(
  flagName: string,
  _context?: FeatureFlagContext,
): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(flagName);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let enabled = FLAG_DEFAULTS[flagName] ?? false;
  try {
    const row = await getFeatureFlag(flagName);
    if (row !== undefined && row !== null) {
      enabled = row.enabled === 1;
    }
  } catch {
    // DB not initialised yet — fall back to defaults without caching failure.
    return enabled;
  }

  cache.set(flagName, { value: enabled, expiresAt: now + cacheTtlMs() });
  return enabled;
}

/** Update a flag at runtime and refresh the in-process cache immediately.
 *  Reads the old value first so it can be written to the audit trail.
 */
export async function setFeatureFlag(
  flagName: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  const oldRow = await getFeatureFlag(flagName);
  const oldValue = oldRow ? oldRow.enabled === 1 : false;

  await upsertFeatureFlag({
    name: flagName,
    enabled: enabled ? 1 : 0,
    updated_at: Date.now(),
    updated_by: updatedBy,
  });
  cache.set(flagName, { value: enabled, expiresAt: Date.now() + cacheTtlMs() });

  await logAuditEvent({
    action: 'feature_flag_toggled',
    timestamp: new Date().toISOString(),
    adminWallet: updatedBy,
    queryParams: {
      flag_name: flagName,
      old_value: oldValue,
      new_value: enabled,
      admin_wallet: updatedBy,
    },
  }).catch(() => {});
}

/** Return all feature flag rows from the DB (bypasses in-process cache). */
export { getAllFeatureFlags };
